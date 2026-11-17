//! Shared harness for the RDP process-model integration tests: drives the real
//! helper binary over stdio. Needs `--features test-hooks` and runs outside
//! the sandbox (PTYs, `lsof`, `ps`).
#![allow(dead_code)]
use std::io::{Read, Write};
use std::net::TcpListener;
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::time::{Duration, Instant};

use remote_hub_helper::protocol::{
    decode_response, encode_request, Request, Response, FRAME_KIND_CONTROL, FRAME_KIND_STREAM, PROTOCOL_VERSION,
};
use remote_hub_helper::secret::Secret;

pub struct Helper {
    pub child: Child,
    pub stdin: ChildStdin,
    pub stdout: ChildStdout,
    pub stderr_path: std::path::PathBuf,
}

pub fn tmp_path(name: &str) -> std::path::PathBuf {
    let dir = std::env::var("TMPDIR").unwrap_or_else(|_| "/tmp".to_string());
    std::path::Path::new(&dir).join(format!("rh-{}-{name}", std::process::id()))
}

pub fn start(env: &[(&str, &str)]) -> Helper {
    static COUNTER: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
    let n = COUNTER.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    let stderr_path = tmp_path(&format!("stderr-{n}.log"));
    let stderr = std::fs::File::create(&stderr_path).expect("stderr file");
    let mut command = Command::new(env!("CARGO_BIN_EXE_remote-hub-helper"));
    for (k, v) in env {
        command.env(k, v);
    }
    let mut child = command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::from(stderr))
        .spawn()
        .expect("spawn helper");
    let stdin = child.stdin.take().unwrap();
    let stdout = child.stdout.take().unwrap();
    let mut h = Helper { child, stdin, stdout, stderr_path };
    h.send(&Request::Hello { protocol: PROTOCOL_VERSION });
    match h.read_response() {
        Response::HelloAck { .. } => {}
        other => panic!("expected hello_ack, got {other:?}"),
    }
    h
}

impl Helper {
    pub fn pid(&self) -> u32 {
        self.child.id()
    }

    pub fn send(&mut self, req: &Request) {
        self.stdin.write_all(&encode_request(req)).expect("write request");
        self.stdin.flush().expect("flush");
    }

    pub fn read_frame(&mut self) -> (u8, Vec<u8>) {
        let mut header = [0u8; 4];
        self.stdout.read_exact(&mut header).expect("read header");
        let len = u32::from_le_bytes(header) as usize;
        let mut body = vec![0u8; len];
        self.stdout.read_exact(&mut body).expect("read body");
        (body[0], body[1..].to_vec())
    }

    /// The next control response (stream frames are skipped).
    pub fn read_response(&mut self) -> Response {
        loop {
            let (kind, payload) = self.read_frame();
            if kind == FRAME_KIND_CONTROL {
                return decode_response(&payload).expect("decode response");
            }
        }
    }

    /// Read frames until `pick` returns Some, or panic after `limit`.
    pub fn read_until<T>(&mut self, limit: Duration, mut pick: impl FnMut(u8, &[u8]) -> Option<T>) -> T {
        let deadline = Instant::now() + limit;
        // Blocking reads: a watchdog thread kills the helper if nothing arrives.
        loop {
            assert!(Instant::now() < deadline, "timed out waiting for a frame");
            let (kind, payload) = self.read_frame();
            if let Some(v) = pick(kind, &payload) {
                return v;
            }
        }
    }

    pub fn open_echo(&mut self) -> (u32, u32) {
        self.send(&Request::OpenEcho { id: 1, cols: 80, rows: 24 });
        match self.read_response() {
            Response::SessionOpened { session_id, pid, .. } => (session_id, pid),
            other => panic!("expected session.opened, got {other:?}"),
        }
    }

    pub fn open_rdp(&mut self, port: u16) -> (u32, u32) {
        self.open_rdp_sized(port, 800, 600)
    }

