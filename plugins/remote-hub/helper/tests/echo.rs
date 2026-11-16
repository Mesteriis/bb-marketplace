//! Integration tests that drive the real helper binary over stdio: version
//! handshake, echo round trip with resize, stdin-EOF lifecycle cleanup, and the
//! stage-1 repair regressions (signal separation, bounded non-blocking IO,
//! invalid frames, fd hygiene, output draining and child-visible resize).
use std::collections::HashMap;
use std::io::{Read, Write};
use std::os::fd::AsRawFd;
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use remote_hub_helper::protocol::{
    decode_response, encode_request, encode_stream, Request, Response, FRAME_KIND_CONTROL,
    FRAME_KIND_STREAM, PROTOCOL_VERSION,
};

struct Helper {
    child: Child,
    stdin: ChildStdin,
    stdout: ChildStdout,
    seq: u32,
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
        seq: 0,
    }
}

fn send_req(stdin: &mut ChildStdin, req: &Request) {
    stdin.write_all(&encode_request(req)).expect("write request");
    stdin.flush().expect("flush request");
}

fn read_until_stream_contains_io(stdout: &mut ChildStdout, sid: u32, needle: &str) -> String {
    let mut got = String::new();
    for _ in 0..400 {
        let (kind, payload) = read_frame_io(stdout);
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

fn read_frame_io(stdout: &mut ChildStdout) -> (u8, Vec<u8>) {
    let mut header = [0u8; 4];
    stdout.read_exact(&mut header).expect("read header");
    let len = u32::from_le_bytes(header) as usize;
    let mut body = vec![0u8; len];
    stdout.read_exact(&mut body).expect("read body");
    (body[0], body[1..].to_vec())
}

impl Helper {
    fn send(&mut self, req: &Request) {
        send_req(&mut self.stdin, req);
    }

    fn send_raw(&mut self, bytes: &[u8]) {
        self.stdin.write_all(bytes).expect("write raw");
        self.stdin.flush().expect("flush raw");
    }

    fn send_stream(&mut self, session_id: u32, data: &[u8]) {
        let frame = encode_stream(session_id, self.seq, data);
        self.seq = self.seq.wrapping_add(1);
        self.stdin.write_all(&frame).expect("write stream frame");
        self.stdin.flush().expect("flush stream frame");
    }

    fn read_frame(&mut self) -> (u8, Vec<u8>) {
        read_frame_io(&mut self.stdout)
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

    fn read_until_closed_status(&mut self, sid: u32) -> (Option<i32>, Option<i32>, String) {
        for _ in 0..400 {
            let (kind, payload) = self.read_frame();
            if kind == FRAME_KIND_CONTROL {
                if let Response::SessionClosed {
                    session_id,
                    exit_code,
                    signal,
                    reason,
                    ..
                } = decode_response(&payload).unwrap()
                {
                    assert_eq!(session_id, sid);
                    return (exit_code, signal, reason);
                }
            }
        }
        panic!("session.closed never arrived for {sid}");
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

/// Cumulative CPU seconds of a process, from ps -o time=. Panics if ps fails
/// or the output is malformed, so a failed measurement can never read as 0.
fn cpu_seconds(pid: u32) -> f64 {
    let out = Command::new("ps")
        .args(["-p", &pid.to_string(), "-o", "time="])
        .output()
        .expect("spawn ps");
    assert!(
        out.status.success(),
        "ps failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    let s = String::from_utf8(out.stdout).expect("ps output is utf8");
    let s = s.trim();
    let parts: Vec<&str> = s.split(':').collect();
    assert!(parts.len() >= 2, "malformed ps time output: {s:?}");
    let min: f64 = parts[0].trim().parse().expect("ps minutes");
    let sec: f64 = parts[1].trim().parse().expect("ps seconds");
    min * 60.0 + sec
}

/// Resident set size in KiB, from ps -o rss=. Panics on a failed measurement.
fn rss_kb(pid: u32) -> i64 {
    let out = Command::new("ps")
        .args(["-p", &pid.to_string(), "-o", "rss="])
        .output()
        .expect("spawn ps");
    assert!(
        out.status.success(),
        "ps failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    let s = String::from_utf8(out.stdout).expect("ps output is utf8");
    s.trim().parse().expect("ps rss")
}

/// The numeric fds a process has open, from lsof -p.
fn child_fds(pid: u32) -> Vec<i32> {
    let out = Command::new("lsof")
        .args(["-p", &pid.to_string()])
        .output()
        .expect("lsof");
    let text = String::from_utf8_lossy(&out.stdout);
    let mut fds = Vec::new();
    for line in text.lines().skip(1) {
        let cols: Vec<&str> = line.split_whitespace().collect();
        if cols.len() >= 4 {
            let fd = cols[3];
            let first = fd.chars().next().unwrap_or(' ');
            if first.is_ascii_digit() {
                let digits: String = fd.chars().take_while(|c| c.is_ascii_digit()).collect();
                if let Ok(n) = digits.parse::<i32>() {
                    fds.push(n);
                }
            }
        }
    }
    fds.sort_unstable();
    fds.dedup();
    fds
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
        data: "still-alive\n".to_string(),
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

// R2: a 200001-byte input echoes back exactly (contents, in order, consecutive
// sequence numbers), and stdin close tears everything down within 5 s.
#[test]
fn r2_large_input_echoes_in_order_and_shutdown_clean() {
    let mut helper = start();
    helper.hello();
    let (sid, pid) = helper.open();

    let payload = format!("{}\n", "x".repeat(200_000));
    helper.send(&Request::SessionInput {
        id: 1,
        session_id: sid,
        data: payload.clone(),
    });
    match helper.read_response() {
        Response::SessionInputAck { .. } => {}
        other => panic!("expected session.input_ack, got {other:?}"),
    }

    let expected = payload.into_bytes();
    let mut received: Vec<u8> = Vec::new();
    let mut last_seq: Option<u32> = None;
    while received.len() < expected.len() {
        let (rsid, seq, data) = helper.read_stream();
        assert_eq!(rsid, sid);
        match last_seq {
            None => assert_eq!(seq, 0, "first sequence number must be 0"),
            Some(prev) => assert_eq!(seq, prev + 1, "sequence numbers must be consecutive"),
        }
        last_seq = Some(seq);
        received.extend_from_slice(&data);
    }
    assert_eq!(received, expected);

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
        data: "b-still-works\n".to_string(),
    });
    match helper.read_response() {
        Response::SessionInputAck { .. } => {}
        other => panic!("expected session.input_ack, got {other:?}"),
    }
    let echoed = helper.read_until_stream_contains(b_id, "b-still-works");
    assert!(echoed.contains("b-still-works"), "{echoed:?}");
}

// R7: a child that prints 100000 bytes and exits has its output fully drained
// (exact contents) before the unsolicited session.closed.
#[test]
fn r7_child_output_is_drained_before_closed() {
    let script = "awk 'BEGIN{for(i=0;i<100000;i++)printf \"x\"}'";
    let mut helper = start_with_args(&["--echo-command", "/bin/sh", "-c", script]);
    helper.hello();
    let (sid, _pid) = helper.open();

    let literal = "x".repeat(100_000).into_bytes();
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
    assert_eq!(received, literal, "exact contents must arrive before closed");
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
        data: "\n".to_string(),
    });
    match helper.read_response() {
        Response::SessionInputAck { .. } => {}
        other => panic!("expected session.input_ack, got {other:?}"),
    }
    let echoed = helper.read_until_stream_contains(sid, "30 100");
    assert!(echoed.contains("30 100"), "child did not see 30 100: {echoed:?}");
}

// S1: under stdout backpressure the helper sleeps in poll instead of busy
// looping, and SIGTERM still tears everything down.
#[test]
fn s1_backpressure_does_not_busy_loop() {
    let mut helper = start_with_args(&["--echo-command", "/usr/bin/yes"]);
    helper.hello();
    let (_sid, pid) = helper.open();
    let helper_pid = helper.child.id();
    std::thread::sleep(Duration::from_millis(300));
    let t0 = cpu_seconds(helper_pid);
    std::thread::sleep(Duration::from_secs(2));
    let t1 = cpu_seconds(helper_pid);
    let cpu = t1 - t0;
    assert!(cpu < 0.5, "helper busy-looped: {cpu} s CPU over 2 s");
    unsafe { libc::kill(helper_pid as libc::pid_t, libc::SIGTERM) };
    let status = wait_timeout(&mut helper.child, Duration::from_secs(5))
        .expect("helper did not exit after SIGTERM");
    assert_eq!(status.code(), Some(0));
    assert!(!pid_alive(pid), "child {pid} still alive");
}

// S2: a control-frame flood is bounded in memory; every ping is answered in
// order with the matching id.
#[test]
fn s2_bounded_under_control_flood() {
    let Helper {
        child,
        mut stdin,
        mut stdout,
        ..
    } = start();

    send_req(&mut stdin, &Request::Hello {
        protocol: PROTOCOL_VERSION,
    });
    match decode_response(&read_frame_io(&mut stdout).1).unwrap() {
        Response::HelloAck { .. } => {}
        other => panic!("expected hello_ack, got {other:?}"),
    }

    let helper_pid = child.id();
    let writer = std::thread::spawn(move || {
        for i in 0u64..200_000 {
            send_req(&mut stdin, &Request::Ping { id: i });
        }
    });

    // Let the writer flood the helper, then sample RSS while stdout is unread.
    std::thread::sleep(Duration::from_millis(600));
    let rss = rss_kb(helper_pid);
    assert!(rss < 64 * 1024, "helper RSS {rss} KiB exceeds 64 MiB");

    let mut pongs = Vec::new();
    while pongs.len() < 200_000 {
        let (kind, payload) = read_frame_io(&mut stdout);
        if kind == FRAME_KIND_CONTROL {
            if let Response::Pong { id } = decode_response(&payload).unwrap() {
                pongs.push(id);
            }
        }
    }
    writer.join().unwrap();
    assert_eq!(pongs.len(), 200_000);
    for (i, id) in pongs.iter().enumerate() {
        assert_eq!(*id, i as u64, "pong order must match ping order");
    }
}

// S3: explicit close emits already-read output plus the drained tail, with
// consecutive sequence numbers, before session.closed.
#[test]
fn s3_close_emits_queued_output_before_closed() {
    let script = "awk 'BEGIN{for(i=0;i<786432;i++)printf \"%08d\", i}'; sleep 30";
    let mut helper = start_with_args(&["--echo-command", "/bin/sh", "-c", script]);
    helper.hello();
    let (sid, pid) = helper.open();
    std::thread::sleep(Duration::from_millis(400));

    helper.send(&Request::SessionClose { id: 1, session_id: sid });

    let literal: String = (0..786432).map(|i| format!("{i:08}")).collect();
    let literal = literal.into_bytes();
    let mut bytes: Vec<u8> = Vec::new();
    let mut seqs: Vec<u32> = Vec::new();
    let mut closed = false;
    for _ in 0..20_000 {
        let (kind, payload) = helper.read_frame();
        if kind == FRAME_KIND_STREAM {
            let rsid = u32::from_le_bytes(payload[0..4].try_into().unwrap());
            if rsid == sid {
                let seq = u32::from_le_bytes(payload[4..8].try_into().unwrap());
                seqs.push(seq);
                bytes.extend_from_slice(&payload[8..]);
            }
        } else if kind == FRAME_KIND_CONTROL {
            if let Response::SessionClosed { session_id, .. } = decode_response(&payload).unwrap() {
                assert_eq!(session_id, sid);
                closed = true;
                break;
            }
        }
    }
    assert!(closed, "session.closed never arrived");
    assert!(!bytes.is_empty(), "no stream bytes received");
    // A prefix of the literal payload with no gap.
    assert!(bytes.len() <= literal.len());
    assert_eq!(bytes, literal[..bytes.len()]);
    for w in seqs.windows(2) {
        assert_eq!(w[1], w[0] + 1, "sequence numbers must be consecutive");
    }
    assert!(!pid_alive(pid), "child {pid} still alive");
}

// S4(a): a live child whose tty is closed is terminated and reaped, then
// session.closed arrives.
#[test]
fn s4a_live_child_with_closed_tty_is_reaped() {
    let mut helper = start_with_args(&[
        "--echo-command",
        "/bin/sh",
        "-c",
        "exec >/dev/null 2>&1 </dev/null; sleep 30",
    ]);
    helper.hello();
    let (sid, pid) = helper.open();
    helper.read_until_closed(sid);
    assert!(!pid_alive(pid), "child {pid} still alive");
}

// S9: a sibling session's child does not inherit the other session's master or
// the signal pipe (only fds 0,1,2 remain after exec).
#[test]
fn s9_child_does_not_inherit_sibling_fds() {
    let mut helper = start();
    helper.hello();
    let (_a_id, _a_pid) = helper.open();
    let (_b_id, b_pid) = helper.open();
    std::thread::sleep(Duration::from_millis(300));
    let fds = child_fds(b_pid);
    assert_eq!(fds, vec![0, 1, 2], "B's child inherited unexpected fds: {fds:?}");
}

// Stage-1 repair 3 regression: many concurrent sessions across many helpers
// all open, echo their own literal line, and are all reaped on shutdown.
#[test]
fn s5_concurrent_sessions_across_helpers() {
    let handles: Vec<_> = (0..8)
        .map(|_| {
            std::thread::spawn(|| {
                let mut h = start();
                h.hello();
                let mut sessions = Vec::new();
                for _ in 0..8 {
                    h.send(&Request::OpenEcho {
                        id: 100,
                        cols: 80,
                        rows: 24,
                    });
                    match h.read_response() {
                        Response::SessionOpened {
                            session_id, pid, ..
                        } => sessions.push((session_id, pid)),
                        other => panic!("expected session.opened, got {other:?}"),
                    }
                }
                (h, sessions)
            })
        })
        .collect();

    let mut helpers: Vec<Helper> = Vec::new();
    let mut sessions: Vec<(usize, u32, u32)> = Vec::new(); // (helper index, session id, child pid)
    for (hi, handle) in handles.into_iter().enumerate() {
        let (h, ss) = handle.join().expect("helper thread joined");
        helpers.push(h);
        for (sid, pid) in ss {
            sessions.push((hi, sid, pid));
        }
    }
    assert_eq!(sessions.len(), 64);

    for (n, (hi, sid, _pid)) in sessions.iter().enumerate() {
        let line = format!("s-{n}\n");
        helpers[*hi].send(&Request::SessionInput {
            id: 200 + n as u64,
            session_id: *sid,
            data: line.clone(),
        });
        match helpers[*hi].read_response() {
            Response::SessionInputAck { .. } => {}
            other => panic!("expected session.input_ack, got {other:?}"),
        }
        let mut got: Vec<u8> = Vec::new();
        while got.len() < line.len() {
            let (rsid, _seq, data) = helpers[*hi].read_stream();
            if rsid == *sid {
                got.extend_from_slice(&data);
            }
        }
        assert_eq!(String::from_utf8(got).unwrap(), line, "session {n} echo mismatch");
    }

    let child_pids: Vec<u32> = sessions.iter().map(|(_, _, pid)| *pid).collect();
    let mut children: Vec<Child> = Vec::new();
    for h in helpers {
        let Helper { child, stdin, stdout: _, .. } = h;
        drop(stdin); // close stdin so each helper shuts down
        children.push(child);
    }
    for child in children.iter_mut() {
        let status = wait_timeout(child, Duration::from_secs(20)).expect("helper did not exit");
        assert_eq!(status.code(), Some(0));
    }
    for pid in child_pids {
        assert!(!pid_alive(pid), "child {pid} still alive after shutdown");
    }
}

// T1: a frame larger than the 256 KiB input window is refused promptly and the
// helper keeps answering.
#[test]
fn t1_oversized_input_is_rejected_and_helper_survives() {
    let mut helper = start();
    helper.hello();
    let (sid, _pid) = helper.open();
    helper.send(&Request::SessionInput {
        id: 1,
        session_id: sid,
        data: "x".repeat(1_100_067),
    });
    match helper.read_response() {
        Response::Error { code, .. } => assert_eq!(code, "input_overflow"),
        other => panic!("expected input_overflow, got {other:?}"),
    }
    helper.send(&Request::Ping { id: 9 });
    match helper.read_response() {
        Response::Pong { id } => assert_eq!(id, 9),
        other => panic!("expected pong 9, got {other:?}"),
    }
}

// T1 boundary: exactly 262 144 ASCII bytes are accepted and echoed in full.
#[test]
fn t1_input_boundary_262144_ascii() {
    let mut helper = start();
    helper.hello();
    let (sid, _pid) = helper.open();
    let data = "x".repeat(262_144);
    helper.send(&Request::SessionInput {
        id: 1,
        session_id: sid,
        data: data.clone(),
    });
    match helper.read_response() {
        Response::SessionInputAck { .. } => {}
        other => panic!("expected session.input_ack, got {other:?}"),
    }
    let mut got: Vec<u8> = Vec::new();
    while got.len() < data.len() {
        let (rsid, _seq, chunk) = helper.read_stream();
        if rsid == sid {
            got.extend_from_slice(&chunk);
        }
    }
    assert_eq!(got, data.into_bytes());
}

// T1 boundary: 262 145 bytes is input_overflow.
#[test]
fn t1_input_262145_overflow() {
    let mut helper = start();
    helper.hello();
    let (sid, _pid) = helper.open();
    helper.send(&Request::SessionInput {
        id: 1,
        session_id: sid,
        data: "x".repeat(262_145),
    });
    match helper.read_response() {
        Response::Error { code, .. } => assert_eq!(code, "input_overflow"),
        other => panic!("expected input_overflow, got {other:?}"),
    }
}

// T1 boundary: a multibyte payload of exactly 262 144 bytes (é x 131 072) is
// accepted.
#[test]
fn t1_input_boundary_multibyte() {
    let mut helper = start();
    helper.hello();
    let (sid, _pid) = helper.open();
    let data = "é".repeat(131_072);
    helper.send(&Request::SessionInput {
        id: 1,
        session_id: sid,
        data: data.clone(),
    });
    match helper.read_response() {
        Response::SessionInputAck { .. } => {}
        other => panic!("expected session.input_ack, got {other:?}"),
    }
    let mut got: Vec<u8> = Vec::new();
    while got.len() < 262_144 {
        let (rsid, _seq, chunk) = helper.read_stream();
        if rsid == sid {
            got.extend_from_slice(&chunk);
        }
    }
    assert_eq!(got, data.into_bytes());
}

// T2: a client that dies while the outbox is full (stdout unread, both pipes
// closed) must not leave the helper or its child alive.
#[test]
fn t2_client_death_with_full_outbox_exits() {
    let mut helper = start_with_args(&["--echo-command", "/usr/bin/yes"]);
    helper.hello();
    let (_sid, pid) = helper.open();
    std::thread::sleep(Duration::from_secs(2)); // fill the outbox without reading
    drop(helper.stdin);
    drop(helper.stdout);
    let status = wait_timeout(&mut helper.child, Duration::from_secs(5)).expect("helper did not exit");
    assert_eq!(status.code(), Some(0));
    assert!(!pid_alive(pid), "child {pid} still alive");
}

// T3: children do not inherit the helper's ignored SIGPIPE.
#[test]
fn t3_child_sigpipe_is_default() {
    let mut helper = start_with_args(&["--echo-command", "/bin/sh", "-c", "yes | head -n 1; echo rc=$?"]);
    helper.hello();
    let (sid, _pid) = helper.open();
    let echoed = helper.read_until_stream_contains(sid, "rc=0");
    assert!(echoed.contains("rc=0"), "missing rc=0: {echoed:?}");
    assert!(!echoed.contains("Broken pipe"), "SIGPIPE ignored: {echoed:?}");

    let mut helper2 = start_with_args(&["--echo-command", "/bin/sh", "-c", "trap -p PIPE; echo done"]);
    helper2.hello();
    let (sid2, _pid2) = helper2.open();
    let echoed2 = helper2.read_until_stream_contains(sid2, "done");
    assert!(echoed2.contains("done"), "missing done: {echoed2:?}");
    assert!(!echoed2.contains("PIPE"), "SIGPIPE still ignored: {echoed2:?}");
}

// T4: close() must not signal a child that reap() already collected.
#[test]
fn t4_close_does_not_signal_reaped_child() {
    let mut command = Command::new(env!("CARGO_BIN_EXE_remote-hub-helper"));
    command
        .args(["--echo-command", "/usr/bin/true"])
        .env("REMOTE_HUB_KEEP_FINISHED", "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command.spawn().expect("spawn helper");
    let mut stdin = child.stdin.take().unwrap();
    let mut stdout = child.stdout.take().unwrap();
    let mut stderr = child.stderr.take().unwrap();

    let seen = Arc::new(Mutex::new(String::new()));
    let seen2 = seen.clone();
    let reader = std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            match stderr.read(&mut buf) {
                Ok(0) => break, // EOF
                Ok(n) => {
                    let mut g = seen2.lock().unwrap();
                    g.push_str(&String::from_utf8_lossy(&buf[..n]));
                }
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(_) => break,
            }
        }
    });

    send_req(&mut stdin, &Request::Hello {
        protocol: PROTOCOL_VERSION,
    });
    match decode_response(&read_frame_io(&mut stdout).1).unwrap() {
        Response::HelloAck { .. } => {}
        other => panic!("expected hello_ack, got {other:?}"),
    }
    send_req(&mut stdin, &Request::OpenEcho {
        id: 100,
        cols: 80,
        rows: 24,
    });
    let (sid, pid) = match decode_response(&read_frame_io(&mut stdout).1).unwrap() {
        Response::SessionOpened {
            session_id, pid, ..
        } => (session_id, pid),
        other => panic!("expected session.opened, got {other:?}"),
    };

    // Wait until the helper has reaped the child (the session stays open via
    // the test hook), instead of guessing with a fixed sleep.
    let reap_marker = format!("helper-reaped pid={pid}");
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        let got = seen.lock().unwrap();
        if got.contains(&reap_marker) || Instant::now() >= deadline {
            break;
        }
        drop(got);
        std::thread::sleep(Duration::from_millis(10));
    }
    let seen_text = seen.lock().unwrap().clone();
    assert!(
        seen_text.contains(&reap_marker),
        "helper did not reap the child: {}",
        seen_text
    );

    send_req(&mut stdin, &Request::SessionClose { id: 1, session_id: sid });
    loop {
        let (kind, payload) = read_frame_io(&mut stdout);
        if kind == FRAME_KIND_CONTROL {
            if let Response::SessionClosed { session_id, .. } = decode_response(&payload).unwrap() {
                assert_eq!(session_id, sid);
                break;
            }
        }
    }

    drop(stdin);
    drop(stdout);
    let status = wait_timeout(&mut child, Duration::from_secs(20)).expect("helper did not exit");
    assert_eq!(status.code(), Some(0));
    reader.join().expect("stderr reader joined");

    let err = seen.lock().unwrap();
    assert!(
        !err.contains(&format!("helper-signal pid={pid}")),
        "helper signalled a reaped child: {err}"
    );
    assert!(!pid_alive(pid), "child {pid} still alive");
}

// U2: a failed session setup must not leak the PTY descriptors.
#[test]
fn u2_failed_setup_does_not_leak_descriptors() {
    let mut command = Command::new(env!("CARGO_BIN_EXE_remote-hub-helper"));
    command
        .env("REMOTE_HUB_NOFILE", "7")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit());
    let mut child = command.spawn().expect("spawn helper");
    let mut stdin = child.stdin.take().unwrap();
    let mut stdout = child.stdout.take().unwrap();
    let helper_pid = child.id();

    send_req(&mut stdin, &Request::Hello {
        protocol: PROTOCOL_VERSION,
    });
    match decode_response(&read_frame_io(&mut stdout).1).unwrap() {
        Response::HelloAck { .. } => {}
        other => panic!("expected hello_ack, got {other:?}"),
    }

    let before = child_fds(helper_pid);
    for _ in 0..20 {
        send_req(&mut stdin, &Request::OpenEcho {
            id: 100,
            cols: 80,
            rows: 24,
        });
        match decode_response(&read_frame_io(&mut stdout).1).unwrap() {
            Response::Error { code, .. } => assert_eq!(code, "session_open_failed"),
            other => panic!("expected session_open_failed, got {other:?}"),
        }
    }
    let after = child_fds(helper_pid);
    assert_eq!(
        after.len(),
        before.len(),
        "descriptor count changed: before {before:?}, after {after:?}"
    );

    drop(stdin);
    let status = wait_timeout(&mut child, Duration::from_secs(5)).expect("helper did not exit");
    assert_eq!(status.code(), Some(0));
}

