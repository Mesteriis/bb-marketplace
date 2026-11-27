//! SFTP channels: one `ssh -s sftp` child per channel, with NO pty.
//!
//! The helper only starts the program (a strictly validated `/usr/bin/ssh` in a production build) and relays bytes: what
//! the client sends goes to the child's stdin, what the child writes on stdout goes back as stream frames. The SFTP
//! protocol itself is spoken by the client. Nothing is dropped silently: input the child does not take is queued up to
//! `INPUT_CAP` and a channel that passes it is closed; stdout is read only while the caller has room for it, so a slow
//! reader slows the server down instead of growing memory. The head of stderr is kept for the reason a channel ended. A
//! channel ends by exit or by `close`; its process group is then terminated (TERM, KILL after a grace period) and reaped
//! by pid.
use std::collections::{HashMap, VecDeque};
use std::io::{Read, Write};
use std::os::fd::{AsRawFd, RawFd};
use std::os::unix::process::{CommandExt, ExitStatusExt};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::time::{Duration, Instant};

/// Channels that may be open at once.
pub const MAX_CHANNELS: usize = 16;
/// Bytes that may wait for one child's stdin.
pub const INPUT_CAP: usize = 8 * 1024 * 1024;
/// Bytes of stderr kept (the head).
const STDERR_KEEP: usize = 4096;
/// Most bytes in one stream frame.
pub const READ_CHUNK: usize = 64 * 1024;
/// How long a terminated channel may take to die before it is killed, and how long a dead child's pipes are waited for.
const KILL_GRACE: Duration = Duration::from_secs(2);

pub struct SftpSpec {
    pub program: String,
    pub argv: Vec<String>,
    pub env: Vec<(String, String)>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum SftpError {
    TooMany,
    Spawn(i32),
}

struct Channel {
    child: Child,
    stdin: Option<ChildStdin>,
    input: VecDeque<u8>,
    out_eof: bool,
    err_eof: bool,
    stderr: Vec<u8>,
    seq: u32,
    /// Why the channel is being stopped (closed, input_overflow) and when TERM was sent.
    stopping: Option<(&'static str, Instant)>,
    killed: bool,
    exited: Option<(Option<i32>, Option<i32>, Instant)>,
    refused: Option<String>,
}

/// Bytes a channel's server wrote.
pub struct Output {
    pub id: u32,
    pub seq: u32,
    pub data: Vec<u8>,
}

/// A channel that ended during `pump`; it is gone from the manager.
#[derive(Debug)]
pub struct Closed {
    pub id: u32,
    pub exit_code: Option<i32>,
    pub signal: Option<i32>,
    pub reason: String,
    pub refused: Option<String>,
    /// The head of what the program wrote on stderr, for the caller to classify (never shown to another plugin).
    pub stderr: String,
}

#[derive(Default)]
pub struct SftpManager {
    channels: HashMap<u32, Channel>,
}

fn set_nonblocking(fd: i32) {
    unsafe {
        let flags = libc::fcntl(fd, libc::F_GETFL);
        libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK);
    }
}

impl SftpManager {
    pub fn new() -> SftpManager {
        SftpManager::default()
    }

    pub fn live(&self) -> usize {
        self.channels.len()
    }

    pub fn contains(&self, id: u32) -> bool {
        self.channels.contains_key(&id)
    }

    pub fn pid(&self, id: u32) -> Option<i32> {
        self.channels.get(&id).map(|c| c.child.id() as i32)
    }

    /// Starts a channel under the id the caller drew from the shared session-id allocator.
    pub fn start(&mut self, id: u32, spec: SftpSpec) -> Result<(), SftpError> {
        if self.channels.len() >= MAX_CHANNELS {
            return Err(SftpError::TooMany);
        }
        let mut command = Command::new(&spec.program);
        command.arg0(spec.argv.first().map(String::as_str).unwrap_or("ssh"));
        command.args(spec.argv.iter().skip(1));
        command.env_clear();
        command.envs(spec.env.iter().map(|(k, v)| (k.as_str(), v.as_str())));
        command.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
        command.process_group(0);
        // Every descriptor the helper owns is close-on-exec and the three standard ones are replaced above, so the child
        // inherits nothing (see exec.rs).
        let mut child = command.spawn().map_err(|e| SftpError::Spawn(e.raw_os_error().unwrap_or(0)))?;
        let stdin = child.stdin.take();
        for fd in [stdin.as_ref().map(|s| s.as_raw_fd()), child.stdout.as_ref().map(|s| s.as_raw_fd()), child.stderr.as_ref().map(|s| s.as_raw_fd())].into_iter().flatten() {
            set_nonblocking(fd);
        }
        self.channels.insert(
            id,
            Channel { child, stdin, input: VecDeque::new(), out_eof: false, err_eof: false, stderr: Vec::new(), seq: 0, stopping: None, killed: false, exited: None, refused: None },
        );
        Ok(())
    }