    pub fn open_rdp_sized(&mut self, port: u16, width: u32, height: u32) -> (u32, u32) {
        self.send(&Request::OpenRdp {
            id: 2,
            host: "127.0.0.1".to_string(),
            port,
            username: "tester".to_string(),
            password: Secret::new("S3cr3t-MARK-91"),
            domain: None,
            width,
            height,
            expected_fingerprint: None,
        });
        match self.read_until(Duration::from_secs(10), |k, p| {
            if k != FRAME_KIND_CONTROL {
                return None;
            }
            match decode_response(p).ok()? {
                r @ (Response::SessionOpened { .. } | Response::Error { .. }) => Some(r),
                _ => None,
            }
        }) {
            Response::SessionOpened { session_id, pid, kind, .. } => {
                assert_eq!(kind, "rdp");
                (session_id, pid)
            }
            other => panic!("expected session.opened, got {other:?}"),
        }
    }

    /// Echo `text` through an echo session and wait for it to come back.
    pub fn echo_round_trip(&mut self, sid: u32, text: &str) {
        self.send(&Request::SessionInput { id: 9, session_id: sid, data: text.to_string() });
        let mut got = String::new();
        self.read_until(Duration::from_secs(5), |k, p| {
            if k == FRAME_KIND_STREAM && u32::from_le_bytes(p[0..4].try_into().unwrap()) == sid {
                got.push_str(&String::from_utf8_lossy(&p[8..]));
                if got.contains(text) {
                    return Some(());
                }
            }
            None
        });
    }

    /// Wait for `session.closed` of `sid`: (exit_code, signal, reason).
    pub fn read_closed(&mut self, sid: u32) -> (Option<i32>, Option<i32>, String) {
        self.read_until(Duration::from_secs(10), |k, p| {
            if k != FRAME_KIND_CONTROL {
                return None;
            }
            match decode_response(p).ok()? {
                Response::SessionClosed { session_id, exit_code, signal, reason, .. } if session_id == sid => {
                    Some((exit_code, signal, reason))
                }
                _ => None,
            }
        })
    }

    pub fn stderr_text(&self) -> String {
        std::fs::read_to_string(&self.stderr_path).unwrap_or_default()
    }