// U3: a half-close with a full outbox must not spin.
#[test]
fn u3_half_close_does_not_spin() {
    let mut helper = start();
    helper.hello();
    let helper_pid = helper.child.id();

    let mut id = 0u64;
    let mut written = 0usize;
    while written < 3 * 1024 * 1024 {
        let frame = encode_request(&Request::Ping { id });
        helper.stdin.write_all(&frame).unwrap();
        written += frame.len();
        id += 1;
    }
    helper.stdin.flush().unwrap();
    drop(helper.stdin);

    let t0 = cpu_seconds(helper_pid);
    std::thread::sleep(Duration::from_secs(2));
    let t1 = cpu_seconds(helper_pid);
    let cpu = t1 - t0;
    assert!(cpu < 0.5, "helper spun: {cpu} s CPU over 2 s");

    // Drain stdout to EOF, then the helper exits.
    let mut buf = [0u8; 65536];
    loop {
        match helper.stdout.read(&mut buf) {
            Ok(0) => break,
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => break,
        }
    }
    let status = wait_timeout(&mut helper.child, Duration::from_secs(5)).expect("helper did not exit");
    assert_eq!(status.code(), Some(0));
}

// A1: a well-framed but unparseable control body is answered and the helper
// keeps running.
#[test]
fn a1_unparseable_control_body_is_non_fatal() {
    let mut helper = start();
    helper.hello();
    let (_sid, _pid) = helper.open();

    let body = br#"{"type":"session.input","id":1,"sessionId":1,"data":"\ud800"}"#;
    let mut frame = vec![0x01u8];
    frame.extend_from_slice(body);
    let mut raw = Vec::with_capacity(4 + frame.len());
    raw.extend_from_slice(&(frame.len() as u32).to_le_bytes());
    raw.extend_from_slice(&frame);
    helper.send_raw(&raw);

    match helper.read_response() {
        Response::Error { code, .. } => assert_eq!(code, "invalid_frame"),
        other => panic!("expected invalid_frame, got {other:?}"),
    }
    helper.send(&Request::Ping { id: 5 });
    match helper.read_response() {
        Response::Pong { id } => assert_eq!(id, 5),
        other => panic!("expected pong 5, got {other:?}"),
    }
}

