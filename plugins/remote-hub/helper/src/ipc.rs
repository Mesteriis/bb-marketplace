//! The stdio event loop: polls stdin, stdout, the signal pipe and every session
//! PTY, dispatches control requests, streams PTY output back as binary frames,
//! and tears every child down on stdin EOF or SIGTERM. All fds are non-blocking;
//! nothing here can block shutdown, and every buffer is bounded.

use std::collections::VecDeque;
use std::io;
use std::os::fd::RawFd;
use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};

use crate::protocol::{
    self, Request, Response, FRAME_KIND_CONTROL, FRAME_KIND_STREAM, MAX_FRAME_BODY_BYTES,
    PROTOCOL_VERSION, STREAM_HEADER_BYTES,
};
use crate::rdp::manager::{RdpFrame, RdpManager};
use crate::rdp::protocol::{EngineCommand, EngineEvent, UpdateHeader};
use crate::sessions::{SessionError, SessionManager, SpawnSpec, READ_CHUNK};
use std::collections::HashMap;
use std::ffi::CString;

/// Bounded stdout write buffer. The loop stops draining PTY output and stops
/// reading stdin while it is full (backpressure) instead of buffering without
/// limit.
const OUTBOX_CAP: usize = 4 * 1024 * 1024;
/// Headroom reserved so a single control response (e.g. a close's drained
/// tail) always fits without crossing OUTBOX_CAP.
const OUTBOX_RESERVE: usize = 512 * 1024;
/// Bounded ingress buffer for stdin frames not yet dispatched.
const INGRESS_CAP: usize = MAX_FRAME_BODY_BYTES + 4;

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

fn last_errno() -> i32 {
    std::io::Error::last_os_error().raw_os_error().unwrap_or(0)
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
        | Request::OpenSsh { id, .. }
        | Request::OpenRdp { id, .. }
        | Request::RdpCertDecision { id, .. }
        | Request::RdpInput { id, .. }
        | Request::RdpScreenshot { id, .. }
        | Request::SessionInput { id, .. }
        | Request::SessionResize { id, .. }
        | Request::SessionCredit { id, .. }
        | Request::SessionClose { id, .. } => Some(*id),
    }
}

/// Validate and build a SpawnSpec from a client-provided session.open_ssh.
fn build_spawn_spec(
    program: String,
    argv: Vec<String>,
    env: HashMap<String, String>,
    cwd: Option<String>,
) -> Result<SpawnSpec, String> {
    if !program.starts_with('/') {
        return Err("program must be an absolute path".to_string());
    }
    let program = CString::new(program).map_err(|_| "program has a NUL byte".to_string())?;
    let mut argv_c = Vec::with_capacity(argv.len());
    for a in &argv {
        argv_c.push(CString::new(a.as_str()).map_err(|_| "argv has a NUL byte".to_string())?);
    }
    let mut env_c = Vec::with_capacity(env.len());
    for (k, v) in &env {
        env_c.push((
            CString::new(k.as_str()).map_err(|_| "env key has a NUL byte".to_string())?,
            CString::new(v.as_str()).map_err(|_| "env value has a NUL byte".to_string())?,
        ));
    }
    let cwd = match cwd {
        Some(c) => Some(CString::new(c).map_err(|_| "cwd has a NUL byte".to_string())?),
        None => None,
    };
    Ok(SpawnSpec {
        program,
        argv: argv_c,
        env: env_c,
        cwd,
        allow_fds: Vec::new(),
    })
}

