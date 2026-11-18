//! Helper-side ownership of PVE engine processes: one `--pve-engine` child per console and one short-lived
//! child per discovery request, each on a socketpair (fd 3 in the child). Mirrors `rdp::manager`: the helper's
//! single poll loop drives the fds, ids come from the shared allocator, this manager reaps only the pids it
//! owns, and the engine's frames are untrusted (a framing violation closes that one session).
use std::collections::{HashMap, VecDeque};
use std::ffi::CString;
use std::os::fd::RawFd;
use std::time::{Duration, Instant};

use super::protocol::{self as proto, GuestInfo, NodeInfo, ProvisionSteps, PveCommand, PveEvent, Take, UserExtras};
use crate::ids::SessionIds;
use crate::rdp::manager::{lift_fd, parse_status, set_cloexec, set_nonblocking, wait_pid, EngineExit};

/// Pending helper → engine bytes beyond which input is refused.
pub const WRITE_INPUT_SOFT_CAP: usize = 256 * 1024;
/// Engine frames taken per session per loop turn.
pub const MAX_FRAMES_PER_TURN: usize = 16;
/// How long an engine may outlive its socket (or a close request) before it is killed.
const EOF_GRACE: Duration = Duration::from_secs(3);

pub fn engine_argv() -> Vec<CString> {
    vec![CString::new("remote-hub-helper").unwrap(), CString::new("--pve-engine").unwrap()]
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Terminal,
    /// A discovery request: the engine answers once and exits.
    Targets,
    /// An onboarding request (plan or apply): the engine answers once and exits.
    Provision,
}

#[derive(Debug)]
pub enum PveFrame {
    State(String),
    Data { seq: u32, bytes: Vec<u8> },
    Targets { version: Option<String>, nodes: Vec<NodeInfo>, guests: Vec<GuestInfo> },
    Error { code: String, message: String, fingerprint: Option<String>, steps: Option<ProvisionSteps> },
    /// The VNC password of a graphical console (only a vnc session may send it).
    VncPassword(crate::secret::Secret),
    Plan { role: String, user: String, acl: String, user_id: String, role_privs: Option<String>, extras: UserExtras, digest: String },
    /// The new password of the managed user, to be saved before the engine writes anything more.
    NewPassword(crate::secret::Secret),
    Provisioned { steps: ProvisionSteps },
}

#[derive(Debug)]
pub enum EnqueueError {
    UnknownSession,
    Dead,
    Overflow,
}

#[derive(Debug)]
pub struct ClosedReport {
    pub session_id: u32,
    pub kind: Kind,
    pub reason: String,
    pub exit: EngineExit,
    /// The request that asked for the close, if any (it is answered with the report).
    pub close_request: Option<u64>,
    /// The discovery request, when the engine ended without answering it.
    pub unanswered_job: Option<u64>,
}

struct Session {
    kind: Kind,
    engine_pid: Option<libc::pid_t>,
    exit: Option<EngineExit>,
    fd: RawFd,
    read_buf: Vec<u8>,
    write_buf: VecDeque<u8>,
    state: String,
    seq: u32,
    close_reason: Option<String>,
    ended_at: Option<Instant>,
    reported_closed: bool,
    job_request: Option<u64>,
    close_request: Option<u64>,
    /// Where the password a provision creates goes: the Keychain reference and what it is bound to.
    job_save: Vec<(String, crate::binding::Bind)>,
    /// A graphical (RFB) console: its bytes are an opaque stream and it may announce a VNC password.
    vnc: bool,
}

pub struct PveManager {
    sessions: HashMap<u32, Session>,
    ids: SessionIds,
    /// Plan digests an apply has already used: each is accepted once.
    used_digests: std::collections::HashSet<String>,
}

impl Default for PveManager {
    fn default() -> Self {
        Self::new()
    }
}

fn kill_engine(pid: libc::pid_t) {
    unsafe { libc::kill(pid, libc::SIGKILL) };
}

impl PveManager {
    pub fn new() -> Self {
        Self::with_ids(SessionIds::new())
    }

    pub fn with_ids(ids: SessionIds) -> Self {
        PveManager { sessions: HashMap::new(), ids, used_digests: std::collections::HashSet::new() }
    }

    pub fn contains(&self, id: u32) -> bool {
        self.sessions.get(&id).is_some_and(|s| s.kind == Kind::Terminal)
    }

    pub fn count(&self) -> usize {
        self.sessions.len()
    }