// A3: reach the hung_up && ingress-full path and prove no spin.
#[test]
fn a3_ingress_full_hangup_does_not_spin() {
    let Helper {
        mut child,
        mut stdin,
        mut stdout,
        ..
    } = start();
    send_req(&mut stdin, &Request::Hello {
        protocol: PROTOCOL_VERSION,
    });
    match decode_response(&read_frame_io(&mut stdout).1).unwrap() {
        Response::HelloAck { .. } => {}
        other => panic!("expected hello_ack, got {other:?}"),
    }
    let helper_pid = child.id();

    // Non-blocking stdin so the writer stops when the helper is full.
    unsafe {
        let fd = stdin.as_raw_fd();
        let flags = libc::fcntl(fd, libc::F_GETFL);
        libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK);
    }

    let writer = std::thread::spawn(move || {
        let mut id = 0u64;
        let mut total = 0usize;
        loop {
            let frame = encode_request(&Request::Ping { id });
            match stdin.write(&frame) {
                Ok(n) => {
                    total += n;
                    id += 1;
                    if n < frame.len() {
                        break;
                    }
                }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => break,
                Err(e) => panic!("stdin write: {e}"),
            }
        }
        // stdin drops here, closing the helper's stdin.
        total
    });
    let written = writer.join().expect("writer joined");
    assert!(
        written > 64 * 1024,
        "writer only wrote {written} bytes before blocking"
    );

    let t0 = cpu_seconds(helper_pid);
    std::thread::sleep(Duration::from_secs(2));
    let t1 = cpu_seconds(helper_pid);
    assert!(t1 - t0 < 0.5, "helper spun: {} s CPU over 2 s", t1 - t0);

    let mut buf = [0u8; 65536];
    loop {
        match stdout.read(&mut buf) {
            Ok(0) => break,
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => break,
        }
    }
    let status = wait_timeout(&mut child, Duration::from_secs(5)).expect("helper did not exit");
    assert_eq!(status.code(), Some(0));
}

