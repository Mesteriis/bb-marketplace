//! One remote command, run with ssh and NO pty (stage 4b-2).
//!
//! The helper starts the program the request names (a strictly validated `/usr/bin/ssh` in a production build) with
//! stdin closed and stdout and stderr on separate pipes, never through a shell. Output is kept apart and bounded: the
//! HEAD of each stream up to `max_bytes` is kept, the rest is counted and dropped (the pipe is still drained, so ssh never
//! blocks). A run ends by exit, timeout, cancel or output flood; the ssh process group is then terminated (TERM, KILL
//! after a grace period) and reaped by pid, never with `waitpid(-1)`. The loop calls `pump` every turn (at most 50 ms
//! apart), so no descriptor of a run is in the poll set.
use std::collections::HashMap;
use std::io::Read;
use std::os::fd::AsRawFd;
use std::os::unix::process::{CommandExt, ExitStatusExt};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

/// Runs that may be live at once, and finished runs kept for reading.
pub const MAX_RUNNING: usize = 16;
pub const MAX_KEPT: usize = 64;
/// More than this on one stream ends the run (a command that floods).
pub const FLOOD_BYTES: u64 = 256 * 1024 * 1024;
/// How long a terminated run may take to die before it is killed.
const KILL_GRACE: Duration = Duration::from_secs(2);
/// Most bytes read from one pipe per turn.
const READ_CHUNK: usize = 64 * 1024;

pub struct ExecSpec {
    pub program: String,
    pub argv: Vec<String>,
    pub env: Vec<(String, String)>,
    pub timeout: Duration,
    pub max_bytes: usize,
}

#[derive(Debug, PartialEq, Eq)]
pub enum ExecError {
    TooMany,
    Spawn(i32),
}

#[derive(Default)]
struct Stream {
    kept: Vec<u8>,
    total: u64,
    eof: bool,
}

impl Stream {
    fn take(&mut self, data: &[u8], cap: usize) {
        self.total += data.len() as u64;
        let room = cap.saturating_sub(self.kept.len());
        self.kept.extend_from_slice(&data[..data.len().min(room)]);
    }
    fn truncated(&self) -> bool {
        self.total > self.kept.len() as u64
    }
}

enum Phase {
    Running,
    Finished { exit_code: Option<i32>, signal: Option<i32>, reason: String },
}

struct Run {
    child: Child,
    started: Instant,
    deadline: Instant,
    max_bytes: usize,
    stdout: Stream,
    stderr: Stream,
    /// Why the run is being stopped (timeout, cancelled, output_flood) and when TERM was sent.
    stopping: Option<(&'static str, Instant)>,
    killed: bool,
    exited: Option<(Option<i32>, Option<i32>)>,
    refused: Option<String>,
    phase: Phase,
    order: u64,
}

/// One slice of a stream.
pub struct Chunk {
    pub start: u64,
    pub end: u64,
    pub data: Vec<u8>,
    pub total: u64,
    pub truncated: bool,
}

pub struct Snapshot {
    pub running: bool,
    pub exit_code: Option<i32>,
    pub signal: Option<i32>,
    pub reason: Option<String>,
    pub refused: Option<String>,
    pub elapsed_ms: u64,
    pub stdout: Chunk,
    pub stderr: Chunk,
}

/// A run that ended during `pump`.
pub struct Finished {
    pub id: u32,
    pub exit_code: Option<i32>,
    pub signal: Option<i32>,
    pub reason: String,
}

#[derive(Default)]
pub struct ExecManager {
    runs: HashMap<u32, Run>,
    counter: u64,
}

fn set_nonblocking(fd: i32) {
    unsafe {
        let flags = libc::fcntl(fd, libc::F_GETFL);
        libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK);
    }
}

impl ExecManager {
    pub fn new() -> ExecManager {
        ExecManager::default()
    }

    pub fn running(&self) -> usize {
        self.runs.values().filter(|r| matches!(r.phase, Phase::Running)).count()
    }

    /// Starts a run under the id the caller drew from the shared session-id allocator.
    pub fn start(&mut self, id: u32, spec: ExecSpec) -> Result<(), ExecError> {
        if self.running() >= MAX_RUNNING {
            return Err(ExecError::TooMany);
        }
        let mut command = Command::new(&spec.program);
        command.arg0(spec.argv.first().map(String::as_str).unwrap_or("ssh"));
        command.args(spec.argv.iter().skip(1));
        command.env_clear();
        command.envs(spec.env.iter().map(|(k, v)| (k.as_str(), v.as_str())));
        command.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
        command.process_group(0);
        // Every descriptor the helper owns is close-on-exec (the askpass socket, the signal pipe, the keychain pipes), and
        // stdin/stdout/stderr are replaced above, so the child inherits nothing. (No pre_exec close loop: it would close the
        // pipe std uses to report a failed exec.)
        let mut child = command.spawn().map_err(|e| ExecError::Spawn(e.raw_os_error().unwrap_or(0)))?;
        if let Some(out) = child.stdout.as_ref() {
            set_nonblocking(out.as_raw_fd());
        }
        if let Some(err) = child.stderr.as_ref() {
            set_nonblocking(err.as_raw_fd());
        }
        self.counter += 1;
        self.runs.insert(
            id,
            Run {
                child,
                started: Instant::now(),
                deadline: Instant::now() + spec.timeout,
                max_bytes: spec.max_bytes,
                stdout: Stream::default(),
                stderr: Stream::default(),
                stopping: None,
                killed: false,
                exited: None,
                refused: None,
                phase: Phase::Running,
                order: self.counter,
            },
        );
        Ok(())
    }