    pub fn fds(&self) -> Vec<(u32, RawFd)> {
        self.sessions.iter().filter(|(_, s)| s.fd >= 0).map(|(&id, s)| (id, s.fd)).collect()
    }

    pub fn engine_pid(&self, id: u32) -> Option<libc::pid_t> {
        self.sessions.get(&id).and_then(|s| s.engine_pid)
    }

    pub fn state(&self, id: u32) -> Option<&str> {
        self.sessions.get(&id).map(|s| s.state.as_str())
    }

    pub fn wants_write(&self, id: u32) -> bool {
        self.sessions.get(&id).is_some_and(|s| s.fd >= 0 && !s.write_buf.is_empty())
    }

    pub fn poll_interest(&self, id: u32, room: bool) -> libc::c_short {
        let mut events = 0;
        if room {
            events |= libc::POLLIN;
        }
        if self.wants_write(id) {
            events |= libc::POLLOUT;
        }
        events
    }

    pub fn has_buffered_frame(&self, id: u32) -> bool {
        self.sessions.get(&id).is_some_and(|s| {
            s.fd >= 0 && s.read_buf.len() >= 4 && {
                let len = u32::from_le_bytes([s.read_buf[0], s.read_buf[1], s.read_buf[2], s.read_buf[3]]) as usize;
                len > 0 && len <= proto::MAX_BODY && s.read_buf.len() >= 4 + len
            }
        })
    }

    pub fn handle_poll_events(&mut self, id: u32, revents: libc::c_short) {
        if revents & (libc::POLLHUP | libc::POLLERR | libc::POLLNVAL) != 0 {
            if let Some(s) = self.sessions.get_mut(&id) {
                s.write_buf.clear();
            }
        }
        if revents & libc::POLLOUT != 0 {
            self.write_pending(id);
        }
    }

    /// Spawn the engine and send it the one `Open` frame. The secret travels only over the socketpair.
    fn spawn(&mut self, current_exe: &str, kind: Kind, open: &PveCommand, job_request: Option<u64>) -> Result<(u32, libc::pid_t), String> {
        let id = self.ids.next().ok_or_else(|| "session ids are exhausted".to_string())?;
        let exe = CString::new(current_exe).map_err(|_| "current exe has a NUL byte".to_string())?;
        let argv_c = engine_argv();
        let argv: Vec<*const libc::c_char> = argv_c.iter().map(|a| a.as_ptr()).chain(std::iter::once(std::ptr::null())).collect();
        // An empty environment: the engine must not inherit anything (no proxy variables, no key log files).
        let envp: Vec<*const libc::c_char> = vec![std::ptr::null()];

        let mut fds = [0i32; 2];
        if unsafe { libc::socketpair(libc::AF_UNIX, libc::SOCK_STREAM, 0, fds.as_mut_ptr()) } != 0 {
            return Err("socketpair failed".to_string());
        }
        let (helper_fd, engine_fd) = (fds[0], lift_fd(fds[1])?);
        let devnull = unsafe { libc::open(c"/dev/null".as_ptr(), libc::O_RDWR | libc::O_CLOEXEC) };
        if devnull < 0 {
            unsafe {
                libc::close(helper_fd);
                libc::close(engine_fd);
            }
            return Err("open(/dev/null) failed".to_string());
        }
        let devnull = lift_fd(devnull)?;
        let close_list: Vec<i32> = match crate::sessions::open_fds_above_two() {
            Ok(list) => list.into_iter().filter(|fd| *fd > 3).collect(),
            Err(e) => {
                unsafe {
                    libc::close(helper_fd);
                    libc::close(engine_fd);
                    libc::close(devnull);
                }
                return Err(format!("fd enumeration failed: {e}"));
            }
        };
        crate::threads::assert_single_threaded("pve engine fork");
        let mut old_mask: libc::sigset_t = unsafe { std::mem::zeroed() };
        crate::sessions::block_all_signals(&mut old_mask);
        let pid = unsafe { libc::fork() };
        if pid == 0 {
            crate::sessions::reset_signals_and_unblock();
            unsafe {
                libc::dup2(devnull, 0);
                libc::dup2(devnull, 1);
                libc::dup2(devnull, 2);
                libc::dup2(engine_fd, 3);
                for fd in &close_list {
                    libc::close(*fd);
                }
                libc::execve(exe.as_ptr(), argv.as_ptr(), envp.as_ptr());
                libc::_exit(127);
            }
        }
        crate::sessions::restore_signal_mask(&old_mask);
        unsafe {
            libc::close(engine_fd);
            libc::close(devnull);
        }
        if pid < 0 {
            unsafe { libc::close(helper_fd) };
            return Err("fork failed".to_string());
        }
        set_nonblocking(helper_fd);
        set_cloexec(helper_fd);
        let mut write_buf = VecDeque::new();
        write_buf.extend(proto::encode_control(open));
        self.sessions.insert(
            id,
            Session {
                kind,
                engine_pid: Some(pid),
                exit: None,
                fd: helper_fd,
                read_buf: Vec::new(),
                write_buf,
                state: "connecting".to_string(),
                seq: 0,
                close_reason: None,
                ended_at: None,
                reported_closed: false,
                job_request,
                close_request: None,
                job_save: Vec::new(),
                vnc: false,
            },
        );
        Ok((id, pid))
    }

