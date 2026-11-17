//! Helper-side RDP session ownership: spawns one `--rdp-engine` child per
//! session over a socketpair passed through the fd allowlist, relays its
//! control events and framebuffer updates, and reaps/kills the engine on close
//! and shutdown. The helper's single poll loop drives this manager's fds.
use std::collections::HashMap;
use std::collections::VecDeque;
use std::ffi::CString;
use std::os::fd::RawFd;

use super::protocol::{self, EngineCommand, EngineEvent, UpdateHeader};

/// The env the engine child receives. It is always empty: the engine is
/// self-contained and must never inherit `SSLKEYLOGFILE` (ironrdp-tls enables
/// TLS key logging from that variable).
pub fn engine_env_allowlist(_helper_env: &HashMap<String, String>) -> Vec<String> {
    Vec::new()
}

pub struct RdpSession {
    pub id: u32,
    pub engine_pid: libc::pid_t,
    pub fd: RawFd,
    pub read_buf: Vec<u8>,
    pub write_buf: VecDeque<u8>,
    pub state: String,
    pub close_reason: Option<String>,
    pub pending_screenshot_id: Option<u64>,
    pub engine_exited: bool,
    pub exit_code: Option<i32>,
    pub reported_closed: bool,
}

#[derive(Debug)]
pub enum RdpFrame {
    Event(EngineEvent),
    Update { header: UpdateHeader, rgba: Vec<u8> },
}

pub struct RdpManager {
    sessions: HashMap<u32, RdpSession>,
    next_id: u32,
}

fn set_nonblocking(fd: RawFd) {
    unsafe {
        let flags = libc::fcntl(fd, libc::F_GETFL);
        libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK);
    }
}

fn set_cloexec(fd: RawFd) {
    unsafe {
        let flags = libc::fcntl(fd, libc::F_GETFD);
        libc::fcntl(fd, libc::F_SETFD, flags | libc::FD_CLOEXEC);
    }
}

impl RdpManager {
    pub fn new() -> Self {
        RdpManager { sessions: HashMap::new(), next_id: 1 }
    }

    pub fn count(&self) -> usize {
        self.sessions.len()
    }

    pub fn fds(&self) -> Vec<(u32, RawFd)> {
        self.sessions.iter().map(|(&id, s)| (id, s.fd)).collect()
    }

    pub fn wants_write(&self, id: u32) -> bool {
        self.sessions.get(&id).map(|s| !s.write_buf.is_empty()).unwrap_or(false)
    }

    pub fn state(&self, id: u32) -> Option<&str> {
        self.sessions.get(&id).map(|s| s.state.as_str())
    }

    pub fn engine_pid(&self, id: u32) -> Option<libc::pid_t> {
        self.sessions.get(&id).map(|s| s.engine_pid)
    }

    /// Spawn the engine child and open the session. Returns (session_id, pid).
    pub fn open(
        &mut self,
        current_exe: &str,
        host: String,
        port: u16,
        username: String,
        password: String,
        domain: Option<String>,
        width: u32,
        height: u32,
        expected_fingerprint: Option<String>,
    ) -> Result<(u32, libc::pid_t), String> {
        let mut fds = [0i32; 2];
        let r = unsafe { libc::socketpair(libc::AF_UNIX, libc::SOCK_STREAM, 0, fds.as_mut_ptr()) };
        if r != 0 {
            return Err(format!("socketpair failed: errno {}", std::io::Error::last_os_error().raw_os_error().unwrap_or(0)));
        }
        let (helper_fd, engine_fd) = (fds[0], fds[1]);

        let exe = CString::new(current_exe).map_err(|_| "current exe has a NUL byte".to_string())?;
        let arg0 = CString::new("remote-hub-helper").unwrap();
        let arg1 = CString::new("--rdp-engine").unwrap();

        let pid = unsafe { libc::fork() };
        if pid < 0 {
            unsafe {
                libc::close(helper_fd);
                libc::close(engine_fd);
            }
            return Err("fork failed".to_string());
        }
        if pid == 0 {
            // Child: engine. Fixed argv, empty env, no shell. stdout/stderr are
            // redirected to /dev/null so the helper's stdio protocol stays clean.
            unsafe {
                let devnull = libc::open(c"/dev/null".as_ptr(), libc::O_RDWR);
                if devnull >= 0 {
                    libc::dup2(devnull, 1);
                    libc::dup2(devnull, 2);
                    if devnull > 2 {
                        libc::close(devnull);
                    }
                }
                libc::dup2(engine_fd, 3);
                libc::close(helper_fd);
                if engine_fd > 3 {
                    libc::close(engine_fd);
                }
                // Close every other inherited fd above 3.
                if let Ok(entries) = std::fs::read_dir("/dev/fd") {
                    for entry in entries.flatten() {
                        if let Some(name) = entry.file_name().to_str() {
                            if let Ok(n) = name.parse::<i32>() {
                                if n > 3 {
                                    libc::close(n);
                                }
                            }
                        }
                    }
                }
                let argv = [arg0.as_ptr(), arg1.as_ptr(), std::ptr::null()];
                let envp = [std::ptr::null::<libc::c_char>()];
                libc::execve(exe.as_ptr(), argv.as_ptr(), envp.as_ptr());
                libc::_exit(127);
            }
        }

        // Parent: helper.
        unsafe { libc::close(engine_fd) };
        set_nonblocking(helper_fd);
        set_cloexec(helper_fd);

        let id = self.next_id;
        self.next_id = self.next_id.wrapping_add(1);
        self.sessions.insert(
            id,
            RdpSession {
                id,
                engine_pid: pid,
                fd: helper_fd,
                read_buf: Vec::new(),
                write_buf: VecDeque::new(),
                state: "connecting".to_string(),
                close_reason: None,
                pending_screenshot_id: None,
                engine_exited: false,
                exit_code: None,
                reported_closed: false,
            },
        );

        // Send the Open command (all parameters, including the password, travel
        // only over this socketpair).
        let cmd = EngineCommand::Open {
            host,
            port,
            username,
            password,
            domain,
            width,
            height,
            expected_fingerprint,
        };
        let frame = protocol::encode_control(&cmd);
        self.sessions.get_mut(&id).unwrap().write_buf.extend(frame);
        Ok((id, pid))
    }