    pub fn pid(&self, id: u32) -> Option<i32> {
        self.runs.get(&id).map(|r| r.child.id() as i32)
    }

    /// Records that a question ssh asked was refused (host_key, login_prompt).
    pub fn note_refusal(&mut self, id: u32, kind: String) {
        if let Some(run) = self.runs.get_mut(&id) {
            run.refused = Some(kind);
        }
    }

    pub fn cancel(&mut self, id: u32) -> bool {
        match self.runs.get_mut(&id) {
            Some(run) if matches!(run.phase, Phase::Running) => {
                if run.stopping.is_none() {
                    Self::stop(run, "cancelled");
                }
                true
            }
            _ => false,
        }
    }

    fn stop(run: &mut Run, reason: &'static str) {
        run.stopping = Some((reason, Instant::now()));
        // The whole group (ssh and anything it started), by the pgid this manager gave it.
        unsafe {
            libc::kill(-(run.child.id() as i32), libc::SIGTERM);
        }
    }

    fn drain(pipe: &mut impl Read, stream: &mut Stream, cap: usize) {
        let mut buf = vec![0u8; READ_CHUNK];
        loop {
            match pipe.read(&mut buf) {
                Ok(0) => {
                    stream.eof = true;
                    return;
                }
                Ok(n) => {
                    stream.take(&buf[..n], cap);
                    if n < READ_CHUNK {
                        return;
                    }
                }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => return,
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(_) => {
                    stream.eof = true;
                    return;
                }
            }
        }
    }

    /// Reads what is waiting, enforces timeout and flood limits, reaps, and returns the runs that ended.
    pub fn pump(&mut self) -> Vec<Finished> {
        let now = Instant::now();
        let mut finished = Vec::new();
        for (&id, run) in self.runs.iter_mut() {
            if !matches!(run.phase, Phase::Running) {
                continue;
            }
            if let Some(out) = run.child.stdout.as_mut() {
                if !run.stdout.eof {
                    Self::drain(out, &mut run.stdout, run.max_bytes);
                }
            }
            if let Some(err) = run.child.stderr.as_mut() {
                if !run.stderr.eof {
                    Self::drain(err, &mut run.stderr, run.max_bytes);
                }
            }
            if run.stopping.is_none() {
                if run.stdout.total > FLOOD_BYTES || run.stderr.total > FLOOD_BYTES {
                    Self::stop(run, "output_flood");
                } else if now >= run.deadline {
                    Self::stop(run, "timeout");
                }
            }
            if let Some((_, since)) = run.stopping {
                if !run.killed && now.duration_since(since) > KILL_GRACE {
                    run.killed = true;
                    unsafe {
                        libc::kill(-(run.child.id() as i32), libc::SIGKILL);
                    }
                }
            }
            if run.exited.is_none() {
                if let Ok(Some(status)) = run.child.try_wait() {
                    run.exited = Some((status.code(), status.signal()));
                }
            }
            // Done when the child is gone and its pipes have been read to the end (or it was stopped: what is left in
            // the pipes after the child died is read once more above, and a grandchild holding a pipe open cannot keep
            // a stopped run alive).
            if let Some((code, signal)) = run.exited {
                let drained = run.stdout.eof && run.stderr.eof;
                if drained || run.stopping.is_some() || now.duration_since(run.started) > run.deadline.duration_since(run.started) + KILL_GRACE {
                    let reason = run.stopping.map(|(r, _)| r.to_string()).unwrap_or_else(|| "exited".to_string());
                    run.phase = Phase::Finished { exit_code: code, signal, reason: reason.clone() };
                    finished.push(Finished { id, exit_code: code, signal, reason });
                }
            }
        }
        self.evict();
        finished
    }

    fn evict(&mut self) {
        let mut done: Vec<(u64, u32)> = self.runs.iter().filter(|(_, r)| matches!(r.phase, Phase::Finished { .. })).map(|(&id, r)| (r.order, id)).collect();
        if done.len() <= MAX_KEPT {
            return;
        }
        done.sort();
        for (_, id) in done.iter().take(done.len() - MAX_KEPT) {
            self.runs.remove(id);
        }
    }

