//! Helper-side RDP session ownership: spawns one `--rdp-engine` child per
//! session over a socketpair, relays its control events and framebuffer
//! updates, and reaps/kills the engine on close and shutdown. The helper's
//! single poll loop drives this manager's fds.
//!
//! Ownership rules (stage 2b-1 repair):
//! * every wire session id comes from the allocator shared with the PTY
//!   manager (`crate::ids`), so an id names exactly one session;
//! * this manager reaps only the pids it owns (`waitpid(pid)`); the PTY
//!   manager does the same, so neither steals the other's exit status;
//! * `engine_pid` is `Some` only while the child is unreaped. It is cleared the
//!   moment the child is reaped and is never signalled afterwards;
//! * the engine's frames are untrusted: any framing or header violation closes
//!   that one session with `protocol_error`.
use std::collections::{HashMap, VecDeque};
use std::ffi::CString;
use std::os::fd::RawFd;
use std::time::{Duration, Instant};

use super::cert::fingerprint_matches;
use super::protocol::{self, EngineCommand, EngineEvent, UpdateHeader};
use crate::ids::SessionIds;

/// Pending helper → engine bytes beyond which input is refused (the client
/// retries); small control commands are always accepted.
pub const WRITE_INPUT_SOFT_CAP: usize = 256 * 1024;
/// Screenshot requests that may be outstanding per session.
pub const MAX_PENDING_SCREENSHOTS: usize = 4;
/// At most this many engine frames are taken per session per loop turn.
pub const MAX_FRAMES_PER_TURN: usize = 16;
/// How long an engine may linger after its socket closed before it is killed.
const EOF_GRACE: Duration = Duration::from_secs(2);

/// Every SIGKILL this manager sends to an engine pid (test observation).
#[cfg(any(test, feature = "test-hooks"))]
pub static ENGINE_KILLS: std::sync::Mutex<Vec<libc::pid_t>> = std::sync::Mutex::new(Vec::new());

fn kill_engine(pid: libc::pid_t) {
    #[cfg(any(test, feature = "test-hooks"))]
    {
        ENGINE_KILLS.lock().unwrap().push(pid);
        #[cfg(feature = "test-hooks")]
        eprintln!("helper-signal pid={pid} sig=SIGKILL");
    }
    unsafe { libc::kill(pid, libc::SIGKILL) };
}

/// The env the engine child receives: always empty. The engine is
/// self-contained and must never inherit `SSLKEYLOGFILE` (ironrdp-tls enables
/// TLS key logging from that variable). `open` builds its `envp` from this.
pub fn engine_env() -> Vec<CString> {
    Vec::new()
}