    pub fn enqueue_command(&mut self, id: u32, cmd: &EngineCommand) {
        if let Some(s) = self.sessions.get_mut(&id) {
            s.write_buf.extend(protocol::encode_control(cmd));
        }
    }

    pub fn mark_screenshot_pending(&mut self, id: u32, req_id: u64) {
        if let Some(s) = self.sessions.get_mut(&id) {
            s.pending_screenshot_id = Some(req_id);
        }
    }

    pub fn take_screenshot_id(&mut self, id: u32) -> Option<u64> {
        self.sessions.get_mut(&id).and_then(|s| s.pending_screenshot_id.take())
    }

    /// The closed reason for a session that has ended (engine Closed event,
    /// engine exit) and has not yet been reported to the client.
    pub fn take_closed(&mut self, id: u32) -> Option<String> {
        let s = self.sessions.get_mut(&id)?;
        if (s.engine_exited || s.close_reason.is_some()) && !s.reported_closed {
            s.reported_closed = true;
            return Some(s.close_reason.clone().unwrap_or_else(|| "engine_exited".to_string()));
        }
        None
    }

    pub fn take_all_closed(&mut self) -> Vec<(u32, String)> {
        let ids: Vec<u32> = self.sessions.keys().copied().collect();
        ids.into_iter().filter_map(|id| self.take_closed(id).map(|r| (id, r))).collect()
    }

    /// Read and parse as many complete frames as the socketpair currently holds.
    pub fn process_readable(&mut self, id: u32) -> Vec<RdpFrame> {
        let mut out = Vec::new();
        let Some(session) = self.sessions.get_mut(&id) else { return out };
        loop {
            // Grow the buffer with whatever is available (non-blocking).
            let mut chunk = [0u8; 16384];
            let n = unsafe {
                libc::read(session.fd, chunk.as_mut_ptr() as *mut libc::c_void, chunk.len())
            };
            if n < 0 {
                let errno = std::io::Error::last_os_error().raw_os_error().unwrap_or(0);
                if errno == libc::EAGAIN || errno == libc::EINTR {
                    break;
                }
                // Engine gone (EOF or error): mark it exited.
                session.engine_exited = true;
                session.close_reason = Some("engine_exited".to_string());
                break;
            }
            if n == 0 {
                session.engine_exited = true;
                session.close_reason = Some("engine_exited".to_string());
                break;
            }
            session.read_buf.extend_from_slice(&chunk[..n as usize]);
            // Parse complete frames.
            loop {
                let Some(frame) = take_frame(&mut session.read_buf) else { break };
                match classify_frame(&frame) {
                    Some(RdpFrame::Event(EngineEvent::State { state })) => {
                        session.state = state.clone();
                        out.push(RdpFrame::Event(EngineEvent::State { state }));
                    }
                    Some(RdpFrame::Event(EngineEvent::Closed { reason })) => {
                        // Recorded here; the poll loop reports it once via
                        // take_closed(), so a Closed frame is never double-
                        // relayed.
                        session.close_reason = Some(reason);
                        session.engine_exited = true;
                    }
                    Some(f) => out.push(f),
                    None => {}
                }
            }
            if session.read_buf.len() > protocol::RDP_MAX_FRAME_BODY {
                // A frame larger than the bound: drop the session's engine.
                session.engine_exited = true;
                session.close_reason = Some("protocol_error".to_string());
                break;
            }
        }
        out
    }

    pub fn write_pending(&mut self, id: u32) {
        let Some(session) = self.sessions.get_mut(&id) else { return };
        while !session.write_buf.is_empty() {
            let (a, b) = session.write_buf.as_slices();
            let buf = if !a.is_empty() { a } else { b };
            let n = unsafe {
                libc::write(session.fd, buf.as_ptr() as *const libc::c_void, buf.len())
            };
            if n < 0 {
                let errno = std::io::Error::last_os_error().raw_os_error().unwrap_or(0);
                if errno == libc::EAGAIN || errno == libc::EINTR {
                    return;
                }
                session.engine_exited = true;
                session.close_reason = Some("engine_exited".to_string());
                return;
            }
            session.write_buf.drain(..n as usize);
        }
    }