// B3: a zero-credit producer must not stall another session or spin.
#[test]
fn b3_credit_isolates_sessions() {
    let mut helper = start();
    helper.hello();

    helper.send(&Request::OpenSsh {
        id: 1,
        cols: 80,
        rows: 24,
        program: "/usr/bin/yes".to_string(),
        argv: vec!["yes".to_string()],
        env: HashMap::new(),
        cwd: None,
    });
    let _x_sid = match helper.read_response() {
        Response::SessionOpened { session_id, .. } => session_id,
        other => panic!("expected session.opened, got {other:?}"),
    };

    helper.send(&Request::OpenEcho {
        id: 2,
        cols: 80,
        rows: 24,
    });
    let y_sid = match helper.read_response() {
        Response::SessionOpened { session_id, .. } => session_id,
        other => panic!("expected session.opened, got {other:?}"),
    };

    helper.send(&Request::SessionInput {
        id: 3,
        session_id: y_sid,
        data: "y-alive\n".to_string(),
    });
    match helper.read_response() {
        Response::SessionInputAck { .. } => {}
        other => panic!("expected session.input_ack, got {other:?}"),
    }
    let echoed = helper.read_until_stream_contains(y_sid, "y-alive");
    assert!(echoed.contains("y-alive"), "{echoed:?}");

    let helper_pid = helper.child.id();
    let t0 = cpu_seconds(helper_pid);
    std::thread::sleep(Duration::from_secs(2));
    let t1 = cpu_seconds(helper_pid);
    assert!(t1 - t0 < 0.5, "helper spun: {} s CPU over 2 s", t1 - t0);
}

