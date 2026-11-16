//! Integration tests that drive the real helper binary over stdio: version
//! handshake, echo round trip with resize, stdin-EOF lifecycle cleanup, and the
//! stage-1 repair regressions (signal separation, bounded non-blocking IO,
//! invalid frames, fd hygiene, output draining and child-visible resize).
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
    start_with_args(&[])
}

fn start_with_args(args: &[&str]) -> Helper {
    let mut command = Command::new(env!("CARGO_BIN_EXE_remote-hub-helper"));
    if !args.is_empty() {
        command.args(args);
    }
    let mut child = command
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

    fn send_raw(&mut self, bytes: &[u8]) {
        self.stdin.write_all(bytes).expect("write raw");
        self.stdin.flush().expect("flush raw");
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

    fn hello(&mut self) {
        self.send(&Request::Hello {
            protocol: PROTOCOL_VERSION,
        });
        match self.read_response() {
            Response::HelloAck { protocol, .. } => assert_eq!(protocol, PROTOCOL_VERSION),
            other => panic!("expected hello_ack, got {other:?}"),
        }
    }

    fn open(&mut self) -> (u32, u32) {
        self.send(&Request::OpenEcho {
            id: 100,
            cols: 80,
            rows: 24,
        });
        match self.read_response() {
            Response::SessionOpened {
                session_id, pid, ..
            } => (session_id, pid),
            other => panic!("expected session.opened, got {other:?}"),
        }
    }

    fn read_until_stream_contains(&mut self, sid: u32, needle: &str) -> String {
        let mut got = String::new();
        for _ in 0..400 {
            let (kind, payload) = self.read_frame();
            if kind == FRAME_KIND_STREAM {
                let rsid = u32::from_le_bytes(payload[0..4].try_into().unwrap());
                if rsid == sid {
                    got.push_str(&String::from_utf8_lossy(&payload[8..]));
                    if got.contains(needle) {
                        return got;
                    }
                }
            }
        }
        got
    }

    fn read_until_closed(&mut self, sid: u32) {
        for _ in 0..400 {
            let (kind, payload) = self.read_frame();
            if kind == FRAME_KIND_CONTROL {
                if let Response::SessionClosed { session_id, .. } = decode_response(&payload).unwrap() {
                    assert_eq!(session_id, sid);
                    return;
                }
            }
        }
        panic!("session.closed never arrived for {sid}");
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
    helper.hello();

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
        data: "héllo
".to_string(),
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
    helper.hello();

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

// R9: requests before the version handshake are refused, but the helper stays up.
#[test]
fn r9_requests_before_hello_are_refused() {
    let mut helper = start();
    helper.send(&Request::Ping { id: 1 });
    match helper.read_response() {
        Response::Error { code, .. } => assert_eq!(code, "handshake_required"),
        other => panic!("expected handshake_required, got {other:?}"),
    }
    helper.hello();
    helper.send(&Request::Ping { id: 2 });
    match helper.read_response() {
        Response::Pong { id } => assert_eq!(id, 2),
        other => panic!("expected pong, got {other:?}"),
    }
}

// R1(a): closing one session does not shut the helper down.
#[test]
fn r1_closing_one_session_keeps_others_alive() {
    let mut helper = start();
    helper.hello();
    let (a_id, a_pid) = helper.open();
    let (b_id, _b_pid) = helper.open();

    helper.send(&Request::SessionClose { id: 10, session_id: a_id });
    match helper.read_response() {
        Response::SessionClosed { .. } => {}
        other => panic!("expected session.closed, got {other:?}"),
    }
    assert!(!pid_alive(a_pid), "A child {a_pid} still alive after close");

    helper.send(&Request::Ping { id: 42 });
    match helper.read_response() {
        Response::Pong { id } => assert_eq!(id, 42),
        other => panic!("expected pong 42, got {other:?}"),
    }

    helper.send(&Request::SessionInput {
        id: 11,
        session_id: b_id,
        data: "still-alive
".to_string(),
    });
    match helper.read_response() {
        Response::SessionInputAck { .. } => {}
        other => panic!("expected session.input_ack, got {other:?}"),
    }
    let echoed = helper.read_until_stream_contains(b_id, "still-alive");
    assert!(echoed.contains("still-alive"), "{echoed:?}");
}

// R1(b): a child that exits by itself yields an unsolicited session.closed and
// the helper keeps answering.
#[test]
fn r1_child_exit_is_unsolicited_closed_and_helper_survives() {
    let mut helper = start_with_args(&["--echo-command", "/usr/bin/true"]);
    helper.hello();
    let (sid, _pid) = helper.open();
    helper.read_until_closed(sid);
    helper.send(&Request::Ping { id: 7 });
    match helper.read_response() {
        Response::Pong { id } => assert_eq!(id, 7),
        other => panic!("expected pong 7, got {other:?}"),
    }
}

// R2: a 200001-byte input echoes exactly, in order, with consecutive sequence
// numbers, and stdin close tears everything down within 5 s.
#[test]
fn r2_large_input_echoes_in_order_and_shutdown_clean() {
    let mut helper = start();
    helper.hello();
    let (sid, pid) = helper.open();

    let payload = format!("{}
", "x".repeat(200_000));
    helper.send(&Request::SessionInput {
        id: 1,
        session_id: sid,
        data: payload,
    });
    match helper.read_response() {
        Response::SessionInputAck { .. } => {}
        other => panic!("expected session.input_ack, got {other:?}"),
    }

    let mut received: Vec<u8> = Vec::new();
    let mut last_seq: Option<u32> = None;
    while received.len() < 200_001 {
        let (rsid, seq, data) = helper.read_stream();
        assert_eq!(rsid, sid);
        match last_seq {
            None => assert_eq!(seq, 0, "first sequence number must be 0"),
            Some(prev) => assert_eq!(seq, prev + 1, "sequence numbers must be consecutive"),
        }
        last_seq = Some(seq);
        received.extend_from_slice(&data);
    }
    assert_eq!(received.len(), 200_001);

    drop(helper.stdin);
    let status = wait_timeout(&mut helper.child, Duration::from_secs(5))
        .expect("helper did not exit within 5s of stdin close");
    assert_eq!(status.code(), Some(0));
    assert!(!pid_alive(pid), "child {pid} still alive after helper exit");
}

// R3: a zero-length frame is rejected with invalid_frame and every child is
// reaped on the way out.
#[test]
fn r3_zero_length_frame_shuts_down_cleanly() {
    let mut helper = start();
    helper.hello();
    let (_a, a_pid) = helper.open();
    let (_b, b_pid) = helper.open();

    helper.send_raw(&[0, 0, 0, 0]);
    match helper.read_response() {
        Response::Error { code, .. } => assert_eq!(code, "invalid_frame"),
        other => panic!("expected invalid_frame, got {other:?}"),
    }
    let status = wait_timeout(&mut helper.child, Duration::from_secs(5))
        .expect("helper did not exit after invalid frame");
    assert_eq!(status.code(), Some(0));
    assert!(!pid_alive(a_pid), "A child {a_pid} still alive");
    assert!(!pid_alive(b_pid), "B child {b_pid} still alive");
}

// R6: closing one session's child does not disturb a second session.
#[test]
fn r6_closing_one_session_does_not_disturb_another() {
    let mut helper = start();
    helper.hello();
    let (a_id, a_pid) = helper.open();
    let (b_id, _b_pid) = helper.open();

    helper.send(&Request::SessionClose { id: 1, session_id: a_id });
    match helper.read_response() {
        Response::SessionClosed { .. } => {}
        other => panic!("expected session.closed, got {other:?}"),
    }
    assert!(!pid_alive(a_pid), "A child {a_pid} still alive");

    helper.send(&Request::SessionInput {
        id: 2,
        session_id: b_id,
        data: "b-still-works
".to_string(),
    });
    match helper.read_response() {
        Response::SessionInputAck { .. } => {}
        other => panic!("expected session.input_ack, got {other:?}"),
    }
    let echoed = helper.read_until_stream_contains(b_id, "b-still-works");
    assert!(echoed.contains("b-still-works"), "{echoed:?}");
}

// R7: a child that prints 100000 bytes and exits has its output fully drained
// before the unsolicited session.closed.
#[test]
fn r7_child_output_is_drained_before_closed() {
    let script = "awk 'BEGIN{for(i=0;i<100000;i++)printf \"x\"}'";
    let mut helper = start_with_args(&["--echo-command", "/bin/sh", "-c", script]);
    helper.hello();
    let (sid, _pid) = helper.open();

    let mut received: Vec<u8> = Vec::new();
    let mut closed = false;
    for _ in 0..400 {
        let (kind, payload) = helper.read_frame();
        if kind == FRAME_KIND_STREAM {
            let rsid = u32::from_le_bytes(payload[0..4].try_into().unwrap());
            if rsid == sid {
                received.extend_from_slice(&payload[8..]);
            }
        } else if kind == FRAME_KIND_CONTROL {
            if let Response::SessionClosed { session_id, .. } = decode_response(&payload).unwrap() {
                assert_eq!(session_id, sid);
                closed = true;
                break;
            }
        }
    }
    assert!(closed, "session.closed never arrived for {sid}");
    assert_eq!(received.len(), 100_000, "expected exactly 100000 bytes before closed");
}

// R11: a resize is visible to the child (stty size prints 30 100).
#[test]
fn r11_resize_is_visible_to_the_child() {
    let mut helper = start_with_args(&["--echo-command", "/bin/sh", "-c", "read x; stty size"]);
    helper.hello();
    let (sid, _pid) = helper.open();

    helper.send(&Request::SessionResize {
        id: 1,
        session_id: sid,
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

    helper.send(&Request::SessionInput {
        id: 2,
        session_id: sid,
        data: "
".to_string(),
    });
    match helper.read_response() {
        Response::SessionInputAck { .. } => {}
        other => panic!("expected session.input_ack, got {other:?}"),
    }
    let echoed = helper.read_until_stream_contains(sid, "30 100");
    assert!(echoed.contains("30 100"), "child did not see 30 100: {echoed:?}");
}