    pub fn refused(&self, id: u32) -> Option<String> {
        self.runs.get(&id).and_then(|r| r.refused.clone())
    }

    pub fn read(&self, id: u32, stdout_from: u64, stderr_from: u64, max: usize) -> Option<Snapshot> {
        let run = self.runs.get(&id)?;
        let slice = |s: &Stream, from: u64| -> Chunk {
            let start = from.min(s.kept.len() as u64);
            let end = (start + max as u64).min(s.kept.len() as u64);
            Chunk { start, end, data: s.kept[start as usize..end as usize].to_vec(), total: s.total, truncated: s.truncated() }
        };
        let (running, exit_code, signal, reason) = match &run.phase {
            Phase::Running => (true, None, None, None),
            Phase::Finished { exit_code, signal, reason } => (false, *exit_code, *signal, Some(reason.clone())),
        };
        Some(Snapshot {
            running,
            exit_code,
            signal,
            reason,
            refused: run.refused.clone(),
            elapsed_ms: run.started.elapsed().as_millis() as u64,
            stdout: slice(&run.stdout, stdout_from),
            stderr: slice(&run.stderr, stderr_from),
        })
    }

    /// Drops a finished run. False when it is unknown or still running.
    pub fn forget(&mut self, id: u32) -> bool {
        match self.runs.get(&id) {
            Some(run) if matches!(run.phase, Phase::Finished { .. }) => {
                self.runs.remove(&id);
                true
            }
            _ => false,
        }
    }

    /// The helper is going away: no run outlives it.
    pub fn terminate_all(&mut self) {
        for run in self.runs.values_mut() {
            if matches!(run.phase, Phase::Running) {
                unsafe {
                    libc::kill(-(run.child.id() as i32), libc::SIGKILL);
                }
                let _ = run.child.wait();
            }
        }
        self.runs.clear();
    }
}

