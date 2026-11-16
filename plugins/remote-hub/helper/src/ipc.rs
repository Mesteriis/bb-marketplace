//! The stdio event loop: polls stdin, the signal pipe and every session PTY,
//! dispatches control requests, streams PTY output back as binary frames, and
//! tears every child down on stdin EOF or SIGTERM. All fds are non-blocking;
//! nothing here can block shutdown.

use std::collections::VecDeque;
use std::io;
use std::os::fd::RawFd;
use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};

use crate::protocol::{
    self, Request, Response, FRAME_KIND_CONTROL, MAX_FRAME_BODY_BYTES, PROTOCOL_VERSION,
};
use crate::sessions::{SessionError, SessionManager, READ_CHUNK};

/// Bounded stdout write buffer. When full, the loop stops draining PTY output
/// (backpressure) instead of buffering without limit.
const OUTBOX_CAP: usize = 4 * 1024 * 1024;

static SIGNAL_WRITE_FD: AtomicI32 = AtomicI32::new(-1);
static SHUTDOWN: AtomicBool = AtomicBool::new(false);

const SIG_BYTE_SHUTDOWN: u8 = b'S';
const SIG_BYTE_CHILD: u8 = b'C';

extern "C" fn on_shutdown_signal(_sig: libc::c_int) {
    let fd = SIGNAL_WRITE_FD.load(Ordering::Relaxed);
    if fd >= 0 {
        let byte = [SIG_BYTE_SHUTDOWN];
        unsafe { libc::write(fd, byte.as_ptr() as *const libc::c_void, 1) };
    }
}

extern "C" fn on_sigchld(_sig: libc::c_int) {
    let fd = SIGNAL_WRITE_FD.load(Ordering::Relaxed);
    if fd >= 0 {
        let byte = [SIG_BYTE_CHILD];
        unsafe { libc::write(fd, byte.as_ptr() as *const libc::c_void, 1) };
    }
}