/// Runs one control request. Returns encoded frames to queue, or a fatal
/// (code, message) that stops the helper.
fn handle(
    manager: &mut SessionManager,
    rdp: &mut RdpManager,
    current_exe: &str,
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
                    kind: "echo".to_string(),
                }))
            }
            Err(e) => Ok(protocol::encode_response(&Response::Error {
                id: Some(id),
                code: "session_open_failed".to_string(),
                message: e.to_string(),
            })),
        },
        Request::OpenSsh {
            id,
            cols,
            rows,
            program,
            argv,
            env,
            cwd,
        } => {
            // Production only: the ssh kind may only run the strict OpenSSH
            // shape built by src/core/ssh-args.ts. Free-form programs remain
            // reachable with test-hooks (the feature gate compiles this check
            // away), where the Rust tests exercise them.
            #[cfg(not(feature = "test-hooks"))]
            if cwd.is_some()
                || crate::ssh_args::validate_ssh_spawn(&program, &argv, &env).is_err()
            {
                return Ok(protocol::encode_response(&Response::Error {
                    id: Some(id),
                    code: "ssh_option_rejected".to_string(),
                    message: "session.open_ssh carries a disallowed program, option, cwd or env".to_string(),
                }));
            }
            let spec = build_spawn_spec(program, argv, env, cwd);
            match spec {
                Ok(spec) => match manager.open_ssh(spec, cols, rows) {
                    Ok(session_id) => {
                        let pid = manager.child_pid(session_id).unwrap_or(0);
                        Ok(protocol::encode_response(&Response::SessionOpened {
                            id,
                            session_id,
                            cols,
                            rows,
                            pid: pid as u32,
                            kind: "ssh".to_string(),
                        }))
                    }
                    Err(e) => Ok(protocol::encode_response(&Response::Error {
                        id: Some(id),
                        code: "session_open_failed".to_string(),
                        message: e.to_string(),
                    })),
                },
                Err(msg) => Ok(protocol::encode_response(&Response::Error {
                    id: Some(id),
                    code: "spawn_spec_invalid".to_string(),
                    message: msg,
                })),
            }
        }
        Request::SessionInput {
            id,
            session_id,
            data,
        } => match manager.enqueue_input(session_id, data.as_bytes()) {
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
        Request::SessionCredit {
            id,
            session_id,
            bytes,
        } => {
            if manager.add_credit(session_id, bytes) {
                Ok(protocol::encode_response(&Response::SessionCreditAck { id, session_id }))
            } else {
                Ok(protocol::encode_response(&Response::Error {
                    id: Some(id),
                    code: "session_not_found".to_string(),
                    message: format!("no echo session {session_id}"),
                }))
            }
        }
        Request::SessionClose { id, session_id } => {
            if let Some(reason) = rdp.close(session_id) {
                return Ok(protocol::encode_response(&Response::SessionClosed {
                    id: Some(id),
                    session_id,
                    exit_code: None,
                    signal: None,
                    reason,
                }));
            }
            handle_pty_close(manager, id, session_id)
        }
        Request::OpenRdp {
            id,
            host,
            port,
            username,
            password,
            domain,
            width,
            height,
            expected_fingerprint,
        } => match rdp.open(current_exe, host, port, username, password, domain, width, height, expected_fingerprint) {
            Ok((session_id, pid)) => Ok(protocol::encode_response(&Response::SessionOpened {
                id,
                session_id,
                cols: 0,
                rows: 0,
                pid: pid as u32,
                kind: "rdp".to_string(),
            })),
            Err(message) => Ok(protocol::encode_response(&Response::Error {
                id: Some(id),
                code: "rdp_open_failed".to_string(),
                message,
            })),
        },
        Request::RdpCertDecision { id, session_id, fingerprint, accept } => {
            rdp.enqueue_command(session_id, &EngineCommand::CertDecision { fingerprint, accept });
            Ok(protocol::encode_response(&Response::RdpAck { id, session_id }))
        }
        Request::RdpInput { id, session_id, events } => {
            rdp.enqueue_command(session_id, &EngineCommand::Input { events });
            Ok(protocol::encode_response(&Response::RdpAck { id, session_id }))
        }
        Request::RdpScreenshot { id, session_id } => {
            rdp.enqueue_command(session_id, &EngineCommand::Screenshot);
            rdp.mark_screenshot_pending(session_id, id);
            // The screenshot response arrives asynchronously from the engine.
            Ok(Vec::new())
        }
    }
}

