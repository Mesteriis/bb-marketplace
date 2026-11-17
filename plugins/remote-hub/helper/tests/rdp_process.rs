//! Process-model tests for the RDP engines (stage 2b-1 repair G6-G9): ids are
//! shared across session kinds, exits are routed by owned pid, a dead engine
//! does not spin the loop, and the engine inherits nothing but its socket.
mod common;

use std::time::Duration;

use common::*;
use remote_hub_helper::protocol::{Request, Response};
use remote_hub_helper::secret::Secret;

/// G7: one echo and one RDP session never share an id; closing each closes only
/// itself; input never crosses.
#[test]
fn g7_ids_are_distinct_and_close_is_per_session() {
    let server = silent_server();
    let mut h = start(&[]);
    let (echo, echo_pid) = h.open_echo();
    let (rdp, engine_pid) = h.open_rdp(server.port);
    assert_ne!(echo, rdp, "echo and rdp sessions share a wire id");

    h.echo_round_trip(echo, "ping-one");

    // Closing the echo session must not touch the RDP one.
    h.send(&Request::SessionClose { id: 20, session_id: echo });
    let (_, _, reason) = h.read_closed(echo);
    assert_eq!(reason, "killed_by_close");
    assert!(wait_pid_gone(echo_pid, Duration::from_secs(5)), "echo child survived its close");
    assert!(pid_alive(engine_pid), "closing the echo session killed the rdp engine");
    // The session is still there: a not-yet-ready desktop answers `not_ready`,
    // an unknown one `session_not_found`.
    h.send(&Request::RdpInput { id: 21, session_id: rdp, events: vec![] });
    match h.read_reply(21) {
        Response::Error { code, .. } => assert_eq!(code, "not_ready"),
        other => panic!("rdp session was lost: {other:?}"),
    }

    // Closing the RDP session closes only it.
    let (echo2, _) = h.open_echo();
    h.send(&Request::SessionClose { id: 22, session_id: rdp });
    let (_, _, reason) = h.read_closed(rdp);
    assert_eq!(reason, "killed_by_close");
    assert!(wait_pid_gone(engine_pid, Duration::from_secs(5)), "engine survived session.close");
    h.echo_round_trip(echo2, "ping-two");
    h.shutdown();
}

/// G8(a): in the REAL helper loop an engine killed by a signal is reported by
/// the RDP side with that signal, while a PTY session is active (the PTY
/// reaper runs first in the same loop and must not steal the exit).
#[test]
fn g8_engine_exit_status_survives_the_pty_reaper() {
    let server = silent_server();
    let mut h = start(&[]);
    let (echo, _) = h.open_echo();
    let (rdp, engine_pid) = h.open_rdp(server.port);
    h.wait_state(rdp, "connecting");
    unsafe { libc::kill(engine_pid as libc::pid_t, libc::SIGKILL) };
    let (code, signal, reason) = h.read_closed(rdp);
    assert_eq!(reason, "engine_exited");
    assert_eq!(code, None);
    assert_eq!(signal, Some(9), "the engine's exit status was lost to another reaper");
    // The parallel echo session still answers within the 1 s budget.
    let t = std::time::Instant::now();
    h.echo_round_trip(echo, "still-alive");
    assert!(t.elapsed() < Duration::from_secs(1));
    h.shutdown();
}

/// G8(a) with a known exit code: an engine that finishes normally (connection
/// refused) exits 0 and the closed report carries code 0. G8(b): closing the
/// already-reaped session sends no signal to its pid.
#[test]
fn g8_engine_exit_code_is_reported_and_close_after_reap_signals_nothing() {
    let mut h = start(&[]);
    let (_echo, _) = h.open_echo(); // keep a PTY session around
    let (rdp, engine_pid) = h.open_rdp(closed_port());
    let (code, signal, reason) = h.read_closed(rdp);
    assert_eq!(reason, "network_error", "closed with exit code {code:?}, signal {signal:?}");
    assert_eq!((code, signal), (Some(0), None));
    // The closed report is only sent once the engine has been reaped, so the
    // close below always follows the reap.
    h.send(&Request::SessionClose { id: 30, session_id: rdp });
    // The session is already reported closed; the close is still answered.
    let _ = h.read_reply(30);
    let log = h.stderr_text();
    let h_pid = h.pid();
    h.shutdown();
    let needle = format!("helper-signal pid={engine_pid} sig=SIGKILL");
    assert!(!log.contains(&needle), "a reaped engine pid was signalled (helper {h_pid}):\n{log}");
}