const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/// Standard base64 with padding (output bytes travel in JSON).
pub fn base64(data: &[u8]) -> String {
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let n = (chunk[0] as u32) << 16 | (*chunk.get(1).unwrap_or(&0) as u32) << 8 | *chunk.get(2).unwrap_or(&0) as u32;
        out.push(B64[(n >> 18) as usize & 63] as char);
        out.push(B64[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { B64[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { B64[n as usize & 63] as char } else { '=' });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sh(script: &str, timeout_ms: u64, max_bytes: usize) -> ExecSpec {
        ExecSpec {
            program: "/bin/sh".into(),
            argv: vec!["sh".into(), "-c".into(), script.into()],
            env: vec![("PATH".into(), "/usr/bin:/bin".into())],
            timeout: Duration::from_millis(timeout_ms),
            max_bytes,
        }
    }

    fn run_to_end(m: &mut ExecManager, limit: Duration) -> Vec<Finished> {
        let deadline = Instant::now() + limit;
        let mut all = Vec::new();
        while Instant::now() < deadline {
            all.extend(m.pump());
            if m.running() == 0 {
                return all;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        panic!("run did not end");
    }

    #[test]
    fn base64_matches_the_rfc_vectors() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(b"foobar"), "Zm9vYmFy");
        assert_eq!(base64(&[0xff, 0xfe, 0x00]), "//4A");
    }

    #[test]
    fn stdout_and_stderr_are_kept_apart_with_the_exit_code() {
        let mut m = ExecManager::new();
        m.start(1, sh("echo out; echo err 1>&2; exit 3", 10_000, 1024)).unwrap();
        let done = run_to_end(&mut m, Duration::from_secs(10));
        assert_eq!((done[0].id, done[0].exit_code, done[0].reason.as_str()), (1, Some(3), "exited"));
        let s = m.read(1, 0, 0, 1024).unwrap();
        assert_eq!(s.stdout.data, b"out\n");
        assert_eq!(s.stderr.data, b"err\n");
        assert!(!s.running && !s.stdout.truncated);
    }

    #[test]
    fn stdin_is_closed_so_a_command_that_reads_gets_end_of_file_at_once() {
        let mut m = ExecManager::new();
        m.start(1, sh("cat; echo after", 10_000, 1024)).unwrap();
        run_to_end(&mut m, Duration::from_secs(10));
        assert_eq!(m.read(1, 0, 0, 1024).unwrap().stdout.data, b"after\n");
    }

    #[test]
    fn output_over_the_bound_keeps_the_head_counts_the_rest_and_never_blocks_the_child() {
        let mut m = ExecManager::new();
        m.start(1, sh("head -c 3000000 /dev/zero | tr '\\0' 'x'; echo END 1>&2", 20_000, 1000)).unwrap();
        run_to_end(&mut m, Duration::from_secs(20));
        let s = m.read(1, 0, 0, 5000).unwrap();
        assert_eq!(s.stdout.data.len(), 1000);
        assert_eq!(s.stdout.total, 3_000_000);
        assert!(s.stdout.truncated);
        assert_eq!(s.stderr.data, b"END\n");
    }

    #[test]
    fn binary_output_is_kept_byte_for_byte() {
        let mut m = ExecManager::new();
        m.start(1, sh("printf '\\000\\377\\n\\r\\200'", 10_000, 1024)).unwrap();
        run_to_end(&mut m, Duration::from_secs(10));
        assert_eq!(m.read(1, 0, 0, 1024).unwrap().stdout.data, vec![0u8, 0xff, b'\n', b'\r', 0x80]);
    }

    #[test]
    fn a_timeout_ends_the_run_with_that_reason_and_kills_what_ignores_term() {
        let mut m = ExecManager::new();
        m.start(1, sh("trap '' TERM; sleep 30", 200, 1024)).unwrap();
        let started = Instant::now();
        let done = run_to_end(&mut m, Duration::from_secs(15));
        assert_eq!(done[0].reason, "timeout");
        assert!(started.elapsed() < Duration::from_secs(10), "TERM was ignored; KILL must follow");
    }

    #[test]
    fn cancel_ends_the_run_and_a_second_cancel_is_harmless() {
        let mut m = ExecManager::new();
        m.start(1, sh("sleep 30", 60_000, 1024)).unwrap();
        assert!(m.cancel(1));
        let done = run_to_end(&mut m, Duration::from_secs(10));
        assert_eq!(done[0].reason, "cancelled");
        assert!(!m.cancel(1), "a finished run cannot be cancelled again");
        assert!(!m.cancel(99));
    }

    #[test]
    fn reads_resume_from_an_offset_and_cannot_pass_the_end() {
        let mut m = ExecManager::new();
        m.start(1, sh("printf abcdef", 10_000, 1024)).unwrap();
        run_to_end(&mut m, Duration::from_secs(10));
        let s = m.read(1, 2, 0, 3).unwrap();
        assert_eq!((s.stdout.start, s.stdout.end, s.stdout.data.as_slice()), (2, 5, &b"cde"[..]));
        let past = m.read(1, 100, 0, 3).unwrap();
        assert_eq!((past.stdout.start, past.stdout.end, past.stdout.data.len()), (6, 6, 0));
    }

    #[test]
    fn the_child_inherits_no_descriptor_above_stderr() {
        // Open a descriptor in this process, then see whether the child can use it.
        let f = std::fs::File::open("/dev/null").unwrap();
        let fd = f.as_raw_fd();
        let mut m = ExecManager::new();
        m.start(1, sh(&format!("(echo x >&{fd}) 2>/dev/null && echo INHERITED || echo CLOSED"), 10_000, 1024)).unwrap();
        run_to_end(&mut m, Duration::from_secs(10));
        assert_eq!(m.read(1, 0, 0, 1024).unwrap().stdout.data, b"CLOSED\n");
    }

    #[test]
    fn the_environment_is_exactly_what_the_request_gave() {
        let mut m = ExecManager::new();
        let mut spec = sh("env | sort", 10_000, 4096);
        spec.env.push(("MARK".into(), "yes".into()));
        m.start(1, spec).unwrap();
        run_to_end(&mut m, Duration::from_secs(10));
        let text = String::from_utf8(m.read(1, 0, 0, 4096).unwrap().stdout.data).unwrap();
        assert!(text.contains("MARK=yes") && text.contains("PATH=/usr/bin:/bin"));
        assert!(!text.contains("HOME="), "the helper's own environment must not leak: {text}");
    }

    #[test]
    fn too_many_live_runs_are_refused_and_forget_frees_a_finished_one() {
        let mut m = ExecManager::new();
        for id in 1..=MAX_RUNNING as u32 {
            m.start(id, sh("sleep 30", 60_000, 16)).unwrap();
        }
        assert_eq!(m.start(99, sh("true", 1000, 16)), Err(ExecError::TooMany));
        m.terminate_all();
        let mut m = ExecManager::new();
        m.start(1, sh("true", 10_000, 16)).unwrap();
        run_to_end(&mut m, Duration::from_secs(10));
        assert!(m.forget(1));
        assert!(m.read(1, 0, 0, 1).is_none());
        assert!(!m.forget(1));
    }

    #[test]
    fn a_program_that_cannot_start_is_a_spawn_error_not_a_hung_run() {
        let mut m = ExecManager::new();
        let mut spec = sh("true", 1000, 16);
        spec.program = "/nonexistent/ssh".into();
        let r = m.start(1, spec);
        assert!(matches!(r, Err(ExecError::Spawn(_))), "{r:?}");
        assert_eq!(m.running(), 0);
    }
}