fn handle_pty_close(manager: &mut SessionManager, id: u64, session_id: u32) -> Result<Vec<u8>, (String, String)> {
    match manager.close(session_id) {
        Some((base_seq, chunks, exit_code, signal, reason)) => {
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
                exit_code,
                signal,
                reason,
            }));
            Ok(out)
        }
        None => Ok(protocol::encode_response(&Response::Error {
            id: Some(id),
            code: "session_not_found".to_string(),
            message: format!("no echo session {session_id}"),
        })),
    }
}

/// Largest helper -> client stream frame for an RDP update (<= 1 MiB per the
/// stage 2b contract B5).
const RDP_UPDATE_CHUNK_BYTES: usize = 1024 * 1024;

fn relay_rdp_frames(rdp: &mut RdpManager, outbox: &mut VecDeque<u8>, rid: u32, frames: Vec<RdpFrame>) {
    for frame in frames {
        match frame {
            RdpFrame::Event(EngineEvent::State { state }) => {
                outbox.extend(protocol::encode_response(&Response::RdpState { session_id: rid, state }));
            }
            RdpFrame::Event(EngineEvent::CertPrompt { host, port, fingerprint, subject, issuer, not_before, not_after, reason }) => {
                outbox.extend(protocol::encode_response(&Response::RdpCertPrompt {
                    session_id: rid,
                    host,
                    port,
                    fingerprint,
                    subject,
                    issuer,
                    not_before,
                    not_after,
                    reason,
                }));
            }
            RdpFrame::Event(EngineEvent::Desktop { frame_id, width, height, timestamp }) => {
                outbox.extend(protocol::encode_response(&Response::RdpDesktop {
                    session_id: rid,
                    frame_id,
                    width,
                    height,
                    timestamp,
                }));
            }
            RdpFrame::Event(EngineEvent::Screenshot { frame_id, width, height, timestamp, png }) => {
                let req_id = rdp.take_screenshot_id(rid).unwrap_or(0);
                outbox.extend(protocol::encode_response(&Response::RdpScreenshot {
                    id: req_id,
                    session_id: rid,
                    frame_id,
                    width,
                    height,
                    timestamp,
                    png,
                }));
            }
            RdpFrame::Event(EngineEvent::Error { code, message }) => {
                outbox.extend(protocol::encode_response(&Response::Error { id: None, code, message }));
            }
            RdpFrame::Event(EngineEvent::Closed { .. }) => {
                // Reported once via RdpManager::take_all_closed().
            }
            RdpFrame::Update { header, rgba } => relay_rdp_update(outbox, rid, header, &rgba),
        }
    }
}

/// Split one engine update into <= 1 MiB helper stream frames, each with its
/// own {frameId, fbWidth, fbHeight, x, y, w, h} header + RGBA rows.
fn relay_rdp_update(outbox: &mut VecDeque<u8>, rid: u32, header: UpdateHeader, rgba: &[u8]) {
    let bytes_per_row = header.w as usize * 4;
    if bytes_per_row == 0 {
        return;
    }
    let rows_per_chunk = (RDP_UPDATE_CHUNK_BYTES / bytes_per_row).max(1);
    let mut y = header.y;
    let mut remaining = header.h;
    let mut off = 0usize;
    let mut seq = 0u32;
    while remaining > 0 {
        let chunk_h = remaining.min(rows_per_chunk as u32);
        let row_bytes = bytes_per_row * chunk_h as usize;
        let data = &rgba[off..off + row_bytes];
        off += row_bytes;
        let mut payload = Vec::with_capacity(32 + data.len());
        payload.extend_from_slice(&header.frame_id.to_le_bytes());
        payload.extend_from_slice(&header.fb_width.to_le_bytes());
        payload.extend_from_slice(&header.fb_height.to_le_bytes());
        payload.extend_from_slice(&header.x.to_le_bytes());
        payload.extend_from_slice(&y.to_le_bytes());
        payload.extend_from_slice(&header.w.to_le_bytes());
        payload.extend_from_slice(&chunk_h.to_le_bytes());
        payload.extend_from_slice(data);
        outbox.extend(protocol::encode_stream(rid, seq, &payload));
        seq = seq.wrapping_add(1);
        y += chunk_h;
        remaining -= chunk_h;
    }
}

