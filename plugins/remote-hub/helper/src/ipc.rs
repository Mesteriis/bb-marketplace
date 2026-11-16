//! The stdio event loop: polls stdin, the signal pipe and every session PTY,
//! dispatches control requests, streams PTY output back as binary frames, and
//! tears every child down on stdin EOF or SIGTERM.

use std::io;
use std::os::fd::RawFd;
use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};

use crate::protocol::{
    self, Request, Response, FRAME_KIND_CONTROL, MAX_FRAME_BODY_BYTES, PROTOCOL_VERSION,
};
use crate::sessions::SessionManager;

static SIGNAL_WRITE_FD: AtomicI32 = AtomicI32::new(-1);
static SHUTDOWN: AtomicBool = AtomicBool::new(false);

extern "C" fn on_signal(_sig: libc::c_int) {
    let fd = SIGNAL_WRITE_FD.load(Ordering::Relaxed);
    if fd >= 0 {
        let byte = [1u8];
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

fn make_pipe() -> (RawFd, RawFd) {
    let mut fds = [0 as RawFd; 2];
    let r = unsafe { libc::pipe(fds.as_mut_ptr()) };
    assert_eq!(r, 0, "pipe failed");
    set_nonblocking(fds[0]);
    set_nonblocking(fds[1]);
    (fds[0], fds[1])
}

fn write_all(fd: RawFd, bytes: &[u8]) -> io::Result<()> {
    let mut written = 0usize;
    while written < bytes.len() {
        let n = unsafe {
            libc::write(
                fd,
                bytes[written..].as_ptr() as *const libc::c_void,
                (bytes.len() - written) as libc::size_t,
            )
        };
        if n < 0 {
            let err = io::Error::last_os_error();
            if err.kind() == io::ErrorKind::Interrupted {
                continue;
            }
            return Err(err);
        }
        written += n as usize;
    }
    Ok(())
}

fn write_response(resp: &Response) {
    let _ = write_all(1, &protocol::encode_response(resp));
}

fn write_error(id: Option<u64>, code: &str, message: String) {
    write_response(&Response::Error {
        id,
        code: code.to_string(),
        message,
    });
}

fn platform_string() -> String {
    if cfg!(target_os = "macos") {
        format!("{}-apple-darwin", std::env::consts::ARCH)
    } else {
        format!("{}-{}", std::env::consts::ARCH, std::env::consts::OS)
    }
}

fn handle(manager: &mut SessionManager, req: Request) -> Result<(), String> {
    match req {
        Request::Hello { protocol } => {
            if protocol != PROTOCOL_VERSION {
                write_error(
                    None,
                    "version_mismatch",
                    format!(
                        "unsupported protocol version {protocol}; this helper speaks {PROTOCOL_VERSION}"
                    ),
                );
                return Err("version_mismatch".to_string());
            }
            write_response(&Response::HelloAck {
                protocol: PROTOCOL_VERSION,
                helper_version: env!("CARGO_PKG_VERSION").to_string(),
                platform: platform_string(),
                pid: std::process::id(),
            });
            Ok(())
        }
        Request::Ping { id } => {
            write_response(&Response::Pong { id });
            Ok(())
        }
        Request::OpenEcho { id, cols, rows } => match manager.open_echo(cols, rows) {
            Ok(session_id) => {
                let pid = manager.child_pid(session_id).unwrap_or(0);
                write_response(&Response::SessionOpened {
                    id,
                    session_id,
                    cols,
                    rows,
                    pid: pid as u32,
                });
                Ok(())
            }
            Err(_) => {
                write_error(
                    Some(id),
                    "session_open_failed",
                    "could not open an echo session".to_string(),
                );
                Ok(())
            }
        },
        Request::SessionInput {
            id,
            session_id,
            data,
        } => match manager.write_input(session_id, &data) {
            Ok(()) => {
                write_response(&Response::SessionInputAck { id, session_id });
                Ok(())
            }
            Err(_) => {
                write_error(
                    Some(id),
                    "session_not_found",
                    format!("no echo session {session_id}"),
                );
                Ok(())
            }
        },
        Request::SessionResize {
            id,
            session_id,
            cols,
            rows,
        } => match manager.resize(session_id, cols, rows) {
            Ok((applied_cols, applied_rows)) => {
                write_response(&Response::SessionResized {
                    id,
                    session_id,
                    cols: applied_cols,
                    rows: applied_rows,
                });
                Ok(())
            }
            Err(_) => {
                write_error(
                    Some(id),
                    "session_not_found",
                    format!("no echo session {session_id}"),
                );
                Ok(())
            }
        },
        Request::SessionClose { id, session_id } => {
            if manager.close(session_id) {
                write_response(&Response::SessionClosed {
                    id: Some(id),
                    session_id,
                });
            } else {
                write_error(
                    Some(id),
                    "session_not_found",
                    format!("no echo session {session_id}"),
                );
            }
            Ok(())
        }
    }
}

/// Incremental reader over the helper's stdin: buffers whatever read(2)
/// returns and yields one full control frame at a time.
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
                return Err(format!("stdin read: {err}"));
            }
            if n == 0 {
                self.eof = true;
                return Ok(());
            }
            self.buf.extend_from_slice(&chunk[..n as usize]);
            return Ok(());
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
        if self.buf.len() < 4 + body_len {
            return Ok(None);
        }
        let frame: Vec<u8> = self.buf.drain(..4 + body_len).collect();
        if frame[4] != FRAME_KIND_CONTROL {
            return Err(format!("unexpected frame kind {}", frame[4]));
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

pub fn run() -> i32 {
    // Ignore SIGPIPE: a closed stdout must surface as a write error, not kill
    // the helper mid-cleanup.
    unsafe { libc::signal(libc::SIGPIPE, libc::SIG_IGN) };

    let (signal_rfd, signal_wfd) = make_pipe();
    SIGNAL_WRITE_FD.store(signal_wfd, Ordering::SeqCst);
    install_handler(libc::SIGTERM, on_signal);
    install_handler(libc::SIGINT, on_signal);
    install_handler(libc::SIGHUP, on_signal);
    install_handler(libc::SIGCHLD, on_signal);

    let mut manager = SessionManager::new();
    let mut reader = FrameReader::new();

    loop {
        if SHUTDOWN.load(Ordering::Relaxed) {
            break;
        }

        let session_fds = manager.fds();
        let mut fds: Vec<libc::pollfd> = Vec::with_capacity(2 + session_fds.len());
        fds.push(pollfd(0, libc::POLLIN));
        fds.push(pollfd(signal_rfd, libc::POLLIN));
        for (_, mfd) in &session_fds {
            fds.push(pollfd(*mfd, libc::POLLIN));
        }

        let r = unsafe { libc::poll(fds.as_mut_ptr(), fds.len() as libc::nfds_t, 50) };
        if r < 0 {
            let err = io::Error::last_os_error();
            if err.kind() == io::ErrorKind::Interrupted {
                continue;
            }
            break;
        }

        // Signal pipe: drain and honour the shutdown request.
        if fds[1].revents & (libc::POLLIN | libc::POLLHUP | libc::POLLERR) != 0 {
            let mut sink = [0u8; 64];
            loop {
                let n = unsafe { libc::read(signal_rfd, sink.as_mut_ptr() as *mut libc::c_void, sink.len()) };
                if n > 0 {
                    continue;
                }
                break;
            }
            SHUTDOWN.store(true, Ordering::SeqCst);
        }

        // Session PTYs: read output into the bounded pending buffers.
        let snapshot = manager.fds();
        for (i, (sid, _)) in snapshot.iter().enumerate() {
            let revents = fds[2 + i].revents;
            if revents & (libc::POLLIN | libc::POLLHUP | libc::POLLERR | libc::POLLNVAL) != 0 {
                let _ = manager.read_output(*sid);
            }
        }

        // Flush pending output as binary stream frames.
        for (session_id, seq, data) in manager.take_all_pending() {
            let _ = write_all(1, &protocol::encode_stream(session_id, seq, &data));
        }

        // Sessions whose child died (or PTY hit EOF) are gone: notify once.
        for session_id in manager.collect_finished() {
            write_response(&Response::SessionClosed {
                id: None,
                session_id,
            });
        }

        // stdin: EOF (POLLHUP) or a full frame.
        if fds[0].revents & (libc::POLLHUP | libc::POLLERR) != 0 {
            break;
        }
        if fds[0].revents & libc::POLLIN != 0 {
            if let Err(e) = reader.fill(0) {
                write_error(None, "read_failed", e);
                break;
            }
            loop {
                match reader.try_take() {
                    Ok(Some(req)) => {
                        if let Err(e) = handle(&mut manager, req) {
                            // A version mismatch stops the helper with a clear
                            // error frame already written by handle.
                            let _ = e;
                            SHUTDOWN.store(true, Ordering::SeqCst);
                            break;
                        }
                    }
                    Ok(None) => break,
                    Err(e) => {
                        write_error(None, "invalid_frame", e);
                        SHUTDOWN.store(true, Ordering::SeqCst);
                        break;
                    }
                }
            }
            if reader.eof {
                break;
            }
        }
    }

    manager.terminate_all();
    unsafe {
        libc::close(signal_rfd);
        libc::close(signal_wfd);
    }
    0
}
