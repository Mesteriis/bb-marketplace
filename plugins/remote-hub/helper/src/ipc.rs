//! The stdio event loop: polls stdin, stdout, the signal pipe and every session
//! PTY, dispatches control requests, streams PTY output back as binary frames,
//! and tears every child down on stdin EOF or SIGTERM. All fds are non-blocking;
//! nothing here can block shutdown, and every buffer is bounded.

use std::collections::VecDeque;
use std::io;
use std::os::fd::RawFd;
use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};

use crate::protocol::{
    self, Request, Response, FRAME_KIND_CONTROL, MAX_FRAME_BODY_BYTES, PROTOCOL_VERSION,
};
use crate::sessions::{SessionError, SessionManager, READ_CHUNK};

/// Bounded stdout write buffer. The loop stops draining PTY output and stops
/// reading stdin while it is full (backpressure) instead of buffering without
/// limit.
const OUTBOX_CAP: usize = 4 * 1024 * 1024;
/// Headroom reserved so a single control response (e.g. a close's drained
/// tail) always fits without crossing OUTBOX_CAP.
const OUTBOX_RESERVE: usize = 512 * 1024;
/// Bounded ingress buffer for stdin frames not yet dispatched.
const INGRESS_CAP: usize = 1024 * 1024;

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

/// A 128-bit value (hex string) that differs across helper starts, so the
/// client can tell a restarted helper from the one it was talking to.
fn random_generation() -> String {
    let mut bytes = [0u8; 16];
    let fd = unsafe { libc::open(c"/dev/urandom".as_ptr(), libc::O_RDONLY) };
    if fd >= 0 {
        let mut got = 0usize;
        while got < 16 {
            let n = unsafe {
                libc::read(fd, bytes[got..].as_mut_ptr() as *mut libc::c_void, 16 - got)
            };
            if n <= 0 {
                break;
            }
            got += n as usize;
        }
        unsafe { libc::close(fd) };
        if got == 16 {
            return bytes.iter().map(|b| format!("{b:02x}")).collect();
        }
    }
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0) as u128;
    let value = nanos ^ ((std::process::id() as u128) << 64);
    format!("{value:032x}")
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
    generation: &str,
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
                generation: generation.to_string(),
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
            Err(e) => Ok(protocol::encode_response(&Response::Error {
                id: Some(id),
                code: "session_open_failed".to_string(),
                message: e.to_string(),
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
            Some((base_seq, chunks)) => {
                let mut out = Vec::new();
                for (i, chunk) in chunks.iter().enumerate() {
                    out.extend_from_slice(&protocol::encode_stream(
                        session_id,
                        base_seq.wrapping_add(i as u32),
                        chunk,
                    ));
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
/// read(2) returns, bounded by INGRESS_CAP, and yields full control frames.
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
        if self.buf.len() >= INGRESS_CAP {
            return Ok(()); // ingress is full: stop reading until it drains
        }
        let mut chunk = [0u8; 8192];
        loop {
            let room = INGRESS_CAP - self.buf.len();
            if room == 0 {
                return Ok(());
            }
            let want = room.min(chunk.len());
            let n = unsafe {
                libc::read(fd, chunk.as_mut_ptr() as *mut libc::c_void, want as libc::size_t)
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

/// Owns the SessionManager and reaps every child on ANY exit path, including a
/// panic (Drop runs during unwinding).
struct CleanupGuard {
    manager: SessionManager,
}

impl Drop for CleanupGuard {
    fn drop(&mut self) {
        self.manager.terminate_all();
    }
}

#[derive(Clone, Copy)]
enum PollRole {
    Stdin,
    Signal,
    Stdout,
    Session(u32),
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

    let generation = random_generation();
    let mut guard = CleanupGuard {
        manager: SessionManager::new(echo_argv),
    };
    let mut reader = FrameReader::new();
    let mut outbox: VecDeque<u8> = VecDeque::new();
    let mut handshaken = false;
    let mut last_total = usize::MAX;
    let mut stalled = 0u32;

    loop {
        if SHUTDOWN.load(Ordering::Relaxed) {
            break;
        }

        flush_stdout(&mut outbox);

        let session_fds = guard.manager.fds();
        let mut fds: Vec<libc::pollfd> = Vec::with_capacity(3 + session_fds.len());
        let mut roles: Vec<PollRole> = Vec::with_capacity(3 + session_fds.len());
        // Keep reading stdin until EOF, but only while the outbox has room so
        // a control-frame flood cannot grow memory without limit.
        let want_stdin = !reader.eof && outbox.len() + OUTBOX_RESERVE <= OUTBOX_CAP;
        roles.push(PollRole::Stdin);
        fds.push(pollfd(0, if want_stdin { libc::POLLIN } else { 0 }));
        roles.push(PollRole::Signal);
        fds.push(pollfd(signal_rfd, libc::POLLIN));
        if !outbox.is_empty() {
            roles.push(PollRole::Stdout);
            fds.push(pollfd(1, libc::POLLOUT));
        }
        for (sid, mfd) in &session_fds {
            let mut events = 0;
            if guard.manager.can_read_output(*sid) {
                events |= libc::POLLIN;
            }
            if guard.manager.wants_write(*sid) {
                events |= libc::POLLOUT;
            }
            roles.push(PollRole::Session(*sid));
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

        for (i, role) in roles.iter().enumerate() {
            let revents = fds[i].revents;
            match role {
                PollRole::Signal => {
                    if revents & (libc::POLLIN | libc::POLLHUP | libc::POLLERR) != 0 {
                        let mut sink = [0u8; 64];
                        let mut saw_shutdown = false;
                        loop {
                            let n = unsafe {
                                libc::read(signal_rfd, sink.as_mut_ptr() as *mut libc::c_void, sink.len())
                            };
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
                }
                PollRole::Stdout => {
                    flush_stdout(&mut outbox);
                }
                PollRole::Session(sid) => {
                    if revents & (libc::POLLIN | libc::POLLHUP | libc::POLLERR | libc::POLLNVAL) != 0 {
                        let _ = guard.manager.read_output(*sid);
                    }
                    if revents & libc::POLLOUT != 0 {
                        let _ = guard.manager.write_pending_input(*sid);
                    }
                }
                PollRole::Stdin => {}
            }
        }

        // Reap children that exited on their own (never shuts down the helper).
        guard.manager.reap();

        // Drain pending output into the bounded outbox in READ_CHUNK frames so
        // per-session sequence numbers stay consecutive.
        let snapshot = guard.manager.fds();
        loop {
            let mut progressed = false;
            for (sid, _) in &snapshot {
                let pending = guard.manager.pending_output_len(*sid);
                let room = OUTBOX_CAP.saturating_sub(outbox.len());
                if pending > 0 && room >= pending.min(READ_CHUNK) {
                    if let Some((seq, data)) = guard.manager.take_pending_output_chunk(*sid) {
                        outbox.extend(protocol::encode_stream(*sid, seq, &data));
                        progressed = true;
                    }
                }
            }
            if !progressed {
                break;
            }
        }

        // Finished sessions (child reaped, PTY done, output drained): notify.
        for session_id in guard.manager.remove_finished() {
            outbox.extend(protocol::encode_response(&Response::SessionClosed {
                id: None,
                session_id,
            }));
        }

        // stdin: read more (POLLIN or a hangup that still has buffered data),
        // then drain buffered frames.
        if !reader.eof && want_stdin && (fds[0].revents & (libc::POLLIN | libc::POLLHUP | libc::POLLERR) != 0) {
            if let Err(e) = reader.fill(0) {
                outbox.extend(protocol::encode_response(&Response::Error {
                    id: None,
                    code: "read_failed".to_string(),
                    message: e,
                }));
                SHUTDOWN.store(true, Ordering::SeqCst);
            }
        }
        while outbox.len() + OUTBOX_RESERVE <= OUTBOX_CAP {
            match reader.try_take() {
                Ok(Some(req)) => match handle(&mut guard.manager, &mut handshaken, &generation, req) {
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

        // EOF with everything consumed (requests dispatched and outbox flushed):
        // done. Otherwise keep flushing; a client that no longer drains stdout
        // is bounded by the stall counter.
        if reader.eof {
            let total = reader.buf.len() + outbox.len();
            if total == 0 {
                break;
            }
            if total < last_total {
                stalled = 0;
            } else {
                stalled += 1;
            }
            last_total = total;
            if stalled > 200 {
                break;
            }
        }
    }

    flush_stdout(&mut outbox);
    SIGNAL_WRITE_FD.store(-1, Ordering::SeqCst);
    unsafe {
        libc::close(signal_rfd);
        libc::close(signal_wfd);
    }
    // guard drops here: terminate_all on every path.
    0
}