    pub fn open_terminal(&mut self, current_exe: &str, open: &PveCommand, vnc: bool) -> Result<(u32, libc::pid_t), String> {
        let (id, pid) = self.spawn(current_exe, Kind::Terminal, open, None)?;
        if let Some(s) = self.sessions.get_mut(&id) {
            s.vnc = vnc;
        }
        Ok((id, pid))
    }

    pub fn is_vnc(&self, id: u32) -> bool {
        self.sessions.get(&id).is_some_and(|s| s.vnc)
    }

    pub fn open_targets(&mut self, current_exe: &str, open: &PveCommand, request_id: u64) -> Result<(u32, libc::pid_t), String> {
        self.spawn(current_exe, Kind::Targets, open, Some(request_id))
    }

    /// True the first time a digest is presented, false for every later time.
    pub fn consume_digest(&mut self, digest: &str) -> bool {
        self.used_digests.insert(digest.to_string())
    }

    /// Queue one command for a session's engine.
    pub fn send_command(&mut self, id: u32, cmd: &PveCommand) -> Result<(), EnqueueError> {
        let s = self.sessions.get_mut(&id).ok_or(EnqueueError::UnknownSession)?;
        if s.fd < 0 {
            return Err(EnqueueError::Dead);
        }
        s.write_buf.extend(proto::encode_control(cmd));
        Ok(())
    }

    pub fn open_provision(&mut self, current_exe: &str, open: &PveCommand, request_id: u64, save: Vec<(String, crate::binding::Bind)>) -> Result<(u32, libc::pid_t), String> {
        let (id, pid) = self.spawn(current_exe, Kind::Provision, open, Some(request_id))?;
        if let Some(s) = self.sessions.get_mut(&id) {
            s.job_save = save;
        }
        Ok((id, pid))
    }

    /// Where the new password of a provision job is saved (every credential bound to that endpoint and user).
    pub fn job_save(&self, id: u32) -> Vec<(String, crate::binding::Bind)> {
        self.sessions.get(&id).map(|s| s.job_save.clone()).unwrap_or_default()
    }

    pub fn enqueue_input(&mut self, id: u32, bytes: &[u8]) -> Result<(), EnqueueError> {
        let s = self.sessions.get_mut(&id).filter(|s| s.kind == Kind::Terminal).ok_or(EnqueueError::UnknownSession)?;
        if s.fd < 0 || s.close_request.is_some() {
            return Err(EnqueueError::Dead);
        }
        if s.write_buf.len() > WRITE_INPUT_SOFT_CAP {
            return Err(EnqueueError::Overflow);
        }
        for chunk in bytes.chunks(64 * 1024) {
            s.write_buf.extend(proto::encode_data(chunk));
        }
        Ok(())
    }

    pub fn resize(&mut self, id: u32, cols: u16, rows: u16) -> Result<(), EnqueueError> {
        let s = self.sessions.get_mut(&id).filter(|s| s.kind == Kind::Terminal).ok_or(EnqueueError::UnknownSession)?;
        if s.fd < 0 {
            return Err(EnqueueError::Dead);
        }
        s.write_buf.extend(proto::encode_control(&PveCommand::Resize { cols, rows }));
        Ok(())
    }

    /// Ask the engine to close the console. The report (with this request id) comes once it has; an engine that
    /// does not end within `EOF_GRACE` is killed by `reap`.
    pub fn request_close(&mut self, id: u32, request: u64) -> Result<(), EnqueueError> {
        let s = self.sessions.get_mut(&id).filter(|s| s.kind == Kind::Terminal).ok_or(EnqueueError::UnknownSession)?;
        if s.close_request.is_some() {
            return Err(EnqueueError::UnknownSession);
        }
        s.close_request = Some(request);
        s.ended_at.get_or_insert_with(Instant::now);
        if s.fd >= 0 {
            s.write_buf.extend(proto::encode_control(&PveCommand::Close));
        }
        Ok(())
    }

