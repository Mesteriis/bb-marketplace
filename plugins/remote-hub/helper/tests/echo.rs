//! Integration tests that drive the real helper binary over stdio: version
//! handshake, echo round trip with resize, and stdin-EOF lifecycle cleanup.
use std::io::{Read, Write};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::time::{Duration, Instant};

use remote_hub_helper::protocol::{
    decode_response, encode_request, Request, Response, FRAME_KIND_CONTROL, FRAME_KIND_STREAM,
    PROTOCOL_VERSION,
};

struct Helper {
    child: Child,
    stdin: ChildStdin,
    stdout: ChildStdout,
}

fn start() -> Helper {
    let mut child = Command::new(env!("CARGO_BIN_EXE_remote-hub-helper"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .expect("spawn helper");
    let stdin = child.stdin.take().expect("helper stdin");
    let stdout = child.stdout.take().expect("helper stdout");
    Helper {
        child,
        stdin,
        stdout,
    }
}

impl Helper {
    fn send(&mut self, req: &Request) {
        self.stdin.write_all(&encode_request(req)).expect("write request");
        self.stdin.flush().expect("flush request");
    }

    fn read_frame(&mut self) -> (u8, Vec<u8>) {
        let mut header = [0u8; 4];
        self.stdout.read_exact(&mut header).expect("read header");
        let len = u32::from_le_bytes(header) as usize;
        let mut body = vec![0u8; len];
        self.stdout.read_exact(&mut body).expect("read body");
        (body[0], body[1..].to_vec())
    }

    fn read_response(&mut self) -> Response {
        loop {
            let (kind, payload) = self.read_frame();
            if kind == FRAME_KIND_CONTROL {
                return decode_response(&payload).expect("decode response");
            }
        }
    }

    fn read_stream(&mut self) -> (u32, u32, Vec<u8>) {
        loop {
            let (kind, payload) = self.read_frame();
            if kind == FRAME_KIND_STREAM {
                let session_id = u32::from_le_bytes(payload[0..4].try_into().unwrap());
                let seq = u32::from_le_bytes(payload[4..8].try_into().unwrap());
                return (session_id, seq, payload[8..].to_vec());
            }
        }
    }
}

fn wait_timeout(child: &mut Child, timeout: Duration) -> Option<std::process::ExitStatus> {
    let start = Instant::now();
    loop {
        if let Some(status) = child.try_wait().expect("try_wait") {
            return Some(status);
        }
        if start.elapsed() > timeout {
            return None;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

fn pid_alive(pid: u32) -> bool {
    unsafe { libc::kill(pid as libc::pid_t, 0) == 0 }
}

#[test]
fn version_mismatch_answers_error_and_exits() {
    let mut helper = start();
    helper.send(&Request::Hello {
        protocol: PROTOCOL_VERSION + 100,
    });
    match helper.read_response() {
        Response::Error { code, .. } => assert_eq!(code, "version_mismatch"),
        other => panic!("expected version_mismatch error, got {other:?}"),
    }
    let status = wait_timeout(&mut helper.child, Duration::from_secs(2));
    assert!(status.is_some(), "helper did not exit after version mismatch");
}

#[test]
fn echo_round_trip_resize_and_close() {
    let mut helper = start();
    helper.send(&Request::Hello {
        protocol: PROTOCOL_VERSION,
    });
    match helper.read_response() {
        Response::HelloAck { protocol, .. } => assert_eq!(protocol, PROTOCOL_VERSION),
        other => panic!("expected hello_ack, got {other:?}"),
    }

    helper.send(&Request::OpenEcho {
        id: 1,
        cols: 80,
        rows: 24,
    });
    let (session_id, child_pid) = match helper.read_response() {
        Response::SessionOpened {
            session_id, pid, ..
        } => (session_id, pid),
        other => panic!("expected session.opened, got {other:?}"),
    };

    helper.send(&Request::SessionInput {
        id: 2,
        session_id,
        data: "héllo\n".to_string(),
    });
    match helper.read_response() {
        Response::SessionInputAck { .. } => {}
        other => panic!("expected session.input_ack, got {other:?}"),
    }

    let mut echoed = String::new();
    for _ in 0..20 {
        let (stream_id, _seq, data) = helper.read_stream();
        assert_eq!(stream_id, session_id);
        echoed.push_str(&String::from_utf8_lossy(&data));
        if echoed.contains("héllo") {
            break;
        }
    }
    assert!(echoed.contains("héllo"), "echoed bytes missing héllo: {echoed:?}");

    helper.send(&Request::SessionResize {
        id: 3,
        session_id,
        cols: 100,
        rows: 30,
    });
    match helper.read_response() {
        Response::SessionResized { cols, rows, .. } => {
            assert_eq!(cols, 100);
            assert_eq!(rows, 30);
        }
        other => panic!("expected session.resized, got {other:?}"),
    }

    helper.send(&Request::SessionClose {
        id: 4,
        session_id,
    });
    match helper.read_response() {
        Response::SessionClosed { .. } => {}
        other => panic!("expected session.closed, got {other:?}"),
    }
    assert!(
        !pid_alive(child_pid),
        "child pid {child_pid} still alive after close"
    );
}

#[test]
fn lifecycle_closing_stdin_reaps_every_child() {
    let mut helper = start();
    helper.send(&Request::Hello {
        protocol: PROTOCOL_VERSION,
    });
    match helper.read_response() {
        Response::HelloAck { .. } => {}
        other => panic!("expected hello_ack, got {other:?}"),
    }

    let mut pids = Vec::new();
    for i in 0..2u64 {
        helper.send(&Request::OpenEcho {
            id: 10 + i,
            cols: 80,
            rows: 24,
        });
        match helper.read_response() {
            Response::SessionOpened { pid, .. } => pids.push(pid),
            other => panic!("expected session.opened, got {other:?}"),
        }
    }
    assert_eq!(pids.len(), 2);

    drop(helper.stdin);

    let status = wait_timeout(&mut helper.child, Duration::from_secs(5));
    let status = status.expect("helper did not exit within 5s of stdin close");
    assert_eq!(status.code(), Some(0));
    for pid in pids {
        assert!(!pid_alive(pid), "child pid {pid} still alive after helper exit");
    }
}
