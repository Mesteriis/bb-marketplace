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
/// Input moves from the per-sender queue into the engine's write buffer only while that buffer is below this.
pub const INPUT_FLUSH_SOFT: usize = 8 * 1024;
/// Input batches that may wait in the per-sender queue.
pub const PENDING_INPUT_MAX: usize = 1024;
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
pub(crate) fn wait_pid(pid: libc::pid_t) -> Option<libc::c_int> {
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

pub(crate) fn parse_status(status: libc::c_int) -> EngineExit {
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
    /// Input waiting to go to the engine, by sender (stage 4b-1, Z2). It moves into `write_buf` only while that holds
    /// less than `INPUT_FLUSH_SOFT`, so a driver that is replaced leaves at most a few kilobytes already on their way.
    pending_input: VecDeque<(String, Vec<protocol::InputEvent>)>,
    /// Who may send input, and the driver generation the engine is told with every input command: the engine drops
    /// input of an older generation and releases what the previous driver left down (A2).
    owner: String,
    generation: u64,
    /// Handovers waiting for the engine's answer: (the helper request to answer, events dropped here).
    owner_waiters: VecDeque<(u64, u64)>,
    state: String,
    desktop_ready: bool,
    close_reason: Option<String>,
    screenshot_ids: VecDeque<u64>,
    /// A chunked screenshot in progress: (request id or None, next chunk index, total).
    shot: Option<(Option<u64>, u32, u32)>,
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
    /// A chunked screenshot begins; `id` is the request it answers (None when
    /// nobody asked: the answer and its chunks are dropped).
    ScreenshotStart { id: Option<u64>, frame_id: u64, width: u32, height: u32, timestamp: u64, chunks: u32 },
    ScreenshotChunk { id: u64, index: u32, count: u32, data: String },
    Update { header: UpdateHeader, rgba: Vec<u8> },
    /// The engine finished a handover (or died before it could): answer the helper request that waited for it.
    OwnerSet { request: u64, dropped: u64, released: u32 },
}

/// What `set_owner` leaves to do: answer now, or wait for the engine's `OwnerSet` (delivered as `RdpFrame::OwnerSet`).
#[derive(Debug, PartialEq, Eq)]
pub enum OwnerHandoff {
    Done { dropped: u64 },
    Waiting,
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
    /// The sender is not the session's current driver.
    StaleOwner,
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
    /// Screenshot requests that never got an answer; each is answered with
    /// `session_closed`.
    pub pending_screenshots: Vec<u64>,
    pub reason: String,
    pub exit: EngineExit,
}

/// Where a saved RDP password lives and what it is for, kept while its session has not yet shown a
/// certificate: the first accepted certificate is then pinned into the saved item.
pub struct PinTarget {
    pub reference: String,
    pub host: String,
    pub port: u16,
    pub user: String,
    pub domain: Option<String>,
}

pub struct RdpManager {
    sessions: HashMap<u32, RdpSession>,
    pin_targets: HashMap<u32, PinTarget>,
    ids: SessionIds,
    /// A synthetic engine mode (`test-hooks` builds only).
    fake_engine: Option<String>,
}

pub(crate) fn set_nonblocking(fd: RawFd) {
    unsafe {
        let flags = libc::fcntl(fd, libc::F_GETFL);
        libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK);
    }
}

pub(crate) fn set_cloexec(fd: RawFd) {
    unsafe {
        let flags = libc::fcntl(fd, libc::F_GETFD);
        libc::fcntl(fd, libc::F_SETFD, flags | libc::FD_CLOEXEC);
    }
}