    pub fn shutdown(mut self) {
        drop(self.stdin);
        let start = Instant::now();
        while start.elapsed() < Duration::from_secs(5) {
            if self.child.try_wait().unwrap().is_some() {
                return;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// A TCP listener that accepts and never answers: an RDP engine connecting to
/// it stays in `connecting`.
pub struct SilentServer {
    pub port: u16,
    _thread: std::thread::JoinHandle<()>,
}

pub fn silent_server() -> SilentServer {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let t = std::thread::spawn(move || {
        let mut held = Vec::new();
        while let Ok((s, _)) = listener.accept() {
            held.push(s);
        }
    });
    SilentServer { port, _thread: t }
}

/// A port nothing listens on (connection refused).
pub fn closed_port() -> u16 {
    let l = TcpListener::bind("127.0.0.1:0").unwrap();
    let p = l.local_addr().unwrap().port();
    drop(l);
    p
}

pub fn pid_alive(pid: u32) -> bool {
    unsafe { libc::kill(pid as libc::pid_t, 0) == 0 }
}

pub fn wait_pid_gone(pid: u32, limit: Duration) -> bool {
    let start = Instant::now();
    while start.elapsed() < limit {
        if !pid_alive(pid) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    false
}

pub fn cpu_seconds(pid: u32) -> f64 {
    let out = Command::new("ps").args(["-p", &pid.to_string(), "-o", "time="]).output().expect("spawn ps");
    assert!(out.status.success(), "ps failed: {}", String::from_utf8_lossy(&out.stderr));
    let s = String::from_utf8(out.stdout).unwrap();
    let parts: Vec<&str> = s.trim().split(':').collect();
    assert!(parts.len() >= 2, "malformed ps time output: {s:?}");
    parts[0].trim().parse::<f64>().unwrap() * 60.0 + parts[1].trim().parse::<f64>().unwrap()
}

pub fn rss_kb(pid: u32) -> i64 {
    let out = Command::new("ps").args(["-p", &pid.to_string(), "-o", "rss="]).output().expect("spawn ps");
    assert!(out.status.success());
    String::from_utf8(out.stdout).unwrap().trim().parse().unwrap()
}

/// (fd number, type, name) rows of `lsof -p`, numeric fds only.
pub fn lsof_fds(pid: u32) -> Vec<(i32, String, String)> {
    let out = Command::new("lsof").args(["-p", &pid.to_string(), "-F", "ftn"]).output().expect("lsof");
    let text = String::from_utf8_lossy(&out.stdout).to_string();
    let mut rows = Vec::new();
    let (mut fd, mut ty, mut name): (Option<i32>, String, String) = (None, String::new(), String::new());
    for line in text.lines() {
        let (tag, rest) = line.split_at(1);
        match tag {
            "f" => {
                if let Some(n) = fd.take() {
                    rows.push((n, std::mem::take(&mut ty), std::mem::take(&mut name)));
                }
                fd = rest.trim_end_matches(|c: char| c.is_ascii_alphabetic()).parse().ok();
                ty.clear();
                name.clear();
            }
            "t" => ty = rest.to_string(),
            "n" => name = rest.to_string(),
            _ => {}
        }
    }
    if let Some(n) = fd {
        rows.push((n, ty, name));
    }
    rows
}

/// One RDP update chunk as it arrives on the wire.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UpdateChunk {
    pub frame_id: u64,
    pub x: u32,
    pub y: u32,
    pub w: u32,
    pub h: u32,
    /// Bytes on the wire: length prefix, kind, stream header, update header, pixels.
    pub wire_len: usize,
}

pub fn parse_update_chunk(payload: &[u8]) -> UpdateChunk {
    // stream header: sessionId u32, seq u32; update header: frameId u64,
    // fbW, fbH, x, y, w, h (u32 each); then RGBA rows.
    let u32_at = |i: usize| u32::from_le_bytes(payload[i..i + 4].try_into().unwrap());
    UpdateChunk {
        frame_id: u64::from_le_bytes(payload[8..16].try_into().unwrap()),
        x: u32_at(24),
        y: u32_at(28),
        w: u32_at(32),
        h: u32_at(36),
        wire_len: 4 + 1 + payload.len(),
    }
}

/// Frames read by a background thread. Update frames of `rdp_sid` are parsed
/// into `updates` (pixels dropped); everything else is forwarded in `frames`.
pub struct FrameRx {
    pub frames: std::sync::mpsc::Receiver<(u8, Vec<u8>)>,
    pub updates: std::sync::mpsc::Receiver<UpdateChunk>,
}

impl Helper {
    /// Move stdout into a reader thread (stdin stays usable for requests).
    pub fn frames_in_background(&mut self, rdp_sid: u32) -> FrameRx {
        let mut stdout = self.stdout.try_clone_for_thread();
        let (ftx, frames) = std::sync::mpsc::channel();
        let (utx, updates) = std::sync::mpsc::channel();
        std::thread::spawn(move || loop {
            let mut header = [0u8; 4];
            if stdout.read_exact(&mut header).is_err() {
                return;
            }
            let mut body = vec![0u8; u32::from_le_bytes(header) as usize];
            if stdout.read_exact(&mut body).is_err() {
                return;
            }
            let (kind, payload) = (body[0], body[1..].to_vec());
            if kind == FRAME_KIND_STREAM && u32::from_le_bytes(payload[0..4].try_into().unwrap()) == rdp_sid {
                if utx.send(parse_update_chunk(&payload)).is_err() {
                    return;
                }
            } else if ftx.send((kind, payload)).is_err() {
                return;
            }
        });
        FrameRx { frames, updates }
    }
}

trait CloneForThread {
    fn try_clone_for_thread(&self) -> std::fs::File;
}

impl CloneForThread for ChildStdout {
    fn try_clone_for_thread(&self) -> std::fs::File {
        use std::os::fd::{AsRawFd, FromRawFd};
        let fd = unsafe { libc::dup(self.as_raw_fd()) };
        assert!(fd >= 0, "dup stdout");
        unsafe { std::fs::File::from_raw_fd(fd) }
    }
}