/// G9: after the engine died, the helper does not spin: CPU < 0.2 s over 3 s,
/// measured before session.close.
#[test]
fn g9_dead_engine_does_not_busy_loop_the_helper() {
    let server = silent_server();
    let mut h = start(&[]);
    let (rdp, engine_pid) = h.open_rdp(server.port);
    h.wait_state(rdp, "connecting");
    unsafe { libc::kill(engine_pid as libc::pid_t, libc::SIGKILL) };
    let _ = h.read_closed(rdp);
    let t0 = cpu_seconds(h.pid());
    std::thread::sleep(Duration::from_secs(3));
    let cpu = cpu_seconds(h.pid()) - t0;
    assert!(cpu < 0.2, "helper spun for {cpu} s of CPU over 3 s with a dead engine");
    h.shutdown();
}

/// G6: the engine's fds 0, 1 and 2 are /dev/null; no pipe (the helper's RPC
/// channel) or regular file (its stderr log) reaches it; fd 3 is its socket.
#[test]
fn g6_engine_inherits_only_its_socket() {
    let server = silent_server();
    let mut h = start(&[]);
    let (rdp, engine_pid) = h.open_rdp(server.port);
    h.wait_state(rdp, "connecting"); // the engine has exec'd and is running
    let rows = lsof_fds(engine_pid);
    let by = |n: i32| rows.iter().find(|(fd, _, _)| *fd == n).cloned();
    for n in 0..=2 {
        let (_, ty, name) = by(n).unwrap_or_else(|| panic!("fd {n} missing: {rows:?}"));
        assert_eq!((ty.as_str(), name.as_str()), ("CHR", "/dev/null"), "fd {n}");
    }
    let (_, ty3, _) = by(3).unwrap_or_else(|| panic!("fd 3 missing: {rows:?}"));
    assert_eq!(ty3, "unix");
    for (fd, ty, name) in &rows {
        assert!(ty != "PIPE" && ty != "REG", "engine fd {fd} is {ty} {name}: {rows:?}");
    }
    h.shutdown();
}

/// G12: when the helper dies hard (SIGKILL, no chance to clean up) its engines
/// end their sessions and exit on their own instead of lingering as logged-in
/// orphans.
#[test]
fn g12_engine_exits_when_the_helper_is_killed() {
    let server = silent_server();
    let mut h = start(&[]);
    let (rdp, engine_pid) = h.open_rdp(server.port);
    h.wait_state(rdp, "connecting");
    assert!(pid_alive(engine_pid));
    unsafe { libc::kill(h.pid() as libc::pid_t, libc::SIGKILL) };
    let _ = h.child.wait();
    assert!(
        wait_pid_gone(engine_pid, Duration::from_secs(1)),
        "the engine outlived its helper by more than 1 s"
    );
}