// B4: exit status is reported in session.closed.
#[test]
fn b4_exit_status_is_reported() {
    let mut h = start_with_args(&["--echo-command", "/bin/sh", "-c", "exit 7"]);
    h.hello();
    let (sid, _pid) = h.open();
    let (code, sig, reason) = h.read_until_closed_status(sid);
    assert_eq!(code, Some(7));
    assert_eq!(sig, None);
    assert_eq!(reason, "exited");

    let mut h2 = start_with_args(&["--echo-command", "/bin/sh", "-c", "kill -TERM $$"]);
    h2.hello();
    let (sid2, _pid2) = h2.open();
    let (code2, sig2, reason2) = h2.read_until_closed_status(sid2);
    assert_eq!(code2, None);
    assert_eq!(sig2, Some(15));
    assert_eq!(reason2, "exited");
}

// B5: a direct child that exits while a descendant holds the PTY is closed
// after the grace period.
#[test]
fn b5_lingering_descendants_are_reaped() {
    let mut h = start_with_args(&["--echo-command", "/bin/sh", "-c", "sleep 300 & exit 0"]);
    h.hello();
    let (sid, pid) = h.open();
    let (code, _sig, reason) = h.read_until_closed_status(sid);
    assert_eq!(code, Some(0));
    assert_eq!(reason, "exited");
    assert!(!pid_alive(pid), "direct child {pid} still alive");
}