/// A stdin frame error: fatal means the stream is out of step and the helper
/// must shut down; invalid means the frame was well-framed but unparseable, so
/// the stream is still in step and the helper keeps running.
enum FrameError {
    Fatal(String),
    Invalid(String),
}

/// A parsed inbound frame (control request or binary stream input).
enum IncomingFrame {
    Control(Request),
    Stream { session_id: u32, data: Vec<u8> },
}

/// Incremental reader over the helper's stdin (non-blocking): buffers whatever
/// read(2) returns, bounded by INGRESS_CAP, and yields full control frames.
struct FrameReader {
    buf: Vec<u8>,
    eof: bool,
    read_total: u64,
}

impl FrameReader {
    fn new() -> Self {
        FrameReader {
            buf: Vec::new(),
            eof: false,
            read_total: 0,
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
            self.read_total += n as u64;
        }
    }

    #[cfg(feature = "test-hooks")]
    fn read_total(&self) -> u64 {
        self.read_total
    }

    fn is_full(&self) -> bool {
        self.buf.len() >= INGRESS_CAP
    }

    fn mark_eof(&mut self) {
        self.eof = true;
    }

    fn try_take(&mut self) -> Result<Option<IncomingFrame>, FrameError> {
        if self.buf.len() < 4 {
            return Ok(None);
        }
        let body_len = u32::from_le_bytes([self.buf[0], self.buf[1], self.buf[2], self.buf[3]]) as usize;
        if body_len > MAX_FRAME_BODY_BYTES {
            return Err(FrameError::Fatal(format!(
                "frame body length {body_len} exceeds the {MAX_FRAME_BODY_BYTES} byte limit"
            )));
        }
        if body_len < 1 {
            return Err(FrameError::Fatal("frame body length 0 is invalid".to_string()));
        }
        if self.buf.len() < 4 + body_len {
            return Ok(None);
        }
        let frame: Vec<u8> = self.buf.drain(..4 + body_len).collect();
        match frame[4] {
            FRAME_KIND_CONTROL => match serde_json::from_slice(&frame[5..]) {
                Ok(req) => Ok(Some(IncomingFrame::Control(req))),
                Err(e) => Err(FrameError::Invalid(format!("invalid control frame: {e}"))),
            },
            FRAME_KIND_STREAM => {
                if frame.len() < 5 + STREAM_HEADER_BYTES {
                    return Err(FrameError::Invalid("stream frame shorter than its header".to_string()));
                }
                let session_id = u32::from_le_bytes(frame[5..9].try_into().unwrap());
                let data = frame[5 + STREAM_HEADER_BYTES..].to_vec();
                Ok(Some(IncomingFrame::Stream { session_id, data }))
            }
            other => Err(FrameError::Fatal(format!("unexpected frame kind {other}"))),
        }
    }
}

fn pollfd(fd: RawFd, events: libc::c_short) -> libc::pollfd {
    libc::pollfd {
        fd,
        events,
        revents: 0,
    }
}

/// Best-effort non-blocking flush of the outbox to stdout. Returns true when
/// stdout failed fatally (EPIPE or any error other than EAGAIN/EINTR), meaning
/// the client is gone and the helper must tear everything down.
fn flush_stdout(outbox: &mut VecDeque<u8>) -> bool {
    while !outbox.is_empty() {
        let (a, b) = outbox.as_slices();
        let n = if !a.is_empty() {
            unsafe { libc::write(1, a.as_ptr() as *const libc::c_void, a.len()) }
        } else {
            unsafe { libc::write(1, b.as_ptr() as *const libc::c_void, b.len()) }
        };
        if n < 0 {
            let errno = last_errno();
            if errno == libc::EINTR {
                continue;
            }
            if errno == libc::EAGAIN {
                return false;
            }
            return true; // EPIPE or another non-transient error
        }
        outbox.drain(..n as usize);
    }
    false
}