/// G15: a screenshot before `desktop_ready` is refused, with the request's own
/// correlation id (never a frameId-0 image), and the session stays usable.
#[test]
fn g15_screenshot_before_desktop_ready_is_refused_with_its_request_id() {
    let server = silent_server();
    let mut h = start(&[]);
    let (rdp, _) = h.open_rdp(server.port);
    h.send(&Request::RdpScreenshot { id: 777, session_id: rdp });
    let reply = h.read_until(Duration::from_secs(5), |k, p| {
        if k != remote_hub_helper::protocol::FRAME_KIND_CONTROL {
            return None;
        }
        match remote_hub_helper::protocol::decode_response(p).ok()? {
            r @ (Response::Error { .. } | Response::RdpScreenshot { .. }) => Some(r),
            _ => None,
        }
    });
    match reply {
        Response::Error { id, code, .. } => assert_eq!((id, code.as_str()), (Some(777), "not_ready")),
        other => panic!("expected a not_ready refusal, got {other:?}"),
    }
    // Unknown sessions are refused, not acked.
    h.send(&Request::RdpScreenshot { id: 778, session_id: 4242 });
    match h.read_reply(778) {
        Response::Error { id, code, .. } => assert_eq!((id, code.as_str()), (Some(778), "session_not_found")),
        other => panic!("expected session_not_found, got {other:?}"),
    }
    h.shutdown();
}

/// G16: input and certificate decisions for an unknown session are refused with
/// `session_not_found` instead of being acknowledged.
#[test]
fn g16_unknown_session_input_and_decision_are_refused() {
    let mut h = start(&[]);
    h.send(&Request::RdpInput { id: 1, session_id: 999, events: vec![] });
    match h.read_reply(1) {
        Response::Error { id, code, .. } => assert_eq!((id, code.as_str()), (Some(1), "session_not_found")),
        other => panic!("expected session_not_found, got {other:?}"),
    }
    h.send(&Request::RdpCertDecision {
        id: 2,
        session_id: 999,
        fingerprint: "AA".to_string(),
        accept: "once".to_string(),
    });
    match h.read_reply(2) {
        Response::Error { id, code, .. } => assert_eq!((id, code.as_str()), (Some(2), "session_not_found")),
        other => panic!("expected session_not_found, got {other:?}"),
    }
    h.shutdown();
}

const FAKE: &str = "REMOTE_HUB_RDP_FAKE_ENGINE";
const FULL_FRAME_PIXELS: u32 = 1920 * 1080;

/// Chunks already received (non-blocking).
fn queued_updates(rx: &FrameRx) -> Vec<UpdateChunk> {
    rx.updates.try_iter().collect()
}

/// Block until the next update chunk (the limit is a hang guard).
fn next_update(rx: &FrameRx) -> UpdateChunk {
    rx.updates.recv_timeout(Duration::from_secs(60)).expect("hang guard: no update arrived")
}

/// Block until the synthetic desktop has reported at least `n` paints.
/// Returns the paint count seen.
fn wait_paints(rx: &FrameRx, n: u32) -> u32 {
    loop {
        let (kind, payload) = rx.frames.recv_timeout(Duration::from_secs(60)).expect("hang guard: no paint marker");
        if kind != remote_hub_helper::protocol::FRAME_KIND_CONTROL {
            continue;
        }
        if let Ok(Response::RdpState { state, .. }) = remote_hub_helper::protocol::decode_response(&payload) {
            if let Some(count) = state.strip_prefix("paint=").and_then(|c| c.parse::<u32>().ok()) {
                if count >= n {
                    return count;
                }
            }
        }
    }
}

fn distinct_frames(chunks: &[UpdateChunk]) -> Vec<u64> {
    let mut ids: Vec<u64> = chunks.iter().map(|c| c.frame_id).collect();
    ids.sort_unstable();
    ids.dedup();
    ids
}