// B6: an allowlisted pipe fd reaches the child and nothing else above 2 does.
#[test]
fn b6_allowlisted_fd_is_passed() {
    let mut command = Command::new(env!("CARGO_BIN_EXE_remote-hub-helper"));
    command
        .env("REMOTE_HUB_TEST_ALLOW_PIPE", "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command.spawn().expect("spawn helper");
    let mut stdin = child.stdin.take().unwrap();
    let mut stdout = child.stdout.take().unwrap();
    let mut stderr = child.stderr.take().unwrap();

    send_req(&mut stdin, &Request::Hello {
        protocol: PROTOCOL_VERSION,
    });
    match decode_response(&read_frame_io(&mut stdout).1).unwrap() {
        Response::HelloAck { .. } => {}
        other => panic!("expected hello_ack, got {other:?}"),
    }
    send_req(&mut stdin, &Request::OpenEcho {
        id: 100,
        cols: 80,
        rows: 24,
    });
    let (sid, pid) = match decode_response(&read_frame_io(&mut stdout).1).unwrap() {
        Response::SessionOpened {
            session_id, pid, ..
        } => (session_id, pid),
        other => panic!("expected session.opened, got {other:?}"),
    };

    let echoed = read_until_stream_contains_io(&mut stdout, sid, "got:token");
    assert!(echoed.contains("got:token"), "{echoed:?}");

    std::thread::sleep(Duration::from_millis(300));
    let fds = child_fds(pid);
    assert_eq!(fds.len(), 4, "unexpected fds: {fds:?}");
    assert_eq!(&fds[..3], &[0, 1, 2]);
    assert!(fds[3] > 2);

    drop(stdin);
    let status = wait_timeout(&mut child, Duration::from_secs(5)).expect("helper did not exit");
    assert_eq!(status.code(), Some(0));
    let _ = stderr;
}

// C2: cancelling a just-opened session kills the child and its descendants.
#[test]
fn c2_cancel_connecting_session_kills_descendants() {
    let mut h = start_with_args(&["--echo-command", "/bin/sh", "-c", "sleep 300 & sleep 300"]);
    h.hello();
    let (sid, pid) = h.open();
    h.send(&Request::SessionClose { id: 1, session_id: sid });
    match h.read_response() {
        Response::SessionClosed { reason, .. } => assert_eq!(reason, "killed_by_close"),
        other => panic!("expected session.closed, got {other:?}"),
    }
    assert!(!pid_alive(pid), "child {pid} still alive");
}

// C2 regression: a real (ssh-kind) session starts from a normal interactive
// termios, so a 0x03 byte sent as a binary stream frame reaches the local tty
// as SIGINT and interrupts a foreground sleep. The echo console still runs raw;
// ssh must not, or OpenSSH forwards the raw modes to the remote PTY and Ctrl+C
// stops working there.
#[test]
fn c2_ctrl_c_interrupts_foreground_sleep_in_ssh_kind_session() {
    let mut h = start();
    h.hello();

    h.send(&Request::OpenSsh {
        id: 1,
        cols: 80,
        rows: 24,
        program: "/bin/sh".to_string(),
        argv: vec!["sh".to_string()],
        env: HashMap::new(),
        cwd: None,
    });
    let sid = match h.read_response() {
        Response::SessionOpened { session_id, .. } => session_id,
        other => panic!("expected session.opened, got {other:?}"),
    };

    h.send(&Request::SessionCredit {
        id: 2,
        session_id: sid,
        bytes: 1 << 20,
    });
    match h.read_response() {
        Response::SessionCreditAck { .. } => {}
        other => panic!("expected session.credit_ack, got {other:?}"),
    }

    h.send_stream(sid, b"sleep 300\n");
    std::thread::sleep(Duration::from_secs(1));
    h.send_stream(sid, b"\x03");
    std::thread::sleep(Duration::from_millis(500));
    h.send_stream(sid, b"echo after-int\n");

    let echoed = h.read_until_stream_contains(sid, "after-int");
    assert!(
        echoed.contains("after-int"),
        "after-int not received after 0x03: {echoed:?}"
    );
}

// C2 regression: an ssh-kind child that exits 255 must report ssh_error on
// every teardown path, including the orphan path that can win the race against
// the PTY reaching EOF.
#[test]
fn c2_ssh_exit_255_reports_ssh_error() {
    let mut h = start();
    h.hello();

    h.send(&Request::OpenSsh {
        id: 1,
        cols: 80,
        rows: 24,
        program: "/bin/sh".to_string(),
        argv: vec!["sh".to_string(), "-c".to_string(), "exit 255".to_string()],
        env: HashMap::new(),
        cwd: None,
    });
    let sid = match h.read_response() {
        Response::SessionOpened { session_id, .. } => session_id,
        other => panic!("expected session.opened, got {other:?}"),
    };

    let (code, sig, reason) = h.read_until_closed_status(sid);
    assert_eq!(code, Some(255));
    assert_eq!(sig, None);
    assert_eq!(reason, "ssh_error");
}

// V1: environment CStrings must stay alive until execve reads them. A dropped
// env owner would surface as garbage or missing values here.
#[test]
fn v1_env_values_reach_execve_intact() {
    let mut h = start();
    h.hello();

    let mut env = HashMap::new();
    env.insert("A".to_string(), "alpha".to_string());
    env.insert("B".to_string(), "beta gamma".to_string());
    env.insert("C".to_string(), "\u{03b4}".to_string());

    h.send(&Request::OpenSsh {
        id: 1,
        cols: 80,
        rows: 24,
        program: "/usr/bin/env".to_string(),
        argv: vec!["env".to_string()],
        env,
        cwd: None,
    });
    let sid = match h.read_response() {
        Response::SessionOpened { session_id, .. } => session_id,
        other => panic!("expected session.opened, got {other:?}"),
    };
    h.send(&Request::SessionCredit {
        id: 2,
        session_id: sid,
        bytes: 1 << 20,
    });
    match h.read_response() {
        Response::SessionCreditAck { .. } => {}
        other => panic!("expected session.credit_ack, got {other:?}"),
    }

    let mut got = String::new();
    for _ in 0..400 {
        let (kind, payload) = h.read_frame();
        if kind == FRAME_KIND_STREAM {
            let rsid = u32::from_le_bytes(payload[0..4].try_into().unwrap());
            if rsid == sid {
                got.push_str(&String::from_utf8_lossy(&payload[8..]));
            }
        }
        if got.contains("A=alpha") && got.contains("B=beta gamma") && got.contains("C=\u{03b4}") {
            break;
        }
    }

    let mut lines: Vec<String> = got
        .lines()
        .map(|l| l.trim_end_matches('\r').to_string())
        .filter(|l| !l.is_empty())
        .collect();
    lines.sort();
    assert_eq!(lines, vec!["A=alpha", "B=beta gamma", "C=\u{03b4}"]);
}

// V9: a normal child that exits while its slave closes must be reaped as a
// normal exit, never SIGTERMed as an orphan or misreported as a signal.
#[test]
fn v9_normal_exit_is_not_misread_as_orphan() {
    let mut h = start_with_args(&["--echo-command", "/bin/sh", "-c", "exit 7"]);
    h.hello();
    for _ in 0..200 {
        let (sid, _pid) = h.open();
        let (code, sig, _reason) = h.read_until_closed_status(sid);
        assert_eq!(code, Some(7));
        assert_eq!(sig, None);
    }
}

// V8: closing a session whose direct child was already reaped must not leak
// the PTY master fd (it used to, only the killed_by_close path closed it).
#[test]
fn v8_close_of_reaped_session_does_not_leak_master() {
    let mut command = Command::new(env!("CARGO_BIN_EXE_remote-hub-helper"));
    command
        .args(["--echo-command", "/usr/bin/true"])
        .env("REMOTE_HUB_KEEP_FINISHED", "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command.spawn().expect("spawn helper");
    let mut stdin = child.stdin.take().unwrap();
    let mut stdout = child.stdout.take().unwrap();
    let mut stderr = child.stderr.take().unwrap();
    let helper_pid = child.id();

    let seen = Arc::new(Mutex::new(String::new()));
    let seen2 = seen.clone();
    let reader = std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            match stderr.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    seen2
                        .lock()
                        .unwrap()
                        .push_str(&String::from_utf8_lossy(&buf[..n]));
                }
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(_) => break,
            }
        }
    });

    send_req(&mut stdin, &Request::Hello {
        protocol: PROTOCOL_VERSION,
    });
    let _ = read_frame_io(&mut stdout); // hello_ack
    let before = child_fds(helper_pid);

    for i in 0..50u64 {
        send_req(&mut stdin, &Request::OpenEcho {
            id: 100 + i,
            cols: 80,
            rows: 24,
        });
        let (sid, pid) = match decode_response(&read_frame_io(&mut stdout).1).unwrap() {
            Response::SessionOpened {
                session_id, pid, ..
            } => (session_id, pid),
            other => panic!("expected session.opened, got {other:?}"),
        };

        let marker = format!("helper-reaped pid={pid}");
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            let text = seen.lock().unwrap().clone();
            if text.contains(&marker) || Instant::now() >= deadline {
                break;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        assert!(
            seen.lock().unwrap().contains(&marker),
            "child {pid} was not reaped"
        );

        send_req(&mut stdin, &Request::SessionClose {
            id: 200 + i,
            session_id: sid,
        });
        loop {
            let (kind, payload) = read_frame_io(&mut stdout);
            if kind == FRAME_KIND_CONTROL {
                if let Response::SessionClosed { session_id, .. } =
                    decode_response(&payload).unwrap()
                {
                    assert_eq!(session_id, sid);
                    break;
                }
            }
        }
    }

    let after = child_fds(helper_pid);
    assert_eq!(
        after.len(),
        before.len(),
        "helper fd count changed: before {before:?} after {after:?}"
    );

    drop(stdin);
    drop(stdout);
    let status = wait_timeout(&mut child, Duration::from_secs(5)).expect("helper did not exit");
    assert_eq!(status.code(), Some(0));
    reader.join().expect("stderr reader joined");
}

// V8: closing during the linger grace must still tear down the descendant
// process group (the direct child has already exited and been reaped).
#[test]
fn v8_close_during_linger_reaps_descendants() {
    let mut h = start_with_args(&["--echo-command", "/bin/sh", "-c", "sleep 300 & exit 0"]);
    h.hello();
    let (sid, pid) = h.open();
    std::thread::sleep(Duration::from_millis(50));

    h.send(&Request::SessionClose {
        id: 1,
        session_id: sid,
    });
    h.read_until_closed(sid);

    let deadline = Instant::now() + Duration::from_secs(5);
    let mut group_alive = true;
    while Instant::now() < deadline {
        let r = unsafe { libc::kill(-(pid as libc::pid_t), 0) };
        if r != 0 {
            group_alive = false;
            break;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    assert!(!group_alive, "process group {pid} still alive after close");
}