/// The fixed argv of the engine child.
pub fn engine_argv(fake: Option<&str>) -> Vec<CString> {
    let mode = match fake {
        Some(mode) => format!("--rdp-engine-fake={mode}"),
        None => "--rdp-engine".to_string(),
    };
    vec![CString::new("remote-hub-helper").unwrap(), CString::new(mode).unwrap()]
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct EngineExit {
    pub code: Option<i32>,
    pub signal: Option<i32>,
}

/// Block until `pid` is reaped, retrying on EINTR (the helper's SIGCHLD
/// handler is installed without SA_RESTART, so a blocking waitpid is routinely
/// interrupted; giving up there would leave a zombie nobody owns).
fn wait_pid(pid: libc::pid_t) -> Option<libc::c_int> {
    let mut status: libc::c_int = 0;
    loop {
        let r = unsafe { libc::waitpid(pid, &mut status, 0) };
        if r == pid {
            return Some(status);
        }
        if r < 0 && std::io::Error::last_os_error().raw_os_error() == Some(libc::EINTR) {
            continue;
        }
        return None;
    }
}

fn parse_status(status: libc::c_int) -> EngineExit {
    if libc::WIFEXITED(status) {
        EngineExit { code: Some(libc::WEXITSTATUS(status)), signal: None }
    } else if libc::WIFSIGNALED(status) {
        EngineExit { code: None, signal: Some(libc::WTERMSIG(status)) }
    } else {
        EngineExit::default()
    }
}

pub struct RdpSession {
    pub id: u32,
    /// Some while the child is unreaped; cleared on reap and never signalled
    /// afterwards.
    engine_pid: Option<libc::pid_t>,
    exit: Option<EngineExit>,
    /// -1 once the transport is closed (engine gone or session failed).
    fd: RawFd,
    read_buf: Vec<u8>,
    write_buf: VecDeque<u8>,
    state: String,
    desktop_ready: bool,
    close_reason: Option<String>,
    screenshot_ids: VecDeque<u64>,
    /// The newest unsent update acknowledgement; older ones are superseded.
    pending_ack: Option<u64>,
    pending_prompt: Option<String>,
    /// When the engine's transport ended (Closed event or EOF); an engine that
    /// outlives it by EOF_GRACE is killed. The report waits for its exit status.
    ended_at: Option<Instant>,
    reported_closed: bool,
}

#[derive(Debug)]
pub enum RdpFrame {
    Event(EngineEvent),
    Update { header: UpdateHeader, rgba: Vec<u8> },
}

#[derive(Debug, PartialEq, Eq)]
pub enum EnqueueError {
    UnknownSession,
    /// The engine is gone; the session only waits for its close.
    Dead,
    /// Too many pending bytes for the engine; retry later.
    Full,
    /// Too many screenshot requests are already outstanding.
    TooManyScreenshots,
}

#[derive(Debug, PartialEq, Eq)]
pub enum DecisionRefusal {
    UnknownSession,
    NoPendingPrompt,
    /// The decision names a different fingerprint than the prompt presented.
    FingerprintMismatch,
}

/// A session's closure as reported to the client.
#[derive(Debug, PartialEq, Eq)]
pub struct ClosedReport {
    pub session_id: u32,
    pub reason: String,
    pub exit: EngineExit,
}

pub struct RdpManager {
    sessions: HashMap<u32, RdpSession>,
    ids: SessionIds,
    /// A synthetic engine mode (`test-hooks` builds only).
    fake_engine: Option<String>,
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

/// Move `fd` to a descriptor >= 10 (close-on-exec) so the child's dup2 targets
/// 0..3 can never collide with it.
fn lift_fd(fd: RawFd) -> Result<RawFd, String> {
    let lifted = unsafe { libc::fcntl(fd, libc::F_DUPFD_CLOEXEC, 10) };
    unsafe { libc::close(fd) };
    if lifted < 0 {
        return Err("fcntl(F_DUPFD_CLOEXEC) failed".to_string());
    }
    Ok(lifted)
}

enum Take {
    Incomplete,
    Frame(Vec<u8>),
    Violation,
}

/// Extract one complete length-prefixed frame body (kind + payload) from the
/// front of `buf`. A length of 0, a length above the limit for its kind, or an
/// unknown kind is a framing violation: the stream cannot be resynchronised.
fn take_frame(buf: &mut Vec<u8>) -> Take {
    if buf.len() < 4 {
        return Take::Incomplete;
    }
    let body_len = u32::from_le_bytes(buf[0..4].try_into().unwrap()) as usize;
    if body_len == 0 || body_len > protocol::RDP_MAX_CONTROL_BODY {
        return Take::Violation;
    }
    if buf.len() >= 5 {
        match buf[4] {
            protocol::FRAME_CONTROL => {}
            protocol::FRAME_BINARY => {
                if body_len > protocol::RDP_MAX_UPDATE_BODY {
                    return Take::Violation;
                }
            }
            _ => return Take::Violation,
        }
    }
    if buf.len() < 4 + body_len {
        return Take::Incomplete;
    }
    let body = buf[4..4 + body_len].to_vec();
    buf.drain(..4 + body_len);
    Take::Frame(body)
}

fn has_complete_frame(buf: &[u8]) -> bool {
    if buf.len() < 4 {
        return false;
    }
    let body_len = u32::from_le_bytes(buf[0..4].try_into().unwrap()) as usize;
    // A violating length counts as "ready": the next turn must fail it.
    body_len == 0 || body_len > protocol::RDP_MAX_CONTROL_BODY || buf.len() >= 4 + body_len
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
            if !protocol::update_is_valid(&header, rgba.len()) {
                return None;
            }
            Some(RdpFrame::Update { header, rgba: rgba.to_vec() })
        }
        _ => None,
    }
}

impl RdpManager {
    pub fn new() -> Self {
        Self::with_ids(SessionIds::new())
    }

    pub fn with_ids(ids: SessionIds) -> Self {
        // The synthetic engine exists for tests only; a release helper never
        // looks at the variable.
        #[cfg(feature = "test-hooks")]
        let fake_engine = std::env::var("REMOTE_HUB_RDP_FAKE_ENGINE").ok();
        #[cfg(not(feature = "test-hooks"))]
        let fake_engine: Option<String> = None;
        RdpManager { sessions: HashMap::new(), ids, fake_engine }
    }

    pub fn count(&self) -> usize {
        self.sessions.len()
    }

    pub fn contains(&self, id: u32) -> bool {
        self.sessions.contains_key(&id)
    }

    /// The fds to poll: sessions whose transport is still open.
    pub fn fds(&self) -> Vec<(u32, RawFd)> {
        self.sessions.iter().filter(|(_, s)| s.fd >= 0).map(|(&id, s)| (id, s.fd)).collect()
    }

    pub fn wants_write(&self, id: u32) -> bool {
        self.sessions.get(&id).map(|s| s.fd >= 0 && (!s.write_buf.is_empty() || s.pending_ack.is_some())).unwrap_or(false)
    }

    /// True when a complete engine frame is already buffered, so the loop must
    /// not sleep in poll waiting for more bytes.
    pub fn has_buffered_frame(&self, id: u32) -> bool {
        self.sessions.get(&id).map(|s| s.fd >= 0 && has_complete_frame(&s.read_buf)).unwrap_or(false)
    }

    pub fn state(&self, id: u32) -> Option<&str> {
        self.sessions.get(&id).map(|s| s.state.as_str())
    }

    pub fn is_ready(&self, id: u32) -> bool {
        self.sessions.get(&id).map(|s| s.desktop_ready).unwrap_or(false)
    }