/// G10: a view that never acks receives exactly ONE update however many times
/// the desktop repaints; each frame on the wire is <= 1 MiB with every header
/// counted; the ack releases ONE coalesced dirty region (not a full frame) and
/// the engine then waits again; a stale ack releases nothing.
///
/// No sleeps or windows: "the desktop repainted N more times" is an event (the
/// synthetic engine's `paint=<n>` marker, which reaches the client after every
/// update chunk sent before it).
#[test]
fn g10_an_unacked_view_gets_exactly_one_update_then_one_coalesced_region() {
    let mut h = start(&[(FAKE, "ack")]);
    let (rdp, _) = h.open_rdp_sized(closed_port(), 1920, 1080);
    let rx = h.frames_in_background(rdp);

    // The first update goes out; then the desktop repaints 100 more times with
    // nobody acking.
    let first_chunk = next_update(&rx);
    let seen = wait_paints(&rx, 100);
    let mut first = vec![first_chunk];
    first.extend(queued_updates(&rx));
    let ids = distinct_frames(&first);
    assert_eq!(ids.len(), 1, "an un-acked view received more than one update: {ids:?}");
    let pixels: u32 = first.iter().map(|c| c.w * c.h).sum();
    assert_eq!(pixels, FULL_FRAME_PIXELS, "the first update must cover the whole desktop");
    assert!(first.iter().all(|c| c.wire_len <= 1_048_576), "a chunk exceeded 1 MiB on the wire");

    // The ack releases the coalesced region: the bounding box of the four
    // 64x64 blocks the synthetic desktop cycles through, at (0,0).
    h.send(&Request::RdpUpdateAck { id: 50, session_id: rdp, frame_id: ids[0] });
    let second_chunk = next_update(&rx);
    let seen = wait_paints(&rx, seen + 100);
    let mut second = vec![second_chunk];
    second.extend(queued_updates(&rx));
    let ids2 = distinct_frames(&second);
    assert_eq!(ids2.len(), 1, "one ack must release exactly one update: {ids2:?}");
    assert_ne!(ids2[0], ids[0]);
    assert_eq!(second.len(), 1, "a 128x128 region is a single chunk");
    assert_eq!((second[0].x, second[0].y, second[0].w, second[0].h), (0, 0, 128, 128));

    // A stale ack (the first frame's id) releases nothing, however long the
    // desktop keeps repainting.
    h.send(&Request::RdpUpdateAck { id: 51, session_id: rdp, frame_id: ids[0] });
    let _ = wait_paints(&rx, seen + 100);
    assert!(queued_updates(&rx).is_empty(), "a stale ack released an update");
    h.shutdown();
}

/// G10: a client that never reads stdout while a (buggy) engine floods 1920x1080
/// updates without pacing cannot grow the helper: RSS growth < 32 MiB over 3 s.
#[test]
fn g10_unread_stdout_does_not_grow_the_helper() {
    let signal = std::path::PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join(format!("g10-blocked-{}", std::process::id()));
    let _ = std::fs::remove_file(&signal);
    let mut h = start(&[(FAKE, &format!("flood-signal:{}", signal.display()))]);
    let base = rss_kb(h.pid());
    let (_rdp, _) = h.open_rdp_sized(closed_port(), 1920, 1080);
    // Start the observation window on a POSITIVE signal that the helper's bounded
    // buffers are full: the flooding engine reports (by creating `signal`) that
    // its writes have been BLOCKED for 600 ms, which happens only because the
    // helper has stopped reading it. That is independent of how big the fill is
    // and of how slowly it happens under load; "RSS is flat" is not (RSS sits flat
    // before the fill starts). The 60 s limit is a hang guard.
    let hang_guard = std::time::Instant::now() + Duration::from_secs(60);
    while !signal.exists() {
        assert!(std::time::Instant::now() < hang_guard, "hang guard: the engine's writes never blocked");
        std::thread::sleep(Duration::from_millis(50));
    }
    let _ = std::fs::remove_file(&signal);
    let early = rss_kb(h.pid());
    std::thread::sleep(Duration::from_secs(3));
    let late = rss_kb(h.pid());
    assert!(late - base < 32 * 1024, "helper RSS grew {} KiB (base {base}, early {early}, late {late})", late - base);
    // still bounded between the two samples, not just under the limit
    assert!(late - early < 16 * 1024, "helper kept growing: early {early} -> late {late}");
    unsafe { libc::kill(h.pid() as libc::pid_t, libc::SIGKILL) };
    let _ = h.child.wait();
}