/// Owns the SessionManager and reaps every child on ANY exit path, including a
/// panic (Drop runs during unwinding).
struct CleanupGuard {
    manager: SessionManager,
    rdp: RdpManager,
}

impl Drop for CleanupGuard {
    fn drop(&mut self) {
        self.manager.terminate_all();
        self.rdp.terminate_all();
    }
}

#[derive(Clone, Copy)]
enum PollRole {
    Stdin,
    Signal,
    Stdout,
    Session(u32),
    Rdp(u32),
}

pub fn run(echo_argv: Option<Vec<String>>) -> i32 {
    unsafe { libc::signal(libc::SIGPIPE, libc::SIG_IGN) };
    set_nonblocking(0);
    set_nonblocking(1);

    #[cfg(feature = "test-hooks")]
    if let Ok(v) = std::env::var("REMOTE_HUB_NOFILE") {
        if let Ok(n) = v.parse::<u64>() {
            let lim = libc::rlimit {
                rlim_cur: n,
                rlim_max: n,
            };
            unsafe { libc::setrlimit(libc::RLIMIT_NOFILE, &lim) };
        }
    }

    let (signal_rfd, signal_wfd) = make_pipe();
    SIGNAL_WRITE_FD.store(signal_wfd, Ordering::SeqCst);
    install_handler(libc::SIGTERM, on_shutdown_signal);
    install_handler(libc::SIGINT, on_shutdown_signal);
    install_handler(libc::SIGHUP, on_shutdown_signal);
    install_handler(libc::SIGCHLD, on_sigchld);

    let generation = random_generation();
    #[cfg(feature = "test-hooks")]
    let keep_finished = std::env::var("REMOTE_HUB_KEEP_FINISHED").is_ok();
    #[cfg(not(feature = "test-hooks"))]
    let keep_finished = false;
    let current_exe = std::env::current_exe()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|_| "remote-hub-helper".to_string());
    let mut guard = CleanupGuard {
        manager: SessionManager::new(echo_argv),
        rdp: RdpManager::new(),
    };
    let mut reader = FrameReader::new();
    let mut outbox: VecDeque<u8> = VecDeque::new();
    let mut handshaken = false;
    let mut last_total = usize::MAX;
    let mut stalled = 0u32;
    #[cfg(feature = "test-hooks")]
    let mut reported_stdin_blocked = false;

    loop {
        if SHUTDOWN.load(Ordering::Relaxed) {
            break;
        }

        if flush_stdout(&mut outbox) {
            // The client is gone (stdout closed): tear down every child.
            SHUTDOWN.store(true, Ordering::SeqCst);
            break;
        }

        let session_fds = guard.manager.fds();
        let mut fds: Vec<libc::pollfd> = Vec::with_capacity(3 + session_fds.len());
        let mut roles: Vec<PollRole> = Vec::with_capacity(3 + session_fds.len());
        // Keep reading stdin until EOF, but only while the outbox has room so
        // a control-frame flood cannot grow memory without limit. Once EOF is
        // seen, stdin is dropped from the poll set entirely so a lingering
        // POLLHUP cannot make poll return at once.
        let want_stdin = !reader.eof && outbox.len() + OUTBOX_RESERVE <= OUTBOX_CAP;
        #[cfg(feature = "test-hooks")]
        if !want_stdin && !reported_stdin_blocked && !reader.eof {
            reported_stdin_blocked = true;
            eprintln!("helper-stdin-blocked bytes={}", reader.read_total());
        }
        let mut stdin_idx: Option<usize> = None;
        if !reader.eof {
            stdin_idx = Some(fds.len());
            roles.push(PollRole::Stdin);
            fds.push(pollfd(0, if want_stdin { libc::POLLIN } else { 0 }));
        }
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
        let rdp_fds = guard.rdp.fds();
        for (rid, rfd) in &rdp_fds {
            let mut events = libc::POLLIN;
            if guard.rdp.wants_write(*rid) {
                events |= libc::POLLOUT;
            }
            roles.push(PollRole::Rdp(*rid));
            fds.push(pollfd(*rfd, events));
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
                    if flush_stdout(&mut outbox) {
                        SHUTDOWN.store(true, Ordering::SeqCst);
                    }
                }
                PollRole::Session(sid) => {
                    if revents & libc::POLLIN != 0 {
                        let _ = guard.manager.read_output(*sid);
                    }
                    if revents & (libc::POLLHUP | libc::POLLERR | libc::POLLNVAL) != 0 {
                        guard.manager.mark_hup(*sid);
                    }
                    if revents & libc::POLLOUT != 0 {
                        let _ = guard.manager.write_pending_input(*sid);
                    }
                }
                PollRole::Rdp(rid) => {
                    if revents & libc::POLLOUT != 0 {
                        guard.rdp.write_pending(*rid);
                    }
                    if revents & (libc::POLLIN | libc::POLLHUP | libc::POLLERR | libc::POLLNVAL) != 0 {
                        let frames = guard.rdp.process_readable(*rid);
                        relay_rdp_frames(&mut guard.rdp, &mut outbox, *rid, frames);
                    }
                }
                PollRole::Stdin => {}
            }
        }

        // Reap children that exited on their own (never shuts down the helper).
        guard.manager.reap();
        guard.rdp.reap();
        for (rid, reason) in guard.rdp.take_all_closed() {
            outbox.extend(protocol::encode_response(&Response::SessionClosed {
                id: None,
                session_id: rid,
                exit_code: None,
                signal: None,
                reason,
            }));
        }

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
        for (session_id, exit_code, signal, reason) in guard.manager.remove_finished(keep_finished) {
            outbox.extend(protocol::encode_response(&Response::SessionClosed {
                id: None,
                session_id,
                exit_code,
                signal,
                reason,
            }));
        }

        // stdin: read more (POLLIN while we want input, or a hangup that still
        // has buffered data even when the outbox is full), then drain frames.
        if let Some(idx) = stdin_idx {
            let revents = fds[idx].revents;
            let hung_up = revents & (libc::POLLHUP | libc::POLLERR) != 0;
            // Defensive on darwin (poll does not report POLLHUP while stdin events
            // are 0): these hang-up branches are not covered by a test here.
            let read_now = (want_stdin && revents & libc::POLLIN != 0) || hung_up;
            if !reader.eof && read_now {
                // The peer hung up but the ingress is still full: no more bytes
                // can be read, so treat it as EOF.
                if hung_up && reader.is_full() {
                    reader.mark_eof();
                }
                if let Err(e) = reader.fill(0) {
                    outbox.extend(protocol::encode_response(&Response::Error {
                        id: None,
                        code: "read_failed".to_string(),
                        message: e,
                    }));
                    SHUTDOWN.store(true, Ordering::SeqCst);
                }

            }
        }
        while outbox.len() + OUTBOX_RESERVE <= OUTBOX_CAP {
            match reader.try_take() {
                Ok(Some(IncomingFrame::Control(req))) => {
                    match handle(&mut guard.manager, &mut guard.rdp, &current_exe, &mut handshaken, &generation, req) {
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
                    }
                }
                Ok(Some(IncomingFrame::Stream { session_id, data })) => {
                    // Binary terminal input; overflow is dropped (backpressure).
                    let _ = guard.manager.enqueue_input(session_id, &data);
                }
                Ok(None) => break,
                Err(FrameError::Invalid(message)) => {
                    // Well-framed but unparseable body: answer and keep running.
                    outbox.extend(protocol::encode_response(&Response::Error {
                        id: None,
                        code: "invalid_frame".to_string(),
                        message,
                    }));
                }
                Err(FrameError::Fatal(message)) => {
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