    pub fn write_pending(&mut self, id: u32) {
        let Some(s) = self.sessions.get_mut(&id) else { return };
        while s.fd >= 0 && !s.write_buf.is_empty() {
            let (a, b) = s.write_buf.as_slices();
            let buf = if !a.is_empty() { a } else { b };
            let n = unsafe { libc::write(s.fd, buf.as_ptr() as *const libc::c_void, buf.len()) };
            if n < 0 {
                let errno = std::io::Error::last_os_error().raw_os_error().unwrap_or(0);
                if errno == libc::EAGAIN || errno == libc::EINTR {
                    return;
                }
                // The engine is gone: leave the end of the session to the read path.
                s.write_buf.clear();
                return;
            }
            s.write_buf.drain(..n as usize);
        }
    }

    fn set_reason(s: &mut Session, reason: &str) {
        if s.close_reason.is_none() {
            s.close_reason = Some(reason.to_string());
        }
    }

    fn close_transport(s: &mut Session) {
        if s.fd >= 0 {
            unsafe { libc::close(s.fd) };
            s.fd = -1;
        }
        s.write_buf.clear();
        s.read_buf.clear();
    }

    fn fail_protocol(s: &mut Session) {
        Self::set_reason(s, "protocol_error");
        s.ended_at.get_or_insert_with(Instant::now);
        if let Some(pid) = s.engine_pid {
            kill_engine(pid);
        }
        Self::close_transport(s);
    }

    fn on_eof(s: &mut Session) {
        s.ended_at.get_or_insert_with(Instant::now);
        Self::close_transport(s);
        if s.engine_pid.is_none() {
            Self::set_reason(s, "engine_exited");
        }
    }

    /// Read and parse engine frames, at most `budget_bytes` of them and `MAX_FRAMES_PER_TURN` frames.
    pub fn process_readable(&mut self, id: u32, budget_bytes: usize) -> Vec<PveFrame> {
        let mut out = Vec::new();
        let Some(s) = self.sessions.get_mut(&id) else { return out };
        let (mut used, mut frames) = (0usize, 0usize);
        while s.fd >= 0 && frames < MAX_FRAMES_PER_TURN && used < budget_bytes {
            match proto::take_frame(&mut s.read_buf) {
                Take::Frame(body) => {
                    frames += 1;
                    used += body.len();
                    if body[0] == proto::FRAME_DATA {
                        if s.kind != Kind::Terminal {
                            Self::fail_protocol(s);
                            break;
                        }
                        let seq = s.seq;
                        s.seq = s.seq.wrapping_add(1);
                        out.push(PveFrame::Data { seq, bytes: body[1..].to_vec() });
                        continue;
                    }
                    if body[0] != proto::FRAME_CONTROL {
                        Self::fail_protocol(s);
                        break;
                    }
                    match serde_json::from_slice::<PveEvent>(&body[1..]) {
                        Ok(PveEvent::State { state }) => {
                            s.state = state.clone();
                            out.push(PveFrame::State(state));
                        }
                        Ok(PveEvent::Closed { reason }) => {
                            Self::set_reason(s, &reason);
                            s.ended_at.get_or_insert_with(Instant::now);
                        }
                        Ok(PveEvent::Targets { version, nodes, guests }) => {
                            if s.kind != Kind::Targets || s.job_request.is_none() {
                                Self::fail_protocol(s);
                                break;
                            }
                            out.push(PveFrame::Targets { version, nodes, guests });
                        }
                        Ok(PveEvent::VncPassword { password }) => {
                            if !s.vnc {
                                Self::fail_protocol(s);
                                break;
                            }
                            out.push(PveFrame::VncPassword(password));
                        }
                        Ok(PveEvent::Plan { role, user, acl, user_id, role_privs, extras, digest }) => {
                            if s.kind != Kind::Provision || s.job_request.is_none() {
                                Self::fail_protocol(s);
                                break;
                            }
                            out.push(PveFrame::Plan { role, user, acl, user_id, role_privs, extras, digest });
                        }
                        Ok(PveEvent::NewPassword { password }) => {
                            if s.kind != Kind::Provision || s.job_request.is_none() {
                                Self::fail_protocol(s);
                                break;
                            }
                            out.push(PveFrame::NewPassword(password));
                        }
                        Ok(PveEvent::Provisioned { steps }) => {
                            if s.kind != Kind::Provision || s.job_request.is_none() {
                                Self::fail_protocol(s);
                                break;
                            }
                            out.push(PveFrame::Provisioned { steps });
                        }
                        Ok(PveEvent::Error { code, message, fingerprint, steps }) => {
                            out.push(PveFrame::Error { code, message, fingerprint, steps });
                        }
                        Err(_) => {
                            Self::fail_protocol(s);
                            break;
                        }
                    }
                    continue;
                }
                Take::Violation => {
                    Self::fail_protocol(s);
                    break;
                }
                Take::Incomplete => {}
            }
            let mut chunk = [0u8; 65536];
            let n = unsafe { libc::read(s.fd, chunk.as_mut_ptr() as *mut libc::c_void, chunk.len()) };
            if n < 0 {
                let errno = std::io::Error::last_os_error().raw_os_error().unwrap_or(0);
                if errno == libc::EAGAIN || errno == libc::EINTR {
                    break;
                }
                Self::on_eof(s);
                break;
            }
            if n == 0 {
                Self::on_eof(s);
                break;
            }
            s.read_buf.extend_from_slice(&chunk[..n as usize]);
        }
        out
    }