    /// Records that a question ssh asked was refused (host_key, login_prompt) or that the saved credential failed.
    pub fn note_refusal(&mut self, id: u32, kind: String) {
        if let Some(channel) = self.channels.get_mut(&id) {
            channel.refused = Some(kind);
        }
    }

    /// Queues bytes for the child's stdin. False when the channel is unknown. A channel whose queue would pass
    /// `INPUT_CAP` is closed (reason input_overflow): bytes of a protocol stream are never dropped from its middle.
    pub fn write(&mut self, id: u32, data: &[u8]) -> bool {
        let Some(channel) = self.channels.get_mut(&id) else { return false };
        if channel.stopping.is_some() || channel.stdin.is_none() {
            return true;
        }
        if channel.input.len() + data.len() > INPUT_CAP {
            channel.input.clear();
            Self::stop(channel, "input_overflow");
            return true;
        }
        channel.input.extend(data);
        true
    }

    /// Ends a channel. False when it is unknown.
    pub fn close(&mut self, id: u32) -> bool {
        match self.channels.get_mut(&id) {
            Some(channel) => {
                if channel.stopping.is_none() {
                    Self::stop(channel, "closed");
                }
                true
            }
            None => false,
        }
    }

    fn stop(channel: &mut Channel, reason: &'static str) {
        channel.stopping = Some((reason, Instant::now()));
        channel.stdin = None;
        channel.input.clear();
        unsafe {
            libc::kill(-(channel.child.id() as i32), libc::SIGTERM);
        }
    }

    /// The descriptors that can wake the loop: stdout and stderr of every channel (stdout only when the caller has room
    /// to take output), and stdin of the channels with queued input.
    pub fn poll_fds(&self, room: bool) -> Vec<(RawFd, libc::c_short)> {
        let mut fds = Vec::new();
        for channel in self.channels.values() {
            if room && !channel.out_eof {
                if let Some(out) = channel.child.stdout.as_ref() {
                    fds.push((out.as_raw_fd(), libc::POLLIN));
                }
            }
            if !channel.err_eof {
                if let Some(err) = channel.child.stderr.as_ref() {
                    fds.push((err.as_raw_fd(), libc::POLLIN));
                }
            }
            if !channel.input.is_empty() {
                if let Some(stdin) = channel.stdin.as_ref() {
                    fds.push((stdin.as_raw_fd(), libc::POLLOUT));
                }
            }
        }
        fds
    }