/// G10: while an engine floods, a parallel echo session still answers within 1 s.
#[test]
fn g10_a_flooding_engine_does_not_starve_an_echo_session() {
    let mut h = start(&[(FAKE, "flood")]);
    let (echo, _) = h.open_echo();
    let (rdp, _) = h.open_rdp_sized(closed_port(), 1920, 1080);
    let rx = h.frames_in_background(rdp);
    let _ = next_update(&rx); // the engine is flooding
    let t = std::time::Instant::now();
    h.send(&Request::SessionInput { id: 60, session_id: echo, data: "flood-ping".to_string() });
    let mut got = String::new();
    while t.elapsed() < Duration::from_secs(5) {
        let Ok((kind, payload)) = rx.frames.recv_timeout(Duration::from_millis(50)) else { continue };
        if kind == remote_hub_helper::protocol::FRAME_KIND_STREAM
            && u32::from_le_bytes(payload[0..4].try_into().unwrap()) == echo
        {
            got.push_str(&String::from_utf8_lossy(&payload[8..]));
            if got.contains("flood-ping") {
                break;
            }
        }
    }
    assert!(got.contains("flood-ping"), "the echo session never answered during the flood");
    assert!(t.elapsed() < Duration::from_secs(1), "echo answered after {:?}", t.elapsed());
    unsafe { libc::kill(h.pid() as libc::pid_t, libc::SIGKILL) };
    let _ = h.child.wait();
}

/// G19: the engine ends with its helper on every orderly shutdown path:
/// SIGTERM to the helper and stdin EOF (client death) leave no engine behind.
#[test]
fn g19_sigterm_and_stdin_eof_leave_no_engine() {
    let server = silent_server();
    let mut h = start(&[]);
    let (rdp, engine_pid) = h.open_rdp(server.port);
    h.wait_state(rdp, "connecting");
    assert!(pid_alive(engine_pid));
    unsafe { libc::kill(h.pid() as libc::pid_t, libc::SIGTERM) };
    let status = h.child.wait().expect("helper exit");
    assert_eq!(status.code(), Some(0), "helper must exit cleanly on SIGTERM");
    assert!(wait_pid_gone(engine_pid, Duration::from_secs(2)), "engine survived helper SIGTERM");

    let mut h = start(&[]);
    let (rdp, engine_pid) = h.open_rdp(server.port);
    h.wait_state(rdp, "connecting");
    assert!(pid_alive(engine_pid));
    h.shutdown(); // closes stdin
    assert!(wait_pid_gone(engine_pid, Duration::from_secs(2)), "engine survived stdin EOF");
}

/// G19 / B4: the password literal is in neither the engine's argv nor its
/// environment (`ps eww` prints both); argv is exactly the fixed pair.
#[test]
fn g19_password_is_not_in_the_engine_argv_or_env() {
    let server = silent_server();
    let mut h = start(&[("SSLKEYLOGFILE", "/tmp/should-not-leak.log"), ("PEPPER", "env-marker")]);
    let (rdp, engine_pid) = h.open_rdp(server.port);
    h.wait_state(rdp, "connecting");
    let out = std::process::Command::new("ps")
        .args(["eww", "-p", &engine_pid.to_string()])
        .output()
        .expect("ps");
    let text = String::from_utf8_lossy(&out.stdout).to_string();
    assert!(text.contains(&engine_pid.to_string()), "ps did not list the engine: {text}");
    assert!(!text.contains("S3cr3t-MARK-91"), "password literal visible in ps: {text}");
    assert!(!text.contains("SSLKEYLOGFILE"), "SSLKEYLOGFILE reached the engine: {text}");
    assert!(!text.contains("env-marker"), "the helper's environment reached the engine: {text}");
    assert!(text.contains("remote-hub-helper --rdp-engine"), "unexpected engine argv: {text}");
    h.shutdown();
}