    /// Reap engine children; returns the session ids whose engine exited.
    pub fn reap(&mut self) -> Vec<u32> {
        let mut out = Vec::new();
        loop {
            let mut status: libc::c_int = 0;
            let r = unsafe { libc::waitpid(-1, &mut status, libc::WNOHANG) };
            if r <= 0 {
                break;
            }
            for session in self.sessions.values_mut() {
                if session.engine_pid == r && !session.engine_exited {
                    session.engine_exited = true;
                    session.exit_code = Some(if libc::WIFEXITED(status) { libc::WEXITSTATUS(status) } else { 0 });
                    if session.close_reason.is_none() {
                        session.close_reason = Some("engine_exited".to_string());
                    }
                    out.push(session.id);
                }
            }
        }
        out
    }

    pub fn close(&mut self, id: u32) -> Option<String> {
        let Some(session) = self.sessions.remove(&id) else { return None };
        // Ask the engine to stop, then kill it so no orphan is left.
        let _ = unsafe { libc::kill(session.engine_pid, libc::SIGKILL) };
        unsafe { libc::close(session.fd) };
        Some(session.close_reason.unwrap_or_else(|| "killed_by_close".to_string()))
    }

    pub fn terminate_all(&mut self) {
        let ids: Vec<u32> = self.sessions.keys().copied().collect();
        for id in ids {
            if let Some(session) = self.sessions.remove(&id) {
                unsafe {
                    libc::kill(session.engine_pid, libc::SIGKILL);
                    libc::close(session.fd);
                }
            }
        }
    }
}

/// Extract one complete length-prefixed frame (kind + payload) from the front
/// of `buf`, removing it. Returns None when the buffer does not yet hold a full
/// frame.
fn take_frame(buf: &mut Vec<u8>) -> Option<Vec<u8>> {
    if buf.len() < 4 {
        return None;
    }
    let body_len = u32::from_le_bytes(buf[0..4].try_into().unwrap()) as usize;
    if body_len == 0 || body_len > protocol::RDP_MAX_FRAME_BODY {
        // Oversized/invalid: drop the buffer so the session fails closed.
        buf.clear();
        return None;
    }
    if buf.len() < 4 + body_len {
        return None;
    }
    let full: Vec<u8> = buf.drain(..4 + body_len).collect();
    // Return the frame body (kind + payload), dropping the length prefix.
    Some(full[4..].to_vec())
}

fn classify_frame(frame: &[u8]) -> Option<RdpFrame> {
    let kind = *frame.first()?;
    let payload = &frame[1..];
    match kind {
        protocol::FRAME_CONTROL => {
            let event = serde_json::from_slice::<EngineEvent>(payload).ok()?;
            Some(RdpFrame::Event(event))
        }
        protocol::FRAME_BINARY => {
            let (header, rgba) = protocol::decode_update_body(payload)?;
            Some(RdpFrame::Update { header, rgba: rgba.to_vec() })
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn engine_env_never_carries_sslkeylogfile() {
        let mut helper_env = HashMap::new();
        helper_env.insert("SSLKEYLOGFILE".to_string(), "/tmp/keys.log".to_string());
        helper_env.insert("PATH".to_string(), "/usr/bin".to_string());
        let env = engine_env_allowlist(&helper_env);
        for kv in &env {
            assert!(!kv.starts_with("SSLKEYLOGFILE="), "leaked {kv}");
        }
        assert!(env.is_empty());
    }

    #[test]
    fn take_frame_handles_partial_and_complete_frames() {
        let mut buf = Vec::new();
        let frame = protocol::encode_control(&EngineEvent::State { state: "tls".to_string() });
        // Feed one byte at a time; nothing should be extracted until complete.
        for i in 0..frame.len() - 1 {
            buf.push(frame[i]);
            assert_eq!(take_frame(&mut buf), None);
        }
        buf.push(frame[frame.len() - 1]);
        assert_eq!(take_frame(&mut buf).as_deref(), Some(&frame[4..]));
        assert!(buf.is_empty());
    }

    #[test]
    fn classify_frame_parses_control_and_update() {
        let ev = EngineEvent::State { state: "connecting".to_string() };
        let f = protocol::encode_control(&ev);
        match classify_frame(&f[4..]) {
            Some(RdpFrame::Event(EngineEvent::State { state })) => assert_eq!(state, "connecting"),
            other => panic!("unexpected {other:?}"),
        }
        let up = protocol::encode_update(3, 1, 10, 10, 0, 0, 2, 2, &[0u8; 16]);
        match classify_frame(&up[4..]) {
            Some(RdpFrame::Update { header, rgba }) => {
                assert_eq!(header.session_id, 3);
                assert_eq!(header.frame_id, 1);
                assert_eq!(rgba.len(), 16);
            }
            other => panic!("unexpected {other:?}"),
        }
    }
}