    /// Reap the engines this manager owns; kill one that outlived its socket or a close request by `EOF_GRACE`.
    pub fn reap(&mut self) {
        for s in self.sessions.values_mut() {
            let Some(pid) = s.engine_pid else {
                if s.fd >= 0 && s.ended_at.is_some_and(|t| t.elapsed() >= EOF_GRACE) {
                    Self::on_eof(s);
                }
                continue;
            };
            let mut status: libc::c_int = 0;
            let mut r = unsafe { libc::waitpid(pid, &mut status, libc::WNOHANG) };
            if r != pid && s.ended_at.is_some_and(|t| t.elapsed() >= EOF_GRACE) {
                kill_engine(pid);
                match wait_pid(pid) {
                    Some(st) => {
                        status = st;
                        r = pid;
                    }
                    None => {
                        s.engine_pid = None;
                        continue;
                    }
                }
            }
            if r != pid {
                continue;
            }
            s.engine_pid = None;
            s.exit = Some(parse_status(status));
            if s.fd >= 0 {
                s.ended_at.get_or_insert_with(Instant::now);
            } else {
                Self::set_reason(s, "engine_exited");
            }
        }
    }

    fn take_closed(&mut self, id: u32) -> Option<ClosedReport> {
        let s = self.sessions.get_mut(&id)?;
        if s.reported_closed || s.engine_pid.is_some() || s.fd >= 0 {
            return None;
        }
        let reason = s.close_reason.clone().unwrap_or_else(|| "engine_exited".to_string());
        s.reported_closed = true;
        Some(ClosedReport {
            session_id: id,
            kind: s.kind,
            reason,
            exit: s.exit.unwrap_or_default(),
            close_request: s.close_request,
            unanswered_job: s.job_request,
        })
    }

    /// Reports for sessions that have ended (engine reaped and socket closed); each session is removed once reported.
    pub fn take_all_closed(&mut self) -> Vec<ClosedReport> {
        let ids: Vec<u32> = self.sessions.keys().copied().collect();
        let reports: Vec<ClosedReport> = ids.into_iter().filter_map(|id| self.take_closed(id)).collect();
        for r in &reports {
            self.sessions.remove(&r.session_id);
        }
        reports
    }

    /// A discovery request has been answered; the engine exits by itself.
    pub fn mark_job_answered(&mut self, id: u32) {
        if let Some(s) = self.sessions.get_mut(&id) {
            s.job_request = None;
        }
    }

    pub fn job_request(&self, id: u32) -> Option<u64> {
        self.sessions.get(&id).and_then(|s| s.job_request)
    }

    pub fn terminate_all(&mut self) {
        let ids: Vec<u32> = self.sessions.keys().copied().collect();
        for id in ids {
            if let Some(mut s) = self.sessions.remove(&id) {
                if let Some(pid) = s.engine_pid.take() {
                    let mut status: libc::c_int = 0;
                    if unsafe { libc::waitpid(pid, &mut status, libc::WNOHANG) } != pid {
                        kill_engine(pid);
                        wait_pid(pid);
                    }
                }
                Self::close_transport(&mut s);
            }
        }
    }
}