fn thread_count_of(pid: u32) -> usize {
    // `ps -M` prints one row per thread after a header row.
    let out = std::process::Command::new("ps").args(["-M", "-p", &pid.to_string()]).output().expect("ps -M");
    assert!(out.status.success(), "ps -M failed: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).lines().count().saturating_sub(1)
}

/// G14: the helper forks children without exec in between work, which is only
/// sound while it is single-threaded. It has exactly one thread at idle, with
/// PTY sessions, with RDP engines and after they close; and (test-hooks) every
/// fork site asserts it, so a change that adds a thread makes the first spawn
/// fail instead of silently risking a poisoned child.
#[test]
fn g14_the_helper_stays_single_threaded_across_forks() {
    let server = silent_server();
    let mut h = start(&[]);
    assert_eq!(thread_count_of(h.pid()), 1, "idle helper");
    let (echo, _) = h.open_echo();
    assert_eq!(thread_count_of(h.pid()), 1, "after a PTY session");
    let (rdp, engine_pid) = h.open_rdp(server.port);
    assert_eq!(thread_count_of(h.pid()), 1, "after an RDP session");
    let _ = engine_pid; // the engine's own thread count is not part of the invariant
    h.send(&Request::SessionClose { id: 70, session_id: rdp });
    let _ = h.read_closed(rdp);
    h.send(&Request::SessionClose { id: 71, session_id: echo });
    let _ = h.read_closed(echo);
    assert_eq!(thread_count_of(h.pid()), 1, "after closing everything");
    h.shutdown();
}

/// H1 (d)/(b): input and acknowledgements before `desktop_ready` are refused
/// with `not_ready` and queue nothing; a helper that then dies still takes its
/// engine with it within 1 s.
#[test]
fn h1_input_and_acks_before_the_desktop_are_refused_and_helper_death_is_noticed() {
    let server = silent_server();
    let mut h = start(&[]);
    let (rdp, engine_pid) = h.open_rdp(server.port);
    h.wait_state(rdp, "connecting");
    for i in 0..100u64 {
        h.send(&Request::RdpInput { id: 1000 + i, session_id: rdp, events: vec![] });
        match h.read_reply(1000 + i) {
            Response::Error { code, .. } => assert_eq!(code, "not_ready"),
            other => panic!("input {i}: expected not_ready, got {other:?}"),
        }
    }
    h.send(&Request::RdpUpdateAck { id: 2000, session_id: rdp, frame_id: 1 });
    match h.read_reply(2000) {
        Response::Error { code, .. } => assert_eq!(code, "not_ready"),
        other => panic!("ack: expected not_ready, got {other:?}"),
    }
    unsafe { libc::kill(h.pid() as libc::pid_t, libc::SIGKILL) };
    let _ = h.child.wait();
    assert!(wait_pid_gone(engine_pid, Duration::from_secs(1)), "the engine outlived its helper by more than 1 s");
}

/// H9: a desktop size outside 1..=3840 x 1..=2160 is refused by the helper with
/// a stable code before any engine is started (65536 would wrap to 0 as u16).
#[test]
fn h9_rdp_open_refuses_a_desktop_size_out_of_range() {
    let mut h = start(&[]);
    for (i, (w, ht)) in [(65_536u32, 600u32), (0, 600), (800, 2_161), (3_841, 600)].into_iter().enumerate() {
        let id = 50 + i as u64;
        h.send(&Request::OpenRdp {
            id,
            host: "127.0.0.1".to_string(),
            port: 1,
            username: "tester".to_string(),
            password: Secret::new("S3cr3t-MARK-91"),
            domain: None,
            width: w,
            height: ht,
            expected_fingerprint: None,
        });
        match h.read_reply(id) {
            Response::Error { code, .. } => assert_eq!(code, "rdp_invalid_geometry", "{w}x{ht}"),
            other => panic!("{w}x{ht}: expected rdp_invalid_geometry, got {other:?}"),
        }
    }
    // The largest allowed desktop still opens.
    let server = silent_server();
    let (_rdp, pid) = h.open_rdp_sized(server.port, 3840, 2160);
    assert!(pid_alive(pid));
    h.shutdown();
}