    /// The live (unreaped) engine pid, if any.
    pub fn engine_pid(&self, id: u32) -> Option<libc::pid_t> {
        self.sessions.get(&id).and_then(|s| s.engine_pid)
    }

    /// Spawn the engine child and open the session. Returns (session_id, pid).
    #[allow(clippy::too_many_arguments)]
    pub fn open(
        &mut self,
        current_exe: &str,
        host: String,
        port: u16,
        username: String,
        password: crate::secret::Secret,
        domain: Option<String>,
        width: u32,
        height: u32,
        expected_fingerprint: Option<String>,
    ) -> Result<(u32, libc::pid_t), String> {
        let exe = CString::new(current_exe).map_err(|_| "current exe has a NUL byte".to_string())?;
        let argv_c = engine_argv(self.fake_engine.as_deref());
        let argv: Vec<*const libc::c_char> =
            argv_c.iter().map(|a| a.as_ptr()).chain(std::iter::once(std::ptr::null())).collect();
        let envp_c = engine_env();
        let envp: Vec<*const libc::c_char> =
            envp_c.iter().map(|a| a.as_ptr()).chain(std::iter::once(std::ptr::null())).collect();

        let mut fds = [0i32; 2];
        let r = unsafe { libc::socketpair(libc::AF_UNIX, libc::SOCK_STREAM, 0, fds.as_mut_ptr()) };
        if r != 0 {
            return Err(format!("socketpair failed: errno {}", std::io::Error::last_os_error().raw_os_error().unwrap_or(0)));
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

        // Everything the child needs is built BEFORE fork: the child path
        // between fork and exec allocates nothing.
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

        // fork-without-exec work is only sound in a single-threaded process.
        crate::threads::assert_single_threaded("rdp engine fork");
        let mut old_mask: libc::sigset_t = unsafe { std::mem::zeroed() };
        crate::sessions::block_all_signals(&mut old_mask);
        let pid = unsafe { libc::fork() };
        if pid == 0 {
            // Child: only async-signal-safe calls from here to execve.
            crate::sessions::reset_signals_and_unblock();
            unsafe {
                // fds 0, 1 and 2 are /dev/null: the helper's RPC stdin and its
                // stderr never reach the engine; panics go nowhere.
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
        let id = self.adopt(Some(pid), helper_fd);

        // All parameters, including the password, travel only over this
        // socketpair.
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
        self.sessions.get_mut(&id).unwrap().write_buf.extend(protocol::encode_control(&cmd));
        Ok((id, pid))
    }

    /// Register a session around an engine pid (None when no child is owned,
    /// as in tests) and the helper's end of its socket.
    pub(crate) fn adopt(&mut self, pid: Option<libc::pid_t>, fd: RawFd) -> u32 {
        let id = self.ids.next();
        set_nonblocking(fd);
        self.sessions.insert(
            id,
            RdpSession {
                id,
                engine_pid: pid,
                exit: None,
                fd,
                read_buf: Vec::new(),
                write_buf: VecDeque::new(),
                state: "connecting".to_string(),
                desktop_ready: false,
                close_reason: None,
                screenshot_ids: VecDeque::new(),
                pending_ack: None,
                pending_prompt: None,
                ended_at: None,
                reported_closed: false,
            },
        );
        id
    }

    pub fn enqueue_command(&mut self, id: u32, cmd: &EngineCommand) -> Result<(), EnqueueError> {
        let s = self.sessions.get_mut(&id).ok_or(EnqueueError::UnknownSession)?;
        if s.fd < 0 {
            return Err(EnqueueError::Dead);
        }
        // One bound for every command kind that a client can repeat. Decisions
        // and Close are single-shot (a decision needs a pending prompt) and
        // always get through.
        let bounded = matches!(cmd, EngineCommand::Input { .. } | EngineCommand::Ack { .. } | EngineCommand::Screenshot);
        if bounded && s.write_buf.len() > WRITE_INPUT_SOFT_CAP {
            return Err(EnqueueError::Full);
        }
        match cmd {
            EngineCommand::Ack { frame_id } => {
                // Acknowledgements coalesce: only the newest is ever sent.
                s.pending_ack = Some(*frame_id);
                return Ok(());
            }
            EngineCommand::Screenshot if s.screenshot_ids.len() >= MAX_PENDING_SCREENSHOTS => {
                return Err(EnqueueError::TooManyScreenshots);
            }
            _ => {}
        }
        s.write_buf.extend(protocol::encode_control(cmd));
        Ok(())
    }

    /// Check a certificate decision against the prompt that is pending. A
    /// decision naming a different fingerprint is refused and the prompt stays
    /// pending.
    pub fn check_decision(&mut self, id: u32, fingerprint: &str) -> Result<(), DecisionRefusal> {
        let s = self.sessions.get_mut(&id).ok_or(DecisionRefusal::UnknownSession)?;
        let Some(pending) = &s.pending_prompt else { return Err(DecisionRefusal::NoPendingPrompt) };
        if !fingerprint_matches(pending, fingerprint) {
            return Err(DecisionRefusal::FingerprintMismatch);
        }
        s.pending_prompt = None;
        Ok(())
    }

    pub fn push_screenshot(&mut self, id: u32, request_id: u64) {
        if let Some(s) = self.sessions.get_mut(&id) {
            s.screenshot_ids.push_back(request_id);
        }
    }

    pub fn pop_screenshot(&mut self, id: u32) -> Option<u64> {
        self.sessions.get_mut(&id).and_then(|s| s.screenshot_ids.pop_front())
    }

    /// The first terminal reason wins; later ones (EOF after a Closed event,
    /// a reap after either) never overwrite it.
    fn set_reason(s: &mut RdpSession, reason: &str) {
        if s.close_reason.is_none() {
            s.close_reason = Some(reason.to_string());
        }
    }

    /// Stop polling the session: the transport is closed.
    fn close_transport(s: &mut RdpSession) {
        if s.fd >= 0 {
            unsafe { libc::close(s.fd) };
            s.fd = -1;
        }
        s.read_buf.clear();
        s.write_buf.clear();
        s.pending_ack = None;
    }

    fn on_eof(s: &mut RdpSession) {
        Self::set_reason(s, "engine_exited");
        s.ended_at.get_or_insert_with(Instant::now);
        Self::close_transport(s);
    }

    /// Fail one session for a protocol violation by its engine: kill and reap
    /// the engine, stop polling, record `protocol_error`. Nothing else is
    /// affected.
    fn fail_protocol(s: &mut RdpSession) {
        Self::set_reason(s, "protocol_error");
        Self::close_transport(s);
        if let Some(pid) = s.engine_pid.take() {
            let mut status: libc::c_int = 0;
            let r = unsafe { libc::waitpid(pid, &mut status, libc::WNOHANG) };
            if r == pid {
                s.exit = Some(parse_status(status));
            } else {
                kill_engine(pid);
                s.exit = wait_pid(pid).map(parse_status);
            }
        }
    }

    /// The closure to report for a session that has ended and has not been
    /// reported yet. The report waits until the engine is reaped (at most
    /// EOF_GRACE after its transport ended), so the client sees its real exit
    /// code or signal.
    pub fn take_closed(&mut self, id: u32) -> Option<ClosedReport> {
        let s = self.sessions.get_mut(&id)?;
        if s.reported_closed {
            return None;
        }
        let reason = s.close_reason.clone()?;
        if s.engine_pid.is_some() {
            return None;
        }
        s.reported_closed = true;
        Some(ClosedReport { session_id: id, reason, exit: s.exit.unwrap_or_default() })
    }

    pub fn take_all_closed(&mut self) -> Vec<ClosedReport> {
        let ids: Vec<u32> = self.sessions.keys().copied().collect();
        ids.into_iter().filter_map(|id| self.take_closed(id)).collect()
    }

    /// Read and parse engine frames. Stops after `budget_bytes` of output or
    /// `MAX_FRAMES_PER_TURN` frames; whatever is left stays buffered (see
    /// `has_buffered_frame`) and unread bytes stay in the socket, which holds
    /// the engine back.
    pub fn process_readable(&mut self, id: u32, budget_bytes: usize) -> Vec<RdpFrame> {
        let mut out = Vec::new();
        let Some(s) = self.sessions.get_mut(&id) else { return out };
        let mut used = 0usize;
        let mut frames = 0usize;
        while s.fd >= 0 && frames < MAX_FRAMES_PER_TURN && used < budget_bytes {
            match take_frame(&mut s.read_buf) {
                Take::Frame(frame) => {
                    frames += 1;
                    match classify_frame(&frame) {
                        Some(RdpFrame::Event(EngineEvent::State { state })) => {
                            if state != "cert_prompt" {
                                s.pending_prompt = None;
                            }
                            s.state = state.clone();
                            out.push(RdpFrame::Event(EngineEvent::State { state }));
                        }
                        Some(RdpFrame::Event(EngineEvent::Closed { reason })) => {
                            // Recorded once; the poll loop reports it via
                            // take_closed(). The first terminal reason wins,
                            // so a later EOF cannot overwrite it.
                            Self::set_reason(s, &reason);
                            s.ended_at.get_or_insert_with(Instant::now);
                            Self::close_transport(s);
                        }
                        Some(RdpFrame::Event(EngineEvent::Desktop { frame_id, width, height, timestamp })) => {
                            s.desktop_ready = true;
                            out.push(RdpFrame::Event(EngineEvent::Desktop { frame_id, width, height, timestamp }));
                        }
                        Some(RdpFrame::Event(EngineEvent::CertPrompt {
                            host, port, fingerprint, subject, issuer, not_before, not_after, reason, detail,
                        })) => {
                            s.pending_prompt = Some(fingerprint.clone());
                            out.push(RdpFrame::Event(EngineEvent::CertPrompt {
                                host, port, fingerprint, subject, issuer, not_before, not_after, reason, detail,
                            }));
                        }
                        Some(f) => {
                            if let RdpFrame::Update { rgba, .. } = &f {
                                used += rgba.len();
                            }
                            out.push(f);
                        }
                        None => {
                            Self::fail_protocol(s);
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
            // Need more bytes: read a bounded chunk (non-blocking).
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

    pub fn write_pending(&mut self, id: u32) {
        let Some(s) = self.sessions.get_mut(&id) else { return };
        // The coalesced acknowledgement goes out behind everything queued.
        if s.write_buf.is_empty() {
            if let Some(frame_id) = s.pending_ack.take() {
                s.write_buf.extend(protocol::encode_control(&EngineCommand::Ack { frame_id }));
            }
        }
        while s.fd >= 0 && !s.write_buf.is_empty() {
            let (a, b) = s.write_buf.as_slices();
            let buf = if !a.is_empty() { a } else { b };
            let n = unsafe { libc::write(s.fd, buf.as_ptr() as *const libc::c_void, buf.len()) };
            if n < 0 {
                let errno = std::io::Error::last_os_error().raw_os_error().unwrap_or(0);
                if errno == libc::EAGAIN || errno == libc::EINTR {
                    return;
                }
                Self::on_eof(s);
                return;
            }
            s.write_buf.drain(..n as usize);
        }
    }

    /// Reap the engine children this manager owns (by pid, never `-1`), record
    /// their exit status and clear the pid. An engine that outlives its closed
    /// socket by `EOF_GRACE` is killed. Returns the ids whose engine was
    /// reaped by this call.
    pub fn reap(&mut self) -> Vec<u32> {
        let mut out = Vec::new();
        for s in self.sessions.values_mut() {
            let Some(pid) = s.engine_pid else { continue };
            let mut status: libc::c_int = 0;
            let mut r = unsafe { libc::waitpid(pid, &mut status, libc::WNOHANG) };
            if r != pid && s.ended_at.map(|t| t.elapsed() >= EOF_GRACE).unwrap_or(false) {
                kill_engine(pid);
                match wait_pid(pid) {
                    Some(st) => {
                        status = st;
                        r = pid;
                    }
                    None => {
                        // Not our child any more (ECHILD): nothing to reap.
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
            Self::set_reason(s, "engine_exited");
            Self::close_transport(s);
            out.push(s.id);
        }
        out
    }

    /// Tear one engine down for good: reap it if it already exited, otherwise
    /// SIGKILL it and wait. A pid that was already reaped is never signalled.
    fn stop_engine(s: &mut RdpSession) {
        let Some(pid) = s.engine_pid.take() else { return };
        let mut status: libc::c_int = 0;
        let r = unsafe { libc::waitpid(pid, &mut status, libc::WNOHANG) };
        if r == pid {
            s.exit = Some(parse_status(status));
            return;
        }
        kill_engine(pid);
        s.exit = wait_pid(pid).map(parse_status);
    }

    pub fn close(&mut self, id: u32) -> Option<String> {
        let mut s = self.sessions.remove(&id)?;
        Self::stop_engine(&mut s);
        Self::close_transport(&mut s);
        Some(s.close_reason.unwrap_or_else(|| "killed_by_close".to_string()))
    }

    pub fn terminate_all(&mut self) {
        let ids: Vec<u32> = self.sessions.keys().copied().collect();
        for id in ids {
            if let Some(mut s) = self.sessions.remove(&id) {
                Self::stop_engine(&mut s);
                Self::close_transport(&mut s);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rdp::protocol::{encode_control, encode_update};

    /// A socketpair that spawned test children cannot inherit (close-on-exec),
    /// so an EOF is seen as soon as the peer is closed.
    fn socketpair() -> (RawFd, RawFd) {
        let mut fds = [0i32; 2];
        assert_eq!(unsafe { libc::socketpair(libc::AF_UNIX, libc::SOCK_STREAM, 0, fds.as_mut_ptr()) }, 0);
        set_cloexec(fds[0]);
        set_cloexec(fds[1]);
        (fds[0], fds[1])
    }

    fn write_all(fd: RawFd, bytes: &[u8]) {
        let mut off = 0;
        while off < bytes.len() {
            let n = unsafe { libc::write(fd, bytes[off..].as_ptr() as *const libc::c_void, bytes.len() - off) };
            assert!(n > 0, "write failed");
            off += n as usize;
        }
    }

    /// A real, exec'd child that exits with `code`. Never `fork()` without
    /// `exec` in this multi-threaded test binary: the forked child inherits a
    /// single thread and libSystem's half-initialised `os_once` state from
    /// whichever other test thread was mid-initialisation (the connect tests load
    /// the system roots), and macOS kills it with SIGKILL inside `fork()`
    /// ("os_once_t is corrupt ... crashed on child side of fork pre-exec").
    /// The `Child` handle is dropped without waiting: the manager under test
    /// reaps the pid.
    fn spawn_exit(code: i32) -> libc::pid_t {
        let child = std::process::Command::new("/bin/sh")
            .args(["-c", &format!("exit {code}")])
            .spawn()
            .expect("spawn /bin/sh");
        child.id() as libc::pid_t
    }

    /// A real child that stays alive until it is killed.
    fn spawn_sleeper() -> libc::pid_t {
        let child = std::process::Command::new("/bin/sleep").arg("600").spawn().expect("spawn /bin/sleep");
        child.id() as libc::pid_t
    }

    /// Wait until `pid` has exited WITHOUT reaping it (waitid WNOWAIT), so the
    /// test can then observe who reaps it.
    fn wait_until_exited_unreaped(pid: libc::pid_t) {
        let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
        let r = unsafe {
            libc::waitid(libc::P_PID, pid as libc::id_t, &mut info, libc::WEXITED | libc::WNOWAIT)
        };
        assert_eq!(r, 0, "waitid failed: {}", std::io::Error::last_os_error());
    }

    /// Read until the session's transport is closed (event-driven; the loop
    /// limit is a hang guard).
    fn read_until_closed(mgr: &mut RdpManager, id: u32) {
        wait_until(|| {
            let _ = mgr.process_readable(id, usize::MAX);
            mgr.fds().is_empty()
        });
    }

    fn wait_until(mut f: impl FnMut() -> bool) {
        // A hang guard, not a timing assertion: the condition is event-driven.
        for _ in 0..6000 {
            if f() {
                return;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        panic!("condition not reached in 60 s");
    }

    /// The RDP reaper must only reap its own engine pids. The manager owns one
    /// live engine; an UNRELATED child exits and stays a zombie. With
    /// waitpid(-1) the reaper steals it, and the owner's own waitpid fails.
    #[test]
    fn rdp_reap_does_not_steal_unrelated_children() {
        let own = spawn_sleeper();
        let other = spawn_exit(7);
        wait_until_exited_unreaped(other);
        let (a, b) = socketpair();
        let mut mgr = RdpManager::new();
        let id = mgr.adopt(Some(own), a);
        assert!(mgr.reap().is_empty(), "the live engine was reported as exited");
        let mut status: libc::c_int = 0;
        let r = unsafe { libc::waitpid(other, &mut status, libc::WNOHANG) };
        assert_eq!(r, other, "RDP reaper stole an unrelated child");
        assert!(libc::WIFEXITED(status));
        assert_eq!(libc::WEXITSTATUS(status), 7);
        assert_eq!(mgr.close(id).as_deref(), Some("killed_by_close"));
        unsafe { libc::close(b) };
    }

    #[test]
    fn rdp_reap_reports_own_engine_exit_code() {
        let pid = spawn_exit(9);
        let (a, b) = socketpair();
        let mut mgr = RdpManager::new();
        let id = mgr.adopt(Some(pid), a);
        wait_until(|| !mgr.reap().is_empty());
        let report = mgr.take_closed(id).expect("closed after reap");
        assert_eq!(report.reason, "engine_exited");
        assert_eq!(report.exit, EngineExit { code: Some(9), signal: None });
        assert_eq!(mgr.engine_pid(id), None, "pid must be cleared once reaped");
        unsafe { libc::close(b) };
    }

    /// An engine that was reaped is never signalled again: close() after reap
    /// sends no kill to that pid (pid reuse would hit an unrelated process).
    #[test]
    fn close_after_reap_signals_nothing() {
        let pid = spawn_exit(0);
        let (a, b) = socketpair();
        let mut mgr = RdpManager::new();
        let id = mgr.adopt(Some(pid), a);
        wait_until(|| !mgr.reap().is_empty());
        assert_eq!(mgr.close(id).as_deref(), Some("engine_exited"));
        assert!(!ENGINE_KILLS.lock().unwrap().contains(&pid), "a reaped engine pid was signalled");
        unsafe { libc::close(b) };
    }

    /// A live engine is killed on close and waited for (no zombie, no orphan).
    #[test]
    fn close_kills_and_reaps_a_live_engine() {
        let pid = spawn_sleeper();
        let (a, b) = socketpair();
        let mut mgr = RdpManager::new();
        let id = mgr.adopt(Some(pid), a);
        assert_eq!(mgr.close(id).as_deref(), Some("killed_by_close"));
        assert!(ENGINE_KILLS.lock().unwrap().contains(&pid));
        let r = unsafe { libc::waitpid(pid, std::ptr::null_mut(), libc::WNOHANG) };
        assert_eq!(r, -1, "engine must already be reaped (ECHILD)");
        unsafe { libc::close(b) };
    }

    /// A terminal reason recorded from a Closed event survives the socket EOF
    /// that arrives in the same read.
    #[test]
    fn eof_does_not_overwrite_a_recorded_closed_reason() {
        let (a, b) = socketpair();
        let mut mgr = RdpManager::new();
        let id = mgr.adopt(None, a);
        write_all(b, &encode_control(&EngineEvent::Closed { reason: "cert_changed".to_string() }));
        unsafe { libc::close(b) };
        read_until_closed(&mut mgr, id);
        let report = mgr.take_closed(id).expect("closed");
        assert_eq!(report.reason, "cert_changed");
    }

    #[test]
    fn eof_without_a_closed_event_is_engine_exited() {
        let (a, b) = socketpair();
        let mut mgr = RdpManager::new();
        let id = mgr.adopt(None, a);
        unsafe { libc::close(b) };
        read_until_closed(&mut mgr, id);
        assert_eq!(mgr.take_closed(id).expect("closed").reason, "engine_exited");
    }

    /// After the engine's socket closed the fd leaves the poll set.
    #[test]
    fn a_closed_session_leaves_the_poll_set() {
        let (a, b) = socketpair();
        let mut mgr = RdpManager::new();
        let id = mgr.adopt(None, a);
        assert_eq!(mgr.fds().len(), 1);
        unsafe { libc::close(b) };
        read_until_closed(&mut mgr, id);
        assert!(mgr.fds().is_empty(), "closed session still polled");
    }

    fn violation_closes_only_that_session(bytes: Vec<u8>) {
        let (a1, b1) = socketpair();
        let (a2, b2) = socketpair();
        let mut mgr = RdpManager::new();
        let bad = mgr.adopt(None, a1);
        let good = mgr.adopt(None, a2);
        write_all(b1, &bytes);
        write_all(b2, &encode_control(&EngineEvent::State { state: "tls".to_string() }));
        let _ = mgr.process_readable(bad, usize::MAX);
        let frames = mgr.process_readable(good, usize::MAX);
        assert_eq!(mgr.take_closed(bad).expect("closed").reason, "protocol_error");
        assert!(mgr.take_closed(good).is_none());
        assert_eq!(frames.len(), 1, "the other session keeps working");
        assert_eq!(mgr.fds().len(), 1);
        unsafe {
            libc::close(b1);
            libc::close(b2);
        }
    }

    #[test]
    fn zero_length_frame_is_a_protocol_error() {
        violation_closes_only_that_session(vec![0, 0, 0, 0]);
    }

    #[test]
    fn oversized_binary_frame_is_a_protocol_error() {
        // length 1 048 573 (> 1 048 572 allowed for a binary body), kind 0x02
        let mut bytes = (1_048_573u32).to_le_bytes().to_vec();
        bytes.push(0x02);
        violation_closes_only_that_session(bytes);
    }

    #[test]
    fn unknown_frame_kind_is_a_protocol_error() {
        let mut bytes = 5u32.to_le_bytes().to_vec();
        bytes.extend_from_slice(&[0x07, 1, 2, 3, 4]);
        violation_closes_only_that_session(bytes);
    }

    #[test]
    fn malformed_control_json_is_a_protocol_error() {
        let mut bytes = 4u32.to_le_bytes().to_vec();
        bytes.extend_from_slice(&[0x01, b'{', b'x', b'}']);
        violation_closes_only_that_session(bytes);
    }

    #[test]
    fn update_whose_pixel_length_disagrees_with_its_header_is_a_protocol_error() {
        // header says 2x2 (16 bytes of RGBA) but 15 bytes follow
        violation_closes_only_that_session(encode_update(0, 1, 100, 100, 0, 0, 2, 2, &[0u8; 15]));
    }

    #[test]
    fn update_rectangle_outside_the_framebuffer_is_a_protocol_error() {
        // x + w = 99 + 2 = 101 > 100
        violation_closes_only_that_session(encode_update(0, 1, 100, 100, 99, 0, 2, 1, &[0u8; 8]));
    }

    #[test]
    fn update_with_u32_overflowing_rectangle_is_a_protocol_error() {
        violation_closes_only_that_session(encode_update(0, 1, 100, 100, u32::MAX, 0, 2, 1, &[0u8; 8]));
    }

    #[test]
    fn update_for_an_oversized_framebuffer_is_a_protocol_error() {
        // 3841 > 3840 wide framebuffer
        violation_closes_only_that_session(encode_update(0, 1, 3841, 100, 0, 0, 1, 1, &[0u8; 4]));
    }

    #[test]
    fn a_valid_update_is_relayed() {
        let (a, b) = socketpair();
        let mut mgr = RdpManager::new();
        let id = mgr.adopt(None, a);
        write_all(b, &encode_update(0, 5, 100, 50, 10, 20, 2, 1, &[1, 2, 3, 4, 5, 6, 7, 8]));
        let frames = mgr.process_readable(id, usize::MAX);
        match &frames[..] {
            [RdpFrame::Update { header, rgba }] => {
                assert_eq!((header.frame_id, header.x, header.y, header.w, header.h), (5, 10, 20, 2, 1));
                assert_eq!(rgba, &vec![1, 2, 3, 4, 5, 6, 7, 8]);
            }
            other => panic!("unexpected {other:?}"),
        }
        assert!(mgr.take_closed(id).is_none());
        unsafe { libc::close(b) };
    }

    /// The per-turn budget leaves later frames buffered, not dropped.
    #[test]
    fn the_byte_budget_leaves_remaining_frames_buffered() {
        let (a, b) = socketpair();
        let mut mgr = RdpManager::new();
        let id = mgr.adopt(None, a);
        for n in 1..=3u64 {
            write_all(b, &encode_update(0, n, 100, 50, 0, 0, 2, 1, &[0u8; 8]));
        }
        let first = mgr.process_readable(id, 8); // budget exhausted by one 8-byte update
        assert_eq!(first.len(), 1);
        assert!(mgr.has_buffered_frame(id));
        let second = mgr.process_readable(id, usize::MAX);
        assert_eq!(second.len(), 2);
        unsafe { libc::close(b) };
    }

    #[test]
    fn decision_must_name_the_pending_prompt_fingerprint() {
        let fp = "75:B2:CE:77:71:A3:C0:EC:5C:BC:9E:3A:41:FF:0E:9F:BF:0E:CB:5B:01:7C:BE:5D:13:E9:41:7C:73:DF:65:7E";
        let other = "74:B2:CE:77:71:A3:C0:EC:5C:BC:9E:3A:41:FF:0E:9F:BF:0E:CB:5B:01:7C:BE:5D:13:E9:41:7C:73:DF:65:7E";
        let (a, b) = socketpair();
        let mut mgr = RdpManager::new();
        let id = mgr.adopt(None, a);
        assert_eq!(mgr.check_decision(id, fp), Err(DecisionRefusal::NoPendingPrompt));
        let prompt = EngineEvent::CertPrompt {
            host: "h".into(),
            port: 3389,
            fingerprint: fp.to_string(),
            subject: String::new(),
            issuer: String::new(),
            not_before: String::new(),
            not_after: String::new(),
            reason: "untrusted_root".into(),
            detail: None,
        };
        write_all(b, &encode_control(&prompt));
        let _ = mgr.process_readable(id, usize::MAX);
        assert_eq!(mgr.check_decision(id, other), Err(DecisionRefusal::FingerprintMismatch));
        // the refusal leaves the prompt pending
        assert_eq!(mgr.check_decision(id, &fp.to_lowercase().replace(':', "")), Ok(()));
        assert_eq!(mgr.check_decision(id, fp), Err(DecisionRefusal::NoPendingPrompt));
        assert_eq!(mgr.check_decision(999, fp), Err(DecisionRefusal::UnknownSession));
        unsafe { libc::close(b) };
    }

    #[test]
    fn every_repeatable_command_is_refused_over_the_cap_but_a_decision_is_not() {
        let (a, b) = socketpair();
        let mut mgr = RdpManager::new();
        let id = mgr.adopt(None, a);
        mgr.sessions.get_mut(&id).unwrap().write_buf.extend(vec![0u8; WRITE_INPUT_SOFT_CAP + 1]);
        for cmd in [EngineCommand::Input { events: vec![] }, EngineCommand::Ack { frame_id: 1 }, EngineCommand::Screenshot] {
            assert_eq!(mgr.enqueue_command(id, &cmd), Err(EnqueueError::Full), "{cmd:?}");
        }
        assert_eq!(
            mgr.enqueue_command(id, &EngineCommand::CertDecision { fingerprint: "AA".into(), accept: "once".into() }),
            Ok(())
        );
        assert_eq!(mgr.enqueue_command(999, &EngineCommand::Screenshot), Err(EnqueueError::UnknownSession));
        unsafe { libc::close(b) };
    }

    #[test]
    fn acknowledgements_coalesce_to_the_newest_frame_id() {
        let (a, b) = socketpair();
        let mut mgr = RdpManager::new();
        let id = mgr.adopt(None, a);
        for frame_id in 1..=100_000u64 {
            assert_eq!(mgr.enqueue_command(id, &EngineCommand::Ack { frame_id }), Ok(()));
        }
        // 100 000 acknowledgements occupy no queue bytes; one is sent.
        assert_eq!(mgr.sessions[&id].write_buf.len(), 0);
        mgr.write_pending(id);
        let mut buf = vec![0u8; 4096];
        let n = unsafe { libc::read(b, buf.as_mut_ptr() as *mut libc::c_void, buf.len()) };
        assert!(n > 0);
        let want = encode_control(&EngineCommand::Ack { frame_id: 100_000 });
        assert_eq!(&buf[..n as usize], &want[..]);
        unsafe { libc::close(b) };
    }

    #[test]
    fn outstanding_screenshot_requests_are_capped() {
        let (a, b) = socketpair();
        let mut mgr = RdpManager::new();
        let id = mgr.adopt(None, a);
        for i in 0..MAX_PENDING_SCREENSHOTS as u64 {
            assert_eq!(mgr.enqueue_command(id, &EngineCommand::Screenshot), Ok(()));
            mgr.push_screenshot(id, i);
        }
        assert_eq!(mgr.enqueue_command(id, &EngineCommand::Screenshot), Err(EnqueueError::TooManyScreenshots));
        unsafe { libc::close(b) };
    }

    #[test]
    fn engine_env_is_empty_and_argv_is_fixed() {
        assert!(engine_env().is_empty());
        let argv: Vec<String> = engine_argv(None).iter().map(|a| a.to_str().unwrap().to_string()).collect();
        assert_eq!(argv, vec!["remote-hub-helper", "--rdp-engine"]);
    }

    #[test]
    fn take_frame_handles_partial_and_complete_frames() {
        let mut buf = Vec::new();
        let frame = encode_control(&EngineEvent::State { state: "tls".to_string() });
        for i in 0..frame.len() - 1 {
            buf.push(frame[i]);
            assert!(matches!(take_frame(&mut buf), Take::Incomplete));
        }
        buf.push(frame[frame.len() - 1]);
        match take_frame(&mut buf) {
            Take::Frame(body) => assert_eq!(body, frame[4..].to_vec()),
            _ => panic!("expected a frame"),
        }
        assert!(buf.is_empty());
    }
}