    /// Writes queued input, reads at most `budget` bytes of output in all, reaps, and returns what was read and the
    /// channels that ended. A channel is reported closed only after its output has been read to the end.
    pub fn pump(&mut self, mut budget: usize) -> (Vec<Output>, Vec<Closed>) {
        let now = Instant::now();
        let mut outputs = Vec::new();
        let mut closed = Vec::new();
        let mut buf = vec![0u8; READ_CHUNK];
        for (&id, channel) in self.channels.iter_mut() {
            // stdin
            while !channel.input.is_empty() {
                let Some(stdin) = channel.stdin.as_mut() else { break };
                let (head, _) = channel.input.as_slices();
                match stdin.write(head) {
                    Ok(0) => break,
                    Ok(n) => {
                        channel.input.drain(..n);
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => break,
                    Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                    Err(_) => {
                        // The program closed its stdin: it is on its way out; the exit says the rest.
                        channel.stdin = None;
                        channel.input.clear();
                    }
                }
            }
            // stdout, within the budget
            let mut starved = false;
            if let Some(out) = channel.child.stdout.as_mut() {
                while !channel.out_eof {
                    if budget == 0 {
                        starved = true;
                        break;
                    }
                    let want = budget.min(READ_CHUNK);
                    match out.read(&mut buf[..want]) {
                        Ok(0) => channel.out_eof = true,
                        Ok(n) => {
                            budget -= n;
                            outputs.push(Output { id, seq: channel.seq, data: buf[..n].to_vec() });
                            channel.seq = channel.seq.wrapping_add(1);
                        }
                        Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => break,
                        Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                        Err(_) => channel.out_eof = true,
                    }
                }
            } else {
                channel.out_eof = true;
            }
            // stderr: the head is kept, the rest is read and dropped so the program never blocks on it
            if let Some(err) = channel.child.stderr.as_mut() {
                while !channel.err_eof {
                    match err.read(&mut buf) {
                        Ok(0) => channel.err_eof = true,
                        Ok(n) => {
                            let room = STDERR_KEEP.saturating_sub(channel.stderr.len());
                            channel.stderr.extend_from_slice(&buf[..n.min(room)]);
                        }
                        Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => break,
                        Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                        Err(_) => channel.err_eof = true,
                    }
                }
            } else {
                channel.err_eof = true;
            }
            if let Some((_, since)) = channel.stopping {
                if !channel.killed && now.duration_since(since) > KILL_GRACE {
                    channel.killed = true;
                    unsafe {
                        libc::kill(-(channel.child.id() as i32), libc::SIGKILL);
                    }
                }
            }
            if channel.exited.is_none() {
                if let Ok(Some(status)) = channel.child.try_wait() {
                    channel.exited = Some((status.code(), status.signal(), now));
                }
            }
            if let Some((code, signal, at)) = channel.exited {
                let drained = channel.out_eof && channel.err_eof;
                // A grandchild holding a pipe open cannot keep a dead channel alive; output still waiting is read first.
                let abandoned = !starved && now.duration_since(at) > KILL_GRACE;
                if drained || channel.stopping.is_some() || abandoned {
                    let reason = channel.stopping.map(|(r, _)| r.to_string()).unwrap_or_else(|| "exited".to_string());
                    closed.push(Closed { id, exit_code: code, signal, reason, refused: channel.refused.clone(), stderr: String::from_utf8_lossy(&channel.stderr).into_owned() });
                }
            }
        }
        for c in &closed {
            self.channels.remove(&c.id);
        }
        (outputs, closed)
    }

    /// The helper is going away: no channel outlives it.
    pub fn terminate_all(&mut self) {
        for channel in self.channels.values_mut() {
            if channel.exited.is_none() {
                unsafe {
                    libc::kill(-(channel.child.id() as i32), libc::SIGKILL);
                }
                let _ = channel.child.wait();
            }
        }
        self.channels.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sh(script: &str) -> SftpSpec {
        SftpSpec { program: "/bin/sh".into(), argv: vec!["sh".into(), "-c".into(), script.into()], env: vec![("PATH".into(), "/usr/bin:/bin".into())] }
    }

    /// Pumps until the channel closes; returns everything it wrote and how it ended.
    fn run(m: &mut SftpManager, budget: usize, limit: Duration) -> (Vec<u8>, Closed) {
        let deadline = Instant::now() + limit;
        let mut all = Vec::new();
        let mut next_seq: Option<u32> = None;
        while Instant::now() < deadline {
            let (outputs, closed) = m.pump(budget);
            for o in outputs {
                assert_eq!(o.seq, next_seq.unwrap_or(o.seq), "frames of one channel are numbered in order");
                next_seq = Some(o.seq + 1);
                all.extend(o.data);
            }
            if let Some(c) = closed.into_iter().next() {
                return (all, c);
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        panic!("the channel did not close");
    }

    #[test]
    fn bytes_go_in_and_come_back_unchanged_binary_included() {
        let mut m = SftpManager::new();
        m.start(7, sh("cat")).unwrap();
        let sent: Vec<u8> = (0..=255u8).cycle().take(300_000).collect();
        assert!(m.write(7, &sent));
        let deadline = Instant::now() + Duration::from_secs(20);
        let mut got = Vec::new();
        while got.len() < sent.len() {
            assert!(Instant::now() < deadline, "only {} of {} bytes came back", got.len(), sent.len());
            let (outputs, closed) = m.pump(1 << 20);
            assert!(closed.is_empty(), "cat must still be running: {closed:?}");
            got.extend(outputs.into_iter().flat_map(|o| o.data));
            std::thread::sleep(Duration::from_millis(2));
        }
        assert_eq!(got, sent);
        assert!(m.close(7));
        let (_, closed) = run(&mut m, 1 << 20, Duration::from_secs(10));
        assert_eq!((closed.id, closed.reason.as_str()), (7, "closed"));
        assert_eq!(m.live(), 0);
    }

    #[test]
    fn a_program_that_exits_reports_its_code_its_stderr_head_and_all_of_its_output_first() {
        let mut m = SftpManager::new();
        m.start(1, sh("printf abc; echo 'Host key verification failed.' 1>&2; exit 255")).unwrap();
        let (out, closed) = run(&mut m, 1 << 20, Duration::from_secs(10));
        assert_eq!(out, b"abc");
        assert_eq!((closed.exit_code, closed.reason.as_str()), (Some(255), "exited"));
        assert_eq!(closed.stderr, "Host key verification failed.\n");
    }

    #[test]
    fn output_is_read_only_within_the_budget_and_nothing_is_lost_when_room_returns() {
        let mut m = SftpManager::new();
        m.start(1, sh("head -c 500000 /dev/zero | tr '\\0' 'x'")).unwrap();
        std::thread::sleep(Duration::from_millis(300));
        let (outputs, closed) = m.pump(0);
        assert!(outputs.is_empty() && closed.is_empty(), "no room: nothing is read and the channel is not reported closed");
        let (outputs, _) = m.pump(1000);
        assert_eq!(outputs.iter().map(|o| o.data.len()).sum::<usize>(), 1000);
        let (rest, closed) = run(&mut m, 100_000, Duration::from_secs(20));
        assert_eq!(rest.len(), 499_000);
        assert_eq!(closed.reason, "exited");
    }

    #[test]
    fn stderr_beyond_the_kept_head_is_dropped_without_blocking_the_program() {
        let mut m = SftpManager::new();
        m.start(1, sh("head -c 1000000 /dev/zero | tr '\\0' 'e' 1>&2; printf done")).unwrap();
        let (out, closed) = run(&mut m, 1 << 20, Duration::from_secs(20));
        assert_eq!(out, b"done");
        assert_eq!(closed.stderr.len(), STDERR_KEEP);
    }

    #[test]
    fn input_over_the_cap_closes_the_channel_instead_of_dropping_bytes() {
        let mut m = SftpManager::new();
        m.start(1, sh("sleep 30")).unwrap();
        let block = vec![0u8; 1024 * 1024];
        for _ in 0..(INPUT_CAP / block.len()) + 2 {
            assert!(m.write(1, &block));
            // no pump: nothing is taken, the queue only grows
        }
        let (_, closed) = run(&mut m, 1 << 20, Duration::from_secs(10));
        assert_eq!(closed.reason, "input_overflow");
    }

    #[test]
    fn close_kills_a_program_that_ignores_term() {
        let mut m = SftpManager::new();
        m.start(1, sh("trap '' TERM; sleep 30")).unwrap();
        std::thread::sleep(Duration::from_millis(100));
        assert!(m.close(1));
        let started = Instant::now();
        let (_, closed) = run(&mut m, 1 << 20, Duration::from_secs(15));
        assert_eq!(closed.reason, "closed");
        assert!(started.elapsed() < Duration::from_secs(10));
        assert!(!m.close(1), "a closed channel is unknown");
        assert!(!m.write(1, b"x"));
    }

    #[test]
    fn a_program_that_closes_its_stdin_does_not_break_the_helper() {
        let mut m = SftpManager::new();
        m.start(1, sh("exec 0<&-; sleep 0.3; printf bye")).unwrap();
        std::thread::sleep(Duration::from_millis(100));
        assert!(m.write(1, &vec![1u8; 200_000]));
        let (out, closed) = run(&mut m, 1 << 20, Duration::from_secs(10));
        assert_eq!(out, b"bye");
        assert_eq!(closed.reason, "exited");
    }

    #[test]
    fn the_environment_is_exactly_what_the_request_gave_and_no_descriptor_is_inherited() {
        let f = std::fs::File::open("/dev/null").unwrap();
        let fd = f.as_raw_fd();
        let mut m = SftpManager::new();
        let mut spec = sh(&format!("env | sort; (echo x >&{fd}) 2>/dev/null && echo INHERITED || echo CLOSED"));
        spec.env.push(("MARK".into(), "yes".into()));
        m.start(1, spec).unwrap();
        let (out, _) = run(&mut m, 1 << 20, Duration::from_secs(10));
        let text = String::from_utf8(out).unwrap();
        assert!(text.contains("MARK=yes") && text.contains("CLOSED"), "{text}");
        assert!(!text.contains("HOME=") && !text.contains("INHERITED"), "{text}");
    }

    #[test]
    fn too_many_channels_are_refused_and_a_program_that_cannot_start_is_a_spawn_error() {
        let mut m = SftpManager::new();
        for id in 1..=MAX_CHANNELS as u32 {
            m.start(id, sh("sleep 30")).unwrap();
        }
        assert_eq!(m.start(99, sh("true")).err(), Some(SftpError::TooMany));
        m.terminate_all();
        assert_eq!(m.live(), 0);
        let mut spec = sh("true");
        spec.program = "/nonexistent/ssh".into();
        assert!(matches!(m.start(1, spec), Err(SftpError::Spawn(_))));
        assert_eq!(m.live(), 0);
    }
}