/// Move `fd` to a descriptor >= 10 (close-on-exec) so the child's dup2 targets
/// 0..3 can never collide with it.
pub(crate) fn lift_fd(fd: RawFd) -> Result<RawFd, String> {
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
        RdpManager { sessions: HashMap::new(), pin_targets: HashMap::new(), ids, fake_engine }
    }

    /// The helper's verdict for a `PinRequest`, sent to the engine of that session.
    pub fn answer_pin(&mut self, id: u32, verdict: &str) {
        let _ = self.enqueue_command(id, &EngineCommand::PinAnswer { verdict: verdict.to_string() });
    }

    pub fn set_pin_target(&mut self, id: u32, target: PinTarget) {
        self.pin_targets.insert(id, target);
    }

    pub fn take_pin_target(&mut self, id: u32) -> Option<PinTarget> {
        self.pin_targets.remove(&id)
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

    /// What the poll loop should ask of this session's fd: read while the outbox
    /// has `room` for a whole update, write while commands are pending. Zero
    /// means the fd stays out of the poll set this turn.
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

    /// The fd reported a hang-up (POLLHUP/POLLERR/POLLNVAL): the engine can no
    /// longer receive, so drop what was waiting to be sent. Nothing else changes:
    /// the transport stays open and no reason is recorded, so a Closed event that
    /// is still buffered is read once the outbox has room, and `EOF_GRACE` bounds
    /// the case where it never has. Without this, a pending write keeps the fd in
    /// the poll set for POLLOUT, which never comes on a hung-up peer, and `poll`
    /// returns at once every turn (a CPU spin while the outbox is full).
    pub fn on_hangup(&mut self, id: u32) {
        if let Some(s) = self.sessions.get_mut(&id) {
            s.write_buf.clear();
            s.pending_ack = None;
        }
    }

    /// The write side of one poll turn for this session: a hang-up drops what
    /// was waiting to be sent (see `on_hangup`), POLLOUT sends it.
    pub fn handle_poll_events(&mut self, id: u32, revents: libc::c_short) {
        if revents & (libc::POLLHUP | libc::POLLERR | libc::POLLNVAL) != 0 {
            self.on_hangup(id);
        }
        if revents & libc::POLLOUT != 0 {
            self.write_pending(id);
        }
    }

    pub fn wants_write(&self, id: u32) -> bool {
        self.sessions.get(&id).map(|s| s.fd >= 0 && (!s.write_buf.is_empty() || s.pending_ack.is_some() || !s.pending_input.is_empty())).unwrap_or(false)
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
        pin_first_use: bool,
        options: crate::rdp::options::RdpOptions,
    ) -> Result<(u32, libc::pid_t), String> {
        let id = self.ids.next().ok_or_else(|| "session ids are exhausted".to_string())?;
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
        self.adopt_as(id, Some(pid), helper_fd);

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
            pin_first_use,
            options,
        };
        self.sessions.get_mut(&id).unwrap().write_buf.extend(protocol::encode_control(&cmd));
        Ok((id, pid))
    }

    /// Register a session around an engine pid (None when no child is owned,
    /// as in tests) and the helper's end of its socket.
    #[cfg(test)]
    pub(crate) fn adopt(&mut self, pid: Option<libc::pid_t>, fd: RawFd) -> u32 {
        let id = self.ids.next().expect("test ids are not exhausted");
        self.adopt_as(id, pid, fd);
        id
    }

    fn adopt_as(&mut self, id: u32, pid: Option<libc::pid_t>, fd: RawFd) {
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
                pending_input: VecDeque::new(),
                owner: "human".to_string(),
                generation: 0,
                owner_waiters: VecDeque::new(),
                state: "connecting".to_string(),
                desktop_ready: false,
                close_reason: None,
                screenshot_ids: VecDeque::new(),
                shot: None,
                pending_ack: None,
                pending_prompt: None,
                ended_at: None,
                reported_closed: false,
            },
        );
    }

    /// Moves waiting input into the engine's write buffer while it is nearly empty. The bound is checked AFTER the
    /// frame is encoded: a frame that would take the buffer past `INPUT_FLUSH_SOFT` waits (unless the buffer is empty,
    /// so one large batch still goes), which keeps what is already on its way to the engine small.
    fn flush_input(s: &mut RdpSession) {
        while let Some((owner, events)) = s.pending_input.pop_front() {
            let frame = protocol::encode_control(&EngineCommand::Input { events: events.clone(), generation: s.generation });
            if !s.write_buf.is_empty() && s.write_buf.len() + frame.len() > INPUT_FLUSH_SOFT {
                s.pending_input.push_front((owner, events));
                return;
            }
            s.write_buf.extend(frame);
        }
    }

    /// Input from `owner`: refused unless that is the session's current driver, queued per sender otherwise.
    pub fn enqueue_input(&mut self, id: u32, owner: &str, events: Vec<protocol::InputEvent>) -> Result<(), EnqueueError> {
        let s = self.sessions.get_mut(&id).ok_or(EnqueueError::UnknownSession)?;
        if s.fd < 0 {
            return Err(EnqueueError::Dead);
        }
        if s.owner != owner {
            return Err(EnqueueError::StaleOwner);
        }
        if s.pending_input.len() >= PENDING_INPUT_MAX || s.write_buf.len() > WRITE_INPUT_SOFT_CAP {
            return Err(EnqueueError::Full);
        }
        s.pending_input.push_back((owner.to_string(), events));
        Self::flush_input(s);
        Ok(())
    }

    /// A new driver. What the previous one had waiting here is dropped and the engine is told the new generation: it
    /// drops older input still in the pipe, releases what it applied and still holds down against its OWN framebuffer,
    /// and answers `OwnerSet`. `request` is the helper request to answer then (the barrier); `Done` means no
    /// engine answer is awaited (no engine, or no desktop yet so nothing could be applied).
    pub fn set_owner(&mut self, id: u32, owner: &str, request: u64) -> Result<OwnerHandoff, EnqueueError> {
        let s = self.sessions.get_mut(&id).ok_or(EnqueueError::UnknownSession)?;
        if s.owner == owner {
            // The same driver again. If the engine has not yet answered the change to it (a retry after a timeout), this
            // request joins that outstanding answer: nothing may be reported as applied before the engine confirmed it. The
            // engine hears the same generation once more (it is idempotent there) so every waiter gets its own answer.
            if s.fd >= 0 && s.desktop_ready && !s.owner_waiters.is_empty() {
                s.write_buf.extend(protocol::encode_control(&EngineCommand::SetOwner { generation: s.generation, request: s.generation }));
                s.owner_waiters.push_back((request, 0));
                return Ok(OwnerHandoff::Waiting);
            }
            return Ok(OwnerHandoff::Done { dropped: 0 });
        }
        let dropped: u64 = s.pending_input.drain(..).map(|(_, events)| events.len() as u64).sum();
        s.generation += 1;
        s.owner = owner.to_string();
        if s.fd < 0 {
            return Ok(OwnerHandoff::Done { dropped });
        }
        s.write_buf.extend(protocol::encode_control(&EngineCommand::SetOwner { generation: s.generation, request: s.generation }));
        if !s.desktop_ready {
            return Ok(OwnerHandoff::Done { dropped });
        }
        s.owner_waiters.push_back((request, dropped));
        Ok(OwnerHandoff::Waiting)
    }

    pub fn enqueue_command(&mut self, id: u32, cmd: &EngineCommand) -> Result<(), EnqueueError> {
        let s = self.sessions.get_mut(&id).ok_or(EnqueueError::UnknownSession)?;
        if s.fd < 0 {
            return Err(EnqueueError::Dead);
        }
        // One bound for every command kind that a client can repeat. Decisions
        // and Close are single-shot (a decision needs a pending prompt) and
        // always get through.
        let bounded = matches!(cmd, EngineCommand::Input { .. } | EngineCommand::Ack { .. } | EngineCommand::Screenshot | EngineCommand::Refresh);
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

    /// Take every screenshot request still waiting for an answer (oldest first).
    pub fn take_pending_screenshots(&mut self, id: u32) -> Vec<u64> {
        self.sessions.get_mut(&id).map(|s| s.screenshot_ids.drain(..).collect()).unwrap_or_default()
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

    /// Read what is already readable on a session whose engine has ended and
    /// record its Closed event, if one is there (the first reason wins). Other
    /// frames are discarded: the session is over. Bounded; never blocks.
    fn drain_for_closed(s: &mut RdpSession) {
        const DRAIN_LIMIT: usize = 8 * 1024 * 1024;
        let mut read_total = 0usize;
        while s.fd >= 0 {
            match take_frame(&mut s.read_buf) {
                Take::Frame(frame) => {
                    if let Some(RdpFrame::Event(EngineEvent::Closed { reason })) = classify_frame(&frame) {
                        Self::set_reason(s, &reason);
                    }
                    continue;
                }
                Take::Violation => {
                    Self::set_reason(s, "protocol_error");
                    return;
                }
                Take::Incomplete => {}
            }
            if read_total >= DRAIN_LIMIT {
                return;
            }
            let mut chunk = [0u8; 65536];
            let n = unsafe { libc::read(s.fd, chunk.as_mut_ptr() as *mut libc::c_void, chunk.len()) };
            if n <= 0 {
                return; // EAGAIN, EINTR, EOF or an error: nothing more to read now
            }
            read_total += n as usize;
            s.read_buf.extend_from_slice(&chunk[..n as usize]);
        }
    }

    /// End the transport of a session whose engine is gone, after draining what
    /// is readable. Reason precedence: a Closed event that was read, then
    /// `engine_exited`.
    fn finish_ended(s: &mut RdpSession) {
        Self::drain_for_closed(s);
        Self::set_reason(s, "engine_exited");
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
        // A chunked answer cut off by the end of the session still has its request
        // id (taken at the header): it is owed a `session_closed` like the others,
        // oldest first.
        let mut pending_screenshots: Vec<u64> = s.shot.take().and_then(|(id, _, _)| id).into_iter().collect();
        pending_screenshots.extend(s.screenshot_ids.drain(..));
        Some(ClosedReport { session_id: id, pending_screenshots, reason, exit: s.exit.unwrap_or_default() })
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
                    // Every frame counts against the turn's byte budget, events
                    // as well as pixels.
                    used += frame.len();
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
                        Some(RdpFrame::Event(EngineEvent::OwnerSet { released, .. })) => {
                            // Answered in the order asked; an answer nobody waits for (a handover the helper did not need to await) is ignored.
                            if let Some((request, dropped)) = s.owner_waiters.pop_front() {
                                out.push(RdpFrame::OwnerSet { request, dropped, released });
                            }
                        }
                        Some(RdpFrame::Event(EngineEvent::CertPrompt {
                            host, port, fingerprint, subject, issuer, not_before, not_after, reason, detail, first_use,
                        })) => {
                            s.pending_prompt = Some(fingerprint.clone());
                            out.push(RdpFrame::Event(EngineEvent::CertPrompt {
                                host, port, fingerprint, subject, issuer, not_before, not_after, reason, detail, first_use,
                            }));
                        }
                        Some(RdpFrame::Event(EngineEvent::ScreenshotStart { frame_id, width, height, timestamp, chunks })) => {
                            // The engine is untrusted: one chunked answer at a time,
                            // a sane chunk count.
                            if s.shot.is_some() || !(2..=protocol::MAX_SCREENSHOT_CHUNKS).contains(&chunks) {
                                Self::fail_protocol(s);
                            } else {
                                let id = s.screenshot_ids.pop_front();
                                s.shot = Some((id, 0, chunks));
                                out.push(RdpFrame::ScreenshotStart { id, frame_id, width, height, timestamp, chunks });
                            }
                        }
                        Some(RdpFrame::Event(EngineEvent::ScreenshotChunk { index, data })) => {
                            match s.shot {
                                Some((id, next, total))
                                    if index == next
                                        && data.len() <= protocol::SCREENSHOT_CHUNK_BASE64
                                        && data.len() % 4 == 0 =>
                                {
                                    s.shot = if next + 1 == total { None } else { Some((id, next + 1, total)) };
                                    if let Some(id) = id {
                                        out.push(RdpFrame::ScreenshotChunk { id, index, count: total, data });
                                    }
                                }
                                _ => Self::fail_protocol(s),
                            }
                        }
                        Some(f) => out.push(f),
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
        if s.fd < 0 {
            // The engine is gone: nothing more will be applied, so the handovers that waited for it are complete.
            while let Some((request, dropped)) = s.owner_waiters.pop_front() {
                out.push(RdpFrame::OwnerSet { request, dropped, released: 0 });
            }
        }
        out
    }

    pub fn write_pending(&mut self, id: u32) {
        let Some(s) = self.sessions.get_mut(&id) else { return };
        Self::flush_input(s);
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
                // The engine is gone (or going). Drop what could not be sent and
                // leave the end of the session to the read path: it reads the
                // engine's Closed event first and only then sees the EOF.
                // Recording `engine_exited` here would discard that event.
                s.write_buf.clear();
                s.pending_ack = None;
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
            let Some(pid) = s.engine_pid else {
                // A reaped engine's transport is bounded too: if no EOF has come
                // EOF_GRACE after the engine ended, end it here, whoever still
                // holds the peer.
                if s.fd >= 0 && s.ended_at.map(|t| t.elapsed() >= EOF_GRACE).unwrap_or(false) {
                    Self::finish_ended(s);
                    out.push(s.id);
                }
                continue;
            };
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
            if s.fd >= 0 {
                // The transport is still open: the engine may have written its
                // Closed event (the real reason) just before it exited, and that
                // event is still unread. Leave the transport to the poll loop,
                // which reads it and then sees the EOF (a dead process has no
                // open socket); only an EOF without a Closed event is
                // `engine_exited`. If no EOF ever comes, the next `reap()` after
                // EOF_GRACE ends the transport (see the top of this loop).
                s.ended_at.get_or_insert_with(Instant::now);
            } else {
                Self::set_reason(s, "engine_exited");
            }
            out.push(s.id);
        }
        out
    }

    /// Tear one engine down for good: reap it if it already exited, otherwise
    /// SIGKILL it and wait. A pid that was already reaped is never signalled.
    /// Stop the engine. True when it had to be killed; false when it was
    /// already gone (reaped earlier, or exited and is reaped here).
    fn stop_engine(s: &mut RdpSession) -> bool {
        let Some(pid) = s.engine_pid.take() else { return s.exit.is_none() };
        let mut status: libc::c_int = 0;
        let r = unsafe { libc::waitpid(pid, &mut status, libc::WNOHANG) };
        if r == pid {
            s.exit = Some(parse_status(status));
            return false;
        }
        kill_engine(pid);
        s.exit = wait_pid(pid).map(parse_status);
        true
    }

    /// Close a session at the client's request. Reason precedence: a Closed
    /// event the engine wrote (read first), then `engine_exited` (it ended by
    /// itself), then `killed_by_close` (this close had to kill it).
    pub fn close(&mut self, id: u32) -> Option<String> {
        self.pin_targets.remove(&id);
        let mut s = self.sessions.remove(&id)?;
        let killed = Self::stop_engine(&mut s);
        if !killed {
            Self::drain_for_closed(&mut s);
            Self::set_reason(&mut s, "engine_exited");
        }
        Self::close_transport(&mut s);
        Some(s.close_reason.unwrap_or_else(|| "killed_by_close".to_string()))
    }

    pub fn terminate_all(&mut self) {
        self.pin_targets.clear();
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
    /// macOS has no atomic close-on-exec socketpair, and every test spawns real
    /// children: a child spawned between `socketpair` and `set_cloexec` would
    /// inherit an end and keep it open, so an EOF the test waits for never
    /// comes. Creation and spawning are serialised.
    static SPAWN_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn socketpair() -> (RawFd, RawFd) {
        let _guard = SPAWN_LOCK.lock().unwrap_or_else(|e| e.into_inner());
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
        let _guard = SPAWN_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let child = std::process::Command::new("/bin/sh")
            .args(["-c", &format!("exit {code}")])
            .spawn()
            .expect("spawn /bin/sh");
        child.id() as libc::pid_t
    }

    /// A real child that stays alive until it is killed.
    fn spawn_sleeper() -> libc::pid_t {
        let _guard = SPAWN_LOCK.lock().unwrap_or_else(|e| e.into_inner());
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
        // A dead engine holds no socket: its end is closed.
        unsafe { libc::close(b) };
        wait_until(|| !mgr.reap().is_empty());
        read_until_closed(&mut mgr, id);
        let report = mgr.take_closed(id).expect("closed after reap");
        assert_eq!(report.reason, "engine_exited");
        assert_eq!(report.exit, EngineExit { code: Some(9), signal: None });
        assert_eq!(mgr.engine_pid(id), None, "pid must be cleared once reaped");
    }

    /// The race behind a load-only g8 failure: the engine writes its Closed event
    /// and exits; the helper reaps it BEFORE it has read the event. The reason
    /// the engine reported must win over `engine_exited`.
    #[test]
    fn a_reaped_engine_keeps_the_closed_reason_it_wrote_before_exiting() {
        let (a, b) = socketpair();
        write_all(b, &encode_control(&EngineEvent::Closed { reason: "network_error".to_string() }));
        unsafe { libc::close(b) }; // the engine is gone: EOF follows the event
        let pid = spawn_exit(0);
        wait_until_exited_unreaped(pid);
        let mut mgr = RdpManager::new();
        let id = mgr.adopt(Some(pid), a);
        assert_eq!(mgr.reap(), vec![id], "the engine is reaped before anything is read");
        read_until_closed(&mut mgr, id);
        let report = mgr.take_closed(id).expect("closed");
        assert_eq!(report.reason, "network_error");
        assert_eq!(report.exit, EngineExit { code: Some(0), signal: None });
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

    // ---- stage 4b-1 repairs Z2 and Z3: who drives, and what a driver leaves behind ----

    fn read_available(fd: RawFd) -> String {
        let mut out = Vec::new();
        let mut buf = [0u8; 4096];
        unsafe {
            let flags = libc::fcntl(fd, libc::F_GETFL);
            libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK);
        }
        loop {
            let n = unsafe { libc::read(fd, buf.as_mut_ptr() as *mut libc::c_void, buf.len()) };
            if n <= 0 {
                break;
            }
            out.extend_from_slice(&buf[..n as usize]);
        }
        String::from_utf8_lossy(&out).to_string()
    }

    fn key(scancode: u8, down: bool) -> protocol::InputEvent {
        protocol::InputEvent::Key { scancode, extended: false, down }
    }
    fn press(button: &str, x: u32, y: u32, w: u32, h: u32) -> protocol::InputEvent {
        protocol::InputEvent::MouseButton { button: button.into(), down: true, x, y, geom_width: w, geom_height: h }
    }
    fn desktop(mgr: &mut RdpManager, id: u32, b: RawFd, w: u32, h: u32) {
        write_all(b, &encode_control(&EngineEvent::Desktop { frame_id: 1, width: w, height: h, timestamp: 1 }));
        let _ = mgr.process_readable(id, usize::MAX);
    }

    #[test]
    fn input_from_anyone_but_the_current_owner_is_refused() {
        let (a, b) = socketpair();
        let mut mgr = RdpManager::new();
        let id = mgr.adopt(None, a);
        assert_eq!(mgr.enqueue_input(id, "agent:L1", vec![key(0x1e, true)]), Err(EnqueueError::StaleOwner));
        assert_eq!(mgr.enqueue_input(id, "human", vec![key(0x1e, true)]), Ok(()));
        mgr.set_owner(id, "agent:L1", 1).unwrap();
        assert_eq!(mgr.enqueue_input(id, "human", vec![key(0x1e, false)]), Err(EnqueueError::StaleOwner));
        assert_eq!(mgr.enqueue_input(id, "agent:L1", vec![key(0x30, true)]), Ok(()));
        assert_eq!(mgr.enqueue_input(id, "agent:L0", vec![key(0x30, false)]), Err(EnqueueError::StaleOwner), "an older lease is not the owner");
        unsafe { libc::close(b) };
    }

    #[test]
    fn a_driver_that_is_replaced_loses_what_was_still_waiting_and_the_barrier_says_how_much() {
        let (a, b) = socketpair();
        let mut mgr = RdpManager::new();
        let id = mgr.adopt(None, a);
        mgr.set_owner(id, "agent:L1", 1).unwrap();
        // An engine that is not reading: fill the write buffer so later batches wait in the per-sender queue.
        mgr.sessions.get_mut(&id).unwrap().write_buf.extend(vec![0u8; INPUT_FLUSH_SOFT]);
        for sc in 0x10..0x15u8 {
            mgr.enqueue_input(id, "agent:L1", vec![key(sc, true), key(sc, false)]).unwrap();
        }
        assert_eq!(mgr.sessions[&id].pending_input.len(), 5);
        assert_eq!(mgr.set_owner(id, "human", 2).unwrap(), OwnerHandoff::Done { dropped: 10 }, "five batches of two events were waiting; no desktop yet, so no engine answer is awaited");
        assert_eq!(mgr.sessions[&id].pending_input.len(), 0);
        mgr.sessions.get_mut(&id).unwrap().write_buf.clear();
        // The human's own input goes through afterwards.
        mgr.enqueue_input(id, "human", vec![key(0x2c, true)]).unwrap();
        mgr.write_pending(id);
        let sent = read_available(b);
        assert!(sent.contains("\"scancode\":44"), "{sent}");
        assert!(!sent.contains("\"scancode\":16"), "a dropped event reached the engine: {sent}");
        unsafe { libc::close(b) };
    }

    #[test]
    fn a_handover_tells_the_engine_the_new_generation_and_the_barrier_waits_for_its_answer() {
        let (a, b) = socketpair();
        let mut mgr = RdpManager::new();
        let id = mgr.adopt(None, a);
        desktop(&mut mgr, id, b, 800, 600);
        // Input under generation 0, then a handover to an agent: the engine hears generation 1 and the input after it carries 1.
        mgr.enqueue_input(id, "human", vec![key(0x2a, true)]).unwrap();
        assert_eq!(mgr.set_owner(id, "agent:L1", 77).unwrap(), OwnerHandoff::Waiting);
        mgr.enqueue_input(id, "agent:L1", vec![key(0x1e, true)]).unwrap();
        mgr.write_pending(id);
        let sent = read_available(b);
        let first = sent.find("\"generation\":0").expect(&sent);
        let handover = sent.find("\"type\":\"set_owner\"").expect(&sent);
        let second = sent.rfind("\"generation\":1").expect(&sent);
        assert!(first < handover && handover < second, "{sent}");
        // No answer is produced until the engine answers.
        assert!(mgr.process_readable(id, usize::MAX).is_empty());
        write_all(b, &encode_control(&EngineEvent::OwnerSet { request: 1, released: 1 }));
        let frames = mgr.process_readable(id, usize::MAX);
        assert!(matches!(frames.as_slice(), [RdpFrame::OwnerSet { request: 77, dropped: 0, released: 1 }]), "{frames:?}");
        unsafe { libc::close(b) };
    }

    #[test]
    fn a_repeated_request_for_the_owner_being_applied_joins_the_outstanding_answer_instead_of_reporting_done() {
        let (a, b) = socketpair();
        let mut mgr = RdpManager::new();
        let id = mgr.adopt(None, a);
        desktop(&mut mgr, id, b, 800, 600);
        assert_eq!(mgr.set_owner(id, "suspended:L1", 10).unwrap(), OwnerHandoff::Waiting);
        // The first request timed out in the service and is sent again; the engine has not answered yet.
        assert_eq!(mgr.set_owner(id, "suspended:L1", 11).unwrap(), OwnerHandoff::Waiting, "must not claim the change was applied");
        mgr.write_pending(id);
        let sent = read_available(b);
        assert_eq!(sent.matches("\"type\":\"set_owner\"").count(), 2, "{sent}");
        write_all(b, &encode_control(&EngineEvent::OwnerSet { request: 1, released: 2 }));
        write_all(b, &encode_control(&EngineEvent::OwnerSet { request: 1, released: 0 }));
        let frames = mgr.process_readable(id, usize::MAX);
        assert!(matches!(frames.as_slice(), [RdpFrame::OwnerSet { request: 10, .. }, RdpFrame::OwnerSet { request: 11, .. }]), "{frames:?}");
        // Once answered, a repeat is plain Done.
        assert_eq!(mgr.set_owner(id, "suspended:L1", 12).unwrap(), OwnerHandoff::Done { dropped: 0 });
        unsafe { libc::close(b) };
    }

    #[test]
    fn an_engine_that_dies_during_a_handover_still_completes_it() {
        let (a, b) = socketpair();
        let mut mgr = RdpManager::new();
        let id = mgr.adopt(None, a);
        desktop(&mut mgr, id, b, 800, 600);
        assert_eq!(mgr.set_owner(id, "agent:L1", 5).unwrap(), OwnerHandoff::Waiting);
        unsafe { libc::close(b) };
        // EOF is not instantaneous in a test binary: another test thread that forks a child while `b` is still open holds a copy of it
        // until that child execs, and the engine's end only counts as closed once the last copy is gone. Poll, like the other EOF tests.
        let mut frames = Vec::new();
        wait_until(|| {
            frames.extend(mgr.process_readable(id, usize::MAX));
            frames.iter().any(|f| matches!(f, RdpFrame::OwnerSet { request: 5, .. }))
        });
        assert!(frames.iter().any(|f| matches!(f, RdpFrame::OwnerSet { request: 5, .. })), "{frames:?}");
    }

    #[test]
    fn a_batch_that_would_take_the_pipe_past_its_soft_bound_waits_and_is_not_appended_first() {
        let (a, b) = socketpair();
        let mut mgr = RdpManager::new();
        let id = mgr.adopt(None, a);
        mgr.sessions.get_mut(&id).unwrap().write_buf.extend(vec![0u8; INPUT_FLUSH_SOFT - 10]);
        mgr.enqueue_input(id, "human", vec![key(0x1e, true), key(0x1e, false)]).unwrap();
        assert!(mgr.sessions[&id].write_buf.len() <= INPUT_FLUSH_SOFT, "the frame was appended beyond the bound");
        assert_eq!(mgr.sessions[&id].pending_input.len(), 1);
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
            first_use: false,
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
        for cmd in [EngineCommand::Input { events: vec![], generation: 0 }, EngineCommand::Ack { frame_id: 1 }, EngineCommand::Screenshot] {
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

    fn screenshot_frame(png_len: usize) -> Vec<u8> {
        encode_control(&EngineEvent::Screenshot {
            frame_id: 1,
            width: 1,
            height: 1,
            timestamp: 0,
            png: "A".repeat(png_len),
        })
    }

    #[test]
    fn event_frames_count_against_the_turn_budget() {
        let (a, b) = socketpair();
        let mut mgr = RdpManager::new();
        let id = mgr.adopt(None, a);
        for _ in 0..5 {
            mgr.sessions.get_mut(&id).unwrap().read_buf.extend(screenshot_frame(1_500_000));
        }
        // Budget 4 MiB: frames of ~1.5 MB each → the third crosses it and ends the turn.
        let first = mgr.process_readable(id, 4 * 1024 * 1024);
        assert_eq!(first.len(), 3);
        let second = mgr.process_readable(id, 4 * 1024 * 1024);
        assert_eq!(second.len(), 2);
        unsafe { libc::close(b) };
    }

    #[test]
    fn a_control_frame_over_4_mib_fails_that_session() {
        let (a, b) = socketpair();
        let mut mgr = RdpManager::new();
        let id = mgr.adopt(None, a);
        let over = 4 * 1024 * 1024 + 1;
        mgr.sessions.get_mut(&id).unwrap().read_buf.extend((over as u32).to_le_bytes());
        mgr.sessions.get_mut(&id).unwrap().read_buf.push(protocol::FRAME_CONTROL);
        assert!(mgr.process_readable(id, usize::MAX).is_empty());
        assert_eq!(mgr.sessions[&id].close_reason.as_deref(), Some("protocol_error"));
        unsafe { libc::close(b) };
    }

    fn shot_start(chunks: u32) -> Vec<u8> {
        encode_control(&EngineEvent::ScreenshotStart { frame_id: 3, width: 4, height: 2, timestamp: 9, chunks })
    }

    fn shot_chunk(index: u32, len: usize) -> Vec<u8> {
        encode_control(&EngineEvent::ScreenshotChunk { index, data: "A".repeat(len) })
    }

    fn feed(mgr: &mut RdpManager, id: u32, frames: &[Vec<u8>]) -> Vec<RdpFrame> {
        for f in frames {
            mgr.sessions.get_mut(&id).unwrap().read_buf.extend(f.iter().copied());
        }
        mgr.process_readable(id, usize::MAX)
    }

    #[test]
    fn a_chunked_screenshot_is_answered_with_the_oldest_request_id_and_ordered_chunks() {
        let (a, b) = socketpair();
        let mut mgr = RdpManager::new();
        let id = mgr.adopt(None, a);
        mgr.push_screenshot(id, 41);
        mgr.push_screenshot(id, 42);
        let frames = feed(&mut mgr, id, &[shot_start(3), shot_chunk(0, 8), shot_chunk(1, 8), shot_chunk(2, 4)]);
        assert_eq!(frames.len(), 4, "{frames:?}");
        assert!(matches!(&frames[0], RdpFrame::ScreenshotStart { id: Some(41), chunks: 3, frame_id: 3, width: 4, height: 2, timestamp: 9 }));
        for (i, want_len) in [(1usize, 8usize), (2, 8), (3, 4)] {
            match &frames[i] {
                RdpFrame::ScreenshotChunk { id: 41, index, count: 3, data } => {
                    assert_eq!(*index as usize, i - 1);
                    assert_eq!(data.len(), want_len);
                }
                other => panic!("frame {i}: {other:?}"),
            }
        }
        assert_eq!(mgr.sessions[&id].close_reason, None);
        assert_eq!(mgr.pop_screenshot(id), Some(42), "the second request is still waiting");
        unsafe { libc::close(b) };
    }

    #[test]
    fn a_session_that_ends_mid_chunked_screenshot_still_owes_that_request_a_closed() {
        let (a, b) = socketpair();
        let mut mgr = RdpManager::new();
        let id = mgr.adopt(None, a);
        mgr.push_screenshot(id, 41);
        mgr.push_screenshot(id, 42);
        // The header and the first chunk arrive; the engine then ends.
        let _ = feed(&mut mgr, id, &[shot_start(3), shot_chunk(0, 8)]);
        mgr.sessions.get_mut(&id).unwrap().close_reason = Some("engine_exited".to_string());
        mgr.sessions.get_mut(&id).unwrap().engine_pid = None;
        let report = mgr.take_closed(id).expect("closed report");
        assert_eq!(report.pending_screenshots, vec![41, 42]);
        unsafe { libc::close(b) };
    }

    #[test]
    fn a_screenshot_nobody_asked_for_and_its_chunks_are_dropped_without_error() {
        let (a, b) = socketpair();
        let mut mgr = RdpManager::new();
        let id = mgr.adopt(None, a);
        let frames = feed(&mut mgr, id, &[shot_start(2), shot_chunk(0, 4), shot_chunk(1, 4)]);
        assert!(matches!(frames.as_slice(), [RdpFrame::ScreenshotStart { id: None, .. }]), "{frames:?}");
        assert_eq!(mgr.sessions[&id].close_reason, None);
        unsafe { libc::close(b) };
    }

    #[test]
    fn a_misordered_or_oversized_chunk_stream_fails_that_session() {
        let cases: Vec<(&str, Vec<Vec<u8>>)> = vec![
            ("chunk without a start", vec![shot_chunk(0, 4)]),
            ("index skips ahead", vec![shot_start(3), shot_chunk(1, 4)]),
            ("index repeats", vec![shot_start(3), shot_chunk(0, 4), shot_chunk(0, 4)]),
            ("chunk over the cap", vec![shot_start(2), shot_chunk(0, protocol::SCREENSHOT_CHUNK_BASE64 + 4)]),
            ("chunk not whole base64", vec![shot_start(2), shot_chunk(0, 5)]),
            ("a single-chunk start", vec![shot_start(1)]),
            ("too many chunks", vec![shot_start(protocol::MAX_SCREENSHOT_CHUNKS + 1)]),
            ("a second start while one runs", vec![shot_start(2), shot_start(2)]),
        ];
        for (name, frames) in cases {
            let (a, b) = socketpair();
            let mut mgr = RdpManager::new();
            let id = mgr.adopt(None, a);
            mgr.push_screenshot(id, 1);
            mgr.push_screenshot(id, 2);
            let _ = feed(&mut mgr, id, &frames);
            assert_eq!(mgr.sessions[&id].close_reason.as_deref(), Some("protocol_error"), "{name}");
            unsafe { libc::close(b) };
        }
    }

    #[test]
    fn a_closed_session_hands_over_its_unanswered_screenshot_requests_once() {
        let (a, b) = socketpair();
        let mut mgr = RdpManager::new();
        let id = mgr.adopt(None, a);
        mgr.push_screenshot(id, 5);
        mgr.push_screenshot(id, 6);
        unsafe { libc::close(b) };
        // EOF arrives once no forked child still holds the peer (another test may
        // be between fork and exec): wait for it as an event.
        read_until_closed(&mut mgr, id);
        let report = mgr.take_closed(id).expect("closed");
        assert_eq!(report.pending_screenshots, vec![5, 6]);
        assert_eq!(report.reason, "engine_exited");
        assert!(mgr.take_closed(id).is_none());
    }

    /// J1: the engine writes Closed and exits; an ack is queued; the helper's
    /// write sees the dead peer BEFORE it reads the event. The event's reason
    /// must win over `engine_exited`.
    #[test]
    fn a_write_to_a_dead_engine_does_not_discard_its_closed_event() {
        let (a, b) = socketpair();
        write_all(b, &encode_control(&EngineEvent::Closed { reason: "network_error".to_string() }));
        unsafe { libc::close(b) };
        let mut mgr = RdpManager::new();
        let id = mgr.adopt(None, a);
        assert_eq!(mgr.enqueue_command(id, &EngineCommand::Ack { frame_id: 1 }), Ok(()));
        mgr.write_pending(id); // EPIPE, as the poll loop does before reading
        read_until_closed(&mut mgr, id);
        let report = mgr.take_closed(id).expect("closed");
        assert_eq!(report.reason, "network_error");
    }

    /// A session whose engine was reaped but whose peer is still open (retained
    /// by someone) with `ended_at` already past `EOF_GRACE`.
    fn reaped_but_open(closed_event: Option<&str>) -> (RdpManager, u32, RawFd) {
        let pid = spawn_exit(0);
        wait_until_exited_unreaped(pid);
        let (a, b) = socketpair();
        if let Some(reason) = closed_event {
            write_all(b, &encode_control(&EngineEvent::Closed { reason: reason.to_string() }));
        }
        let mut mgr = RdpManager::new();
        let id = mgr.adopt(Some(pid), a);
        assert_eq!(mgr.reap(), vec![id]);
        assert!(mgr.take_closed(id).is_none(), "the transport is still open: not closed yet");
        mgr.sessions.get_mut(&id).unwrap().ended_at = Instant::now().checked_sub(EOF_GRACE + Duration::from_secs(1));
        (mgr, id, b)
    }

    /// J2: a retained peer keeps no session open past EOF_GRACE.
    #[test]
    fn a_reaped_sessions_open_transport_expires_after_the_grace() {
        let (mut mgr, id, b) = reaped_but_open(None);
        assert_eq!(mgr.reap(), vec![id]);
        let report = mgr.take_closed(id).expect("closed after the grace");
        assert_eq!(report.reason, "engine_exited");
        assert_eq!(report.exit, EngineExit { code: Some(0), signal: None });
        assert!(mgr.fds().is_empty());
        unsafe { libc::close(b) };
    }

    /// J2: a Closed event that is readable when the grace expires still wins.
    #[test]
    fn a_closed_event_readable_at_expiry_wins_over_engine_exited() {
        let (mut mgr, id, b) = reaped_but_open(Some("network_error"));
        assert_eq!(mgr.reap(), vec![id]);
        assert_eq!(mgr.take_closed(id).expect("closed").reason, "network_error");
        unsafe { libc::close(b) };
    }

    /// J3(a): an explicit close after the engine was reaped but before its
    /// Closed event was read reports that event's reason.
    #[test]
    fn close_after_reap_reads_the_buffered_closed_event_first() {
        let (mut mgr, id, b) = reaped_but_open(Some("network_error"));
        assert_eq!(mgr.close(id).as_deref(), Some("network_error"));
        unsafe { libc::close(b) };
    }

    /// J3(b): when close itself finds the engine already exited (unreaped), the
    /// reason is `engine_exited`, not `killed_by_close`, and nothing is killed.
    #[test]
    fn close_of_an_already_exited_unreaped_engine_is_engine_exited() {
        let pid = spawn_exit(0);
        wait_until_exited_unreaped(pid);
        let (a, b) = socketpair();
        let mut mgr = RdpManager::new();
        let id = mgr.adopt(Some(pid), a);
        assert_eq!(mgr.close(id).as_deref(), Some("engine_exited"));
        assert!(!ENGINE_KILLS.lock().unwrap().contains(&pid), "an exited engine was signalled");
        unsafe { libc::close(b) };
    }

    /// The peer goes away, even if a forked child of another test still holds a
    /// copy of its descriptor (between fork and exec): `shutdown` ends the
    /// connection itself, `close` only drops one reference.
    fn hang_up(peer: RawFd) {
        unsafe {
            libc::shutdown(peer, libc::SHUT_RDWR);
            libc::close(peer);
        }
    }

    /// Block until the kernel reports the peer's hang-up on the session's fd. A
    /// forked child of another test can hold the peer open for a moment (between
    /// fork and exec), so the hang-up is waited for as an event; the limit is a
    /// hang guard.
    fn wait_for_hangup(mgr: &RdpManager, id: u32) {
        let fd = mgr.fds().iter().find(|(i, _)| *i == id).map(|(_, fd)| *fd).unwrap();
        for _ in 0..600 {
            // The loop's own interest with a full outbox: write only.
            let mut pfd = libc::pollfd { fd, events: libc::POLLOUT, revents: 0 };
            unsafe { libc::poll(&mut pfd, 1, 50) };
            if pfd.revents & libc::POLLHUP != 0 {
                return;
            }
        }
        panic!("hang guard: the peer's hang-up was never reported");
    }

    /// Run the poll loop's decision for one session for up to `turns` turns, as
    /// `ipc.rs` does (interest, a zero-timeout poll, hang-up handling) with the
    /// outbox full (`room == false`). Returns how many turns polled the fd.
    fn polled_turns(mgr: &mut RdpManager, id: u32, turns: usize) -> usize {
        let mut polled = 0;
        for _ in 0..turns {
            let events = mgr.poll_interest(id, false);
            if events == 0 {
                break; // the fd is out of the poll set
            }
            let fd = mgr.fds().iter().find(|(i, _)| *i == id).map(|(_, fd)| *fd).unwrap();
            let mut pfd = libc::pollfd { fd, events, revents: 0 };
            unsafe { libc::poll(&mut pfd, 1, 0) };
            polled += 1;
            mgr.handle_poll_events(id, pfd.revents);
        }
        polled
    }

    /// K1: outbox full, an ack pending, the engine dead with its Closed event
    /// buffered. The hang-up takes the fd out of the poll set after one turn (no
    /// spin), records no reason yet, and the buffered reason still wins once read.
    #[test]
    fn a_hung_up_engine_with_a_pending_write_leaves_the_poll_set() {
        let (a, b) = socketpair();
        write_all(b, &encode_control(&EngineEvent::Closed { reason: "network_error".to_string() }));
        hang_up(b);
        let mut mgr = RdpManager::new();
        let id = mgr.adopt(None, a);
        assert_eq!(mgr.enqueue_command(id, &EngineCommand::Ack { frame_id: 1 }), Ok(()));
        assert!(mgr.wants_write(id));
        wait_for_hangup(&mgr, id);
        let polled = polled_turns(&mut mgr, id, 100);
        assert!(polled <= 2, "the helper polled a hung-up fd {polled} times in 100 turns");
        assert!(!mgr.wants_write(id));
        assert!(mgr.take_closed(id).is_none(), "no reason may be recorded by the hang-up itself");
        read_until_closed(&mut mgr, id);
        assert_eq!(mgr.take_closed(id).expect("closed").reason, "network_error");
    }

    /// K1: if the outbox never drains, the grace still ends the session, with the
    /// buffered reason when one is readable.
    #[test]
    fn a_hung_up_engine_is_still_ended_by_the_grace_when_the_outbox_never_drains() {
        let (mut mgr, id, b) = reaped_but_open(Some("network_error"));
        assert_eq!(mgr.enqueue_command(id, &EngineCommand::Ack { frame_id: 1 }), Ok(()));
        hang_up(b);
        wait_for_hangup(&mgr, id);
        assert!(polled_turns(&mut mgr, id, 100) <= 2);
        assert_eq!(mgr.reap(), vec![id]);
        assert_eq!(mgr.take_closed(id).expect("closed").reason, "network_error");
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