fn install_handler(sig: libc::c_int, handler: extern "C" fn(libc::c_int)) {
    unsafe {
        let mut sa: libc::sigaction = std::mem::zeroed();
        sa.sa_sigaction = handler as usize;
        libc::sigemptyset(&mut sa.sa_mask);
        sa.sa_flags = 0;
        libc::sigaction(sig, &sa, std::ptr::null_mut());
    }
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

fn make_pipe() -> (RawFd, RawFd) {
    let mut fds = [0 as RawFd; 2];
    let r = unsafe { libc::pipe(fds.as_mut_ptr()) };
    assert_eq!(r, 0, "pipe failed");
    set_nonblocking(fds[0]);
    set_nonblocking(fds[1]);
    set_cloexec(fds[0]);
    set_cloexec(fds[1]);
    (fds[0], fds[1])
}

fn platform_string() -> String {
    if cfg!(target_os = "macos") {
        format!("{}-apple-darwin", std::env::consts::ARCH)
    } else {
        format!("{}-{}", std::env::consts::ARCH, std::env::consts::OS)
    }
}

fn request_id(req: &Request) -> Option<u64> {
    match req {
        Request::Hello { .. } => None,
        Request::Ping { id }
        | Request::OpenEcho { id, .. }
        | Request::SessionInput { id, .. }
        | Request::SessionResize { id, .. }
        | Request::SessionClose { id, .. } => Some(*id),
    }
}

/// Runs one control request. Returns encoded frames to queue, or a fatal
/// (code, message) that stops the helper.
fn handle(
    manager: &mut SessionManager,
    handshaken: &mut bool,
    req: Request,
) -> Result<Vec<u8>, (String, String)> {
    if !*handshaken && !matches!(req, Request::Hello { .. }) {
        return Ok(protocol::encode_response(&Response::Error {
            id: request_id(&req),
            code: "handshake_required".to_string(),
            message: "send hello before any other request".to_string(),
        }));
    }
    match req {
        Request::Hello { protocol } => {
            if protocol != PROTOCOL_VERSION {
                return Err((
                    "version_mismatch".to_string(),
                    format!(
                        "unsupported protocol version {protocol}; this helper speaks {PROTOCOL_VERSION}"
                    ),
                ));
            }
            *handshaken = true;
            Ok(protocol::encode_response(&Response::HelloAck {
                protocol: PROTOCOL_VERSION,
                helper_version: env!("CARGO_PKG_VERSION").to_string(),
                platform: platform_string(),
                pid: std::process::id(),
            }))
        }
        Request::Ping { id } => Ok(protocol::encode_response(&Response::Pong { id })),
        Request::OpenEcho { id, cols, rows } => match manager.open_echo(cols, rows) {
            Ok(session_id) => {
                let pid = manager.child_pid(session_id).unwrap_or(0);
                Ok(protocol::encode_response(&Response::SessionOpened {
                    id,
                    session_id,
                    cols,
                    rows,
                    pid: pid as u32,
                }))
            }
            Err(_) => Ok(protocol::encode_response(&Response::Error {
                id: Some(id),
                code: "session_open_failed".to_string(),
                message: "could not open an echo session".to_string(),
            })),
        },
        Request::SessionInput {
            id,
            session_id,
            data,
        } => match manager.enqueue_input(session_id, &data) {
            Ok(()) => Ok(protocol::encode_response(&Response::SessionInputAck { id, session_id })),
            Err(SessionError::InputOverflow) => Ok(protocol::encode_response(&Response::Error {
                id: Some(id),
                code: "input_overflow".to_string(),
                message: "session input exceeds the bounded pending-input window".to_string(),
            })),
            Err(_) => Ok(protocol::encode_response(&Response::Error {
                id: Some(id),
                code: "session_not_found".to_string(),
                message: format!("no echo session {session_id}"),
            })),
        },
        Request::SessionResize {
            id,
            session_id,
            cols,
            rows,
        } => match manager.resize(session_id, cols, rows) {
            Ok((applied_cols, applied_rows)) => Ok(protocol::encode_response(&Response::SessionResized {
                id,
                session_id,
                cols: applied_cols,
                rows: applied_rows,
            })),
            Err(_) => Ok(protocol::encode_response(&Response::Error {
                id: Some(id),
                code: "session_not_found".to_string(),
                message: format!("no echo session {session_id}"),
            })),
        },
        Request::SessionClose { id, session_id } => match manager.close(session_id) {
            Some((seq, drained)) => {
                let mut out = Vec::new();
                if !drained.is_empty() {
                    out.extend_from_slice(&protocol::encode_stream(session_id, seq, &drained));
                }
                out.extend_from_slice(&protocol::encode_response(&Response::SessionClosed {
                    id: Some(id),
                    session_id,
                }));
                Ok(out)
            }
            None => Ok(protocol::encode_response(&Response::Error {
                id: Some(id),
                code: "session_not_found".to_string(),
                message: format!("no echo session {session_id}"),
            })),
        },
    }
}

/// Incremental reader over the helper's stdin (non-blocking): buffers whatever
/// read(2) returns and yields full control frames.
struct FrameReader {
    buf: Vec<u8>,
    eof: bool,
}

impl FrameReader {
    fn new() -> Self {
        FrameReader {
            buf: Vec::new(),
            eof: false,
        }
    }

    fn fill(&mut self, fd: RawFd) -> Result<(), String> {
        let mut chunk = [0u8; 8192];
        loop {
            let n = unsafe {
                libc::read(fd, chunk.as_mut_ptr() as *mut libc::c_void, chunk.len() as libc::size_t)
            };
            if n < 0 {
                let err = io::Error::last_os_error();
                if err.kind() == io::ErrorKind::Interrupted {
                    continue;
                }
                if err.kind() == io::ErrorKind::WouldBlock {
                    return Ok(());
                }
                return Err(format!("stdin read: {err}"));
            }
            if n == 0 {
                self.eof = true;
                return Ok(());
            }
            self.buf.extend_from_slice(&chunk[..n as usize]);
        }
    }

    fn try_take(&mut self) -> Result<Option<Request>, String> {
        if self.buf.len() < 4 {
            return Ok(None);
        }
        let body_len = u32::from_le_bytes([self.buf[0], self.buf[1], self.buf[2], self.buf[3]]) as usize;
        if body_len > MAX_FRAME_BODY_BYTES {
            return Err(format!(
                "frame body length {body_len} exceeds the {MAX_FRAME_BODY_BYTES} byte limit"
            ));
        }
        if body_len < 1 {
            return Err("frame body length 0 is invalid".to_string());
        }
        if self.buf.len() < 4 + body_len {
            return Ok(None);
        }
        let frame: Vec<u8> = self.buf.drain(..4 + body_len).collect();
        if frame[4] != FRAME_KIND_CONTROL {
            return Err(format!("unexpected frame kind {}", frame[4]));
        }
        if frame.len() < 6 {
            return Err("empty control body".to_string());
        }
        let req = serde_json::from_slice(&frame[5..])
            .map_err(|e| format!("invalid control frame: {e}"))?;
        Ok(Some(req))
    }
}

fn pollfd(fd: RawFd, events: libc::c_short) -> libc::pollfd {
    libc::pollfd {
        fd,
        events,
        revents: 0,
    }
}

/// Best-effort non-blocking flush of the outbox to stdout.
fn flush_stdout(outbox: &mut VecDeque<u8>) {
    while !outbox.is_empty() {
        let (a, b) = outbox.as_slices();
        let n = if !a.is_empty() {
            unsafe { libc::write(1, a.as_ptr() as *const libc::c_void, a.len()) }
        } else {
            unsafe { libc::write(1, b.as_ptr() as *const libc::c_void, b.len()) }
        };
        if n < 0 {
            let err = io::Error::last_os_error();
            if err.kind() == io::ErrorKind::Interrupted {
                continue;
            }
            return; // EAGAIN or a real error: retry next iteration
        }
        outbox.drain(..n as usize);
    }
}

/// Reaps every owned child on ANY exit path, including a panic.
struct CleanupGuard {
    manager: *mut SessionManager,
    armed: bool,
}

impl CleanupGuard {
    fn new(manager: *mut SessionManager) -> Self {
        CleanupGuard { manager, armed: true }
    }
    fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for CleanupGuard {
    fn drop(&mut self) {
        if self.armed {
            unsafe { (*self.manager).terminate_all() };
        }
    }
}

pub fn run(echo_argv: Option<Vec<String>>) -> i32 {
    unsafe { libc::signal(libc::SIGPIPE, libc::SIG_IGN) };
    set_nonblocking(0);
    set_nonblocking(1);

    let (signal_rfd, signal_wfd) = make_pipe();
    SIGNAL_WRITE_FD.store(signal_wfd, Ordering::SeqCst);
    install_handler(libc::SIGTERM, on_shutdown_signal);
    install_handler(libc::SIGINT, on_shutdown_signal);
    install_handler(libc::SIGHUP, on_shutdown_signal);
    install_handler(libc::SIGCHLD, on_sigchld);

    let mut manager = SessionManager::new(echo_argv);
    let mut guard = CleanupGuard::new(&mut manager);
    let mut reader = FrameReader::new();
    let mut outbox: VecDeque<u8> = VecDeque::new();
    let mut handshaken = false;

    loop {
        if SHUTDOWN.load(Ordering::Relaxed) {
            break;
        }

        flush_stdout(&mut outbox);

        let session_fds = manager.fds();
        let mut fds: Vec<libc::pollfd> = Vec::with_capacity(2 + session_fds.len());
        fds.push(pollfd(0, libc::POLLIN));
        fds.push(pollfd(signal_rfd, libc::POLLIN));
        for (sid, mfd) in &session_fds {
            let mut events = libc::POLLIN;
            if manager.wants_write(*sid) {
                events |= libc::POLLOUT;
            }
            fds.push(pollfd(*mfd, events));
        }

        let r = unsafe { libc::poll(fds.as_mut_ptr(), fds.len() as libc::nfds_t, 50) };
        if r < 0 {
            let err = io::Error::last_os_error();
            if err.kind() == io::ErrorKind::Interrupted {
                continue;
            }
            break;
        }

        // Signal pipe: SIGCHLD only wakes us to reap; shutdown signals stop us.
        if fds[1].revents & (libc::POLLIN | libc::POLLHUP | libc::POLLERR) != 0 {
            let mut sink = [0u8; 64];
            let mut saw_shutdown = false;
            loop {
                let n = unsafe { libc::read(signal_rfd, sink.as_mut_ptr() as *mut libc::c_void, sink.len()) };
                if n > 0 {
                    for &b in &sink[..n as usize] {
                        if b == SIG_BYTE_SHUTDOWN {
                            saw_shutdown = true;
                        }
                    }
                    continue;
                }
                break;
            }
            if saw_shutdown {
                SHUTDOWN.store(true, Ordering::SeqCst);
            }
        }

        // Session PTYs: read output and write pending input.
        let snapshot = manager.fds();
        for (i, (sid, _)) in snapshot.iter().enumerate() {
            let revents = fds[2 + i].revents;
            if revents & (libc::POLLIN | libc::POLLHUP | libc::POLLERR | libc::POLLNVAL) != 0 {
                let _ = manager.read_output(*sid);
            }
            if revents & libc::POLLOUT != 0 {
                let _ = manager.write_pending_input(*sid);
            }
        }

        // Reap children that exited on their own (never shuts down the helper).
        manager.reap();

        // Drain pending output into the bounded outbox in READ_CHUNK frames so
        // per-session sequence numbers stay consecutive.
        loop {
            let mut progressed = false;
            for (sid, _) in &snapshot {
                let pending = manager.pending_output_len(*sid);
                let room = OUTBOX_CAP.saturating_sub(outbox.len());
                if pending > 0 && room >= pending.min(READ_CHUNK) {
                    if let Some((seq, data)) = manager.take_pending_output_chunk(*sid) {
                        outbox.extend(protocol::encode_stream(*sid, seq, &data));
                        progressed = true;
                    }
                }
            }
            if !progressed {
                break;
            }
        }

        // Finished sessions (child gone or PTY EOF, output drained): notify.
        for session_id in manager.remove_finished() {
            outbox.extend(protocol::encode_response(&Response::SessionClosed {
                id: None,
                session_id,
            }));
        }

        // stdin: process buffered frames first, then honour EOF/hangup.
        if fds[0].revents & libc::POLLIN != 0 {
            if let Err(e) = reader.fill(0) {
                outbox.extend(protocol::encode_response(&Response::Error {
                    id: None,
                    code: "read_failed".to_string(),
                    message: e,
                }));
                SHUTDOWN.store(true, Ordering::SeqCst);
            } else {
                loop {
                    match reader.try_take() {
                        Ok(Some(req)) => match handle(&mut manager, &mut handshaken, req) {
                            Ok(frames) => outbox.extend(frames),
                            Err((code, message)) => {
                                outbox.extend(protocol::encode_response(&Response::Error {
                                    id: None,
                                    code,
                                    message,
                                }));
                                SHUTDOWN.store(true, Ordering::SeqCst);
                                break;
                            }
                        },
                        Ok(None) => break,
                        Err(message) => {
                            outbox.extend(protocol::encode_response(&Response::Error {
                                id: None,
                                code: "invalid_frame".to_string(),
                                message,
                            }));
                            SHUTDOWN.store(true, Ordering::SeqCst);
                            break;
                        }
                    }
                }
            }
        }
        if reader.eof || (fds[0].revents & (libc::POLLHUP | libc::POLLERR) != 0) {
            break;
        }
    }

    flush_stdout(&mut outbox);
    manager.terminate_all();
    guard.disarm();
    unsafe {
        libc::close(signal_rfd);
        libc::close(signal_wfd);
    }
    0
}
