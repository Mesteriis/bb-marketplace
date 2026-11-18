//! Remote commands (stage 4b-2) through the real helper process. The program is `/usr/bin/perl` standing in for ssh
//! (test-hooks builds run a free-form program): what is under test is the helper's run handling — separate bounded
//! streams, exit codes, timeout, cancel, closed stdin, binary output, concurrency — not OpenSSH.
mod common;

use common::*;
use remote_hub_helper::protocol::{Request, Response};
use std::collections::HashMap;
use std::time::{Duration, Instant};

fn b64_decode(text: &str) -> Vec<u8> {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = Vec::new();
    let (mut buf, mut bits) = (0u32, 0u32);
    for c in text.bytes().filter(|c| *c != b'=') {
        let v = T.iter().position(|t| *t == c).expect("base64") as u32;
        buf = (buf << 6) | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buf >> bits) as u8);
            buf &= (1 << bits) - 1;
        }
    }
    out
}

struct Run {
    exec_id: u32,
}

fn run_with(h: &mut Helper, id: u64, script: &str, timeout_ms: u64, max_bytes: usize) -> Run {
    let mut env = HashMap::new();
    env.insert("PATH".to_string(), "/usr/bin:/bin".to_string());
    h.send(&Request::ExecRun {
        id,
        program: "/usr/bin/perl".into(),
        argv: vec!["perl".into(), "-e".into(), script.into()],
        env,
        askpass: None,
        timeout_ms,
        max_bytes,
    });
    match h.read_reply(id) {
        Response::ExecStarted { exec_id, .. } => Run { exec_id },
        other => panic!("expected exec.started, got {other:?}"),
    }
}

struct Seen {
    running: bool,
    exit_code: Option<i32>,
    signal: Option<i32>,
    reason: Option<String>,
    stdout: Vec<u8>,
    stdout_total: u64,
    truncated: bool,
    stderr: Vec<u8>,
}

/// Polls exec.read until the run has finished (or the limit), collecting both streams from offset 0.
fn finish(h: &mut Helper, run: &Run, limit: Duration) -> Seen {
    let deadline = Instant::now() + limit;
    let mut next = 1000u64;
    loop {
        next += 1;
        h.send(&Request::ExecRead { id: next, exec_id: run.exec_id, stdout_from: 0, stderr_from: 0, max: 1 << 20 });
        match h.read_reply(next) {
            Response::ExecState { running, exit_code, signal, reason, stdout, stderr, .. } => {
                if !running {
                    return Seen { running, exit_code, signal, reason, stdout: b64_decode(&stdout.data), stdout_total: stdout.total, truncated: stdout.truncated, stderr: b64_decode(&stderr.data) };
                }
            }
            other => panic!("expected exec.state, got {other:?}"),
        }
        assert!(Instant::now() < deadline, "the run did not finish in time");
        std::thread::sleep(Duration::from_millis(50));
    }
}

fn watchdog() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        std::thread::spawn(|| {
            std::thread::sleep(Duration::from_secs(90));
            eprintln!("exec tests: watchdog expired; aborting");
            std::process::abort();
        });
    });
}

#[test]
fn stdout_stderr_and_a_zero_exit_are_kept_apart() {
    watchdog();
    let mut h = start(&[]);
    let run = run_with(&mut h, 1, r#"print "out-line\n"; print STDERR "err-line\n"; exit 0;"#, 20_000, 1 << 16);
    let seen = finish(&mut h, &run, Duration::from_secs(20));
    assert_eq!(String::from_utf8_lossy(&seen.stdout), "out-line\n");
    assert_eq!(String::from_utf8_lossy(&seen.stderr), "err-line\n");
    assert_eq!((seen.exit_code, seen.reason.as_deref()), (Some(0), Some("exited")));
    h.shutdown();
}

#[test]
fn a_nonzero_exit_and_a_signal_are_reported_as_they_are() {
    watchdog();
    let mut h = start(&[]);
    let a = run_with(&mut h, 1, "exit 7;", 20_000, 1 << 16);
    let seen = finish(&mut h, &a, Duration::from_secs(20));
    assert_eq!((seen.exit_code, seen.signal), (Some(7), None));
    let b = run_with(&mut h, 2, r#"kill 'KILL', $$; sleep 5;"#, 20_000, 1 << 16);
    let seen = finish(&mut h, &b, Duration::from_secs(20));
    assert_eq!((seen.exit_code, seen.signal), (None, Some(9)));
    h.shutdown();
}

#[test]
fn output_over_the_bound_is_cut_at_the_head_counted_and_flagged_and_the_run_still_ends() {
    watchdog();
    let mut h = start(&[]);
    let run = run_with(&mut h, 1, r#"print "A" x 3_000_000; exit 0;"#, 30_000, 2048);
    let seen = finish(&mut h, &run, Duration::from_secs(30));
    assert_eq!(seen.stdout.len(), 2048, "only the head up to the bound is kept");
    assert!(seen.stdout.iter().all(|b| *b == b'A'));
    assert_eq!(seen.stdout_total, 3_000_000, "everything is counted");
    assert!(seen.truncated);
    assert_eq!(seen.exit_code, Some(0));
    h.shutdown();
}

#[test]
fn binary_output_arrives_byte_for_byte() {
    watchdog();
    let mut h = start(&[]);
    let run = run_with(&mut h, 1, r#"binmode(STDOUT); print pack("C*", 0..255), "\x00\xff\x1b[31m"; exit 0;"#, 20_000, 1 << 16);
    let seen = finish(&mut h, &run, Duration::from_secs(20));
    let mut expect: Vec<u8> = (0..=255u8).collect();
    expect.extend_from_slice(&[0x00, 0xff, 0x1b, b'[', b'3', b'1', b'm']);
    assert_eq!(seen.stdout, expect);
    h.shutdown();
}

#[test]
fn a_command_that_reads_stdin_sees_end_of_file_at_once() {
    watchdog();
    let mut h = start(&[]);
    let run = run_with(&mut h, 1, r#"my $n = 0; while (<STDIN>) { $n++ } print "lines=$n\n"; exit 0;"#, 20_000, 1 << 16);
    let seen = finish(&mut h, &run, Duration::from_secs(20));
    assert_eq!(String::from_utf8_lossy(&seen.stdout), "lines=0\n", "stdin is closed, so the command cannot wait for an answer");
    h.shutdown();
}

#[test]
fn a_run_past_its_timeout_is_stopped_and_says_so() {
    watchdog();
    let mut h = start(&[]);
    let started = Instant::now();
    let run = run_with(&mut h, 1, r#"$| = 1; print "begun\n"; sleep 60;"#, 1_000, 1 << 16);
    let seen = finish(&mut h, &run, Duration::from_secs(20));
    assert_eq!(seen.reason.as_deref(), Some("timeout"));
    assert_eq!(String::from_utf8_lossy(&seen.stdout), "begun\n", "what it wrote before is kept");
    assert!(started.elapsed() < Duration::from_secs(15));
    h.shutdown();
}

#[test]
fn a_command_that_ignores_the_first_stop_is_killed_after_the_grace_period() {
    watchdog();
    let mut h = start(&[]);
    let run = run_with(&mut h, 1, r#"$SIG{TERM} = 'IGNORE'; print "up\n"; sleep 60;"#, 1_000, 1 << 16);
    let seen = finish(&mut h, &run, Duration::from_secs(20));
    assert_eq!(seen.reason.as_deref(), Some("timeout"));
    assert_eq!(seen.signal, Some(9), "TERM was ignored, so the process group was killed");
    h.shutdown();
}

#[test]
fn cancel_stops_a_running_command_once_and_is_harmless_afterwards() {
    watchdog();
    let mut h = start(&[]);
    let run = run_with(&mut h, 1, r#"print "working\n"; sleep 60;"#, 60_000, 1 << 16);
    std::thread::sleep(Duration::from_millis(300));
    h.send(&Request::ExecCancel { id: 2, exec_id: run.exec_id });
    assert!(matches!(h.read_reply(2), Response::ExecState { .. }));
    let seen = finish(&mut h, &run, Duration::from_secs(20));
    assert_eq!(seen.reason.as_deref(), Some("cancelled"));
    // A second cancel on a finished run answers with its state and changes nothing.
    h.send(&Request::ExecCancel { id: 3, exec_id: run.exec_id });
    match h.read_reply(3) {
        Response::ExecState { running, reason, .. } => assert_eq!((running, reason.as_deref()), (false, Some("cancelled"))),
        other => panic!("{other:?}"),
    }
    // An unknown run is an error, not a crash.
    h.send(&Request::ExecCancel { id: 4, exec_id: 424242 });
    assert!(matches!(h.read_reply(4), Response::Error { .. }));
    h.shutdown();
}

#[test]
fn several_commands_run_at_once_and_each_keeps_its_own_output() {
    watchdog();
    let mut h = start(&[]);
    let runs: Vec<Run> = (0..5u64).map(|i| run_with(&mut h, 10 + i, &format!(r#"select(undef,undef,undef,0.3); print "run-{i}\n"; exit {i};"#), 20_000, 1 << 16)).collect();
    for (i, run) in runs.iter().enumerate() {
        let seen = finish(&mut h, run, Duration::from_secs(20));
        assert_eq!(String::from_utf8_lossy(&seen.stdout), format!("run-{i}\n"));
        assert_eq!(seen.exit_code, Some(i as i32));
    }
    let ids: std::collections::HashSet<u32> = runs.iter().map(|r| r.exec_id).collect();
    assert_eq!(ids.len(), 5, "every run has its own id");
    h.shutdown();
}

#[test]
fn the_helper_reports_that_a_run_ended_without_being_asked() {
    watchdog();
    let mut h = start(&[]);
    let run = run_with(&mut h, 1, "exit 3;", 20_000, 1 << 16);
    let (_, events) = {
        let deadline = Instant::now() + Duration::from_secs(20);
        let mut events = Vec::new();
        loop {
            let (kind, payload) = h.read_frame();
            if kind == remote_hub_helper::protocol::FRAME_KIND_CONTROL {
                if let Ok(r) = remote_hub_helper::protocol::decode_response(&payload) {
                    let done = matches!(&r, Response::ExecFinished { exec_id, .. } if *exec_id == run.exec_id);
                    events.push(r);
                    if done {
                        break ((), events);
                    }
                }
            }
            assert!(Instant::now() < deadline, "no exec.finished");
        }
    };
    assert!(events.iter().any(|r| matches!(r, Response::ExecFinished { exit_code: Some(3), reason, .. } if reason == "exited")));
    h.shutdown();
}

#[test]
fn forgetting_a_finished_run_drops_it_and_a_running_one_cannot_be_forgotten() {
    watchdog();
    let mut h = start(&[]);
    let slow = run_with(&mut h, 1, "sleep 30;", 60_000, 1 << 16);
    h.send(&Request::ExecForget { id: 2, exec_id: slow.exec_id });
    assert!(matches!(h.read_reply(2), Response::Error { .. }));
    h.send(&Request::ExecCancel { id: 3, exec_id: slow.exec_id });
    let _ = h.read_reply(3);
    let _ = finish(&mut h, &slow, Duration::from_secs(20));
    h.send(&Request::ExecForget { id: 4, exec_id: slow.exec_id });
    assert!(matches!(h.read_reply(4), Response::ExecForgotten { .. }));
    h.send(&Request::ExecRead { id: 5, exec_id: slow.exec_id, stdout_from: 0, stderr_from: 0, max: 10 });
    assert!(matches!(h.read_reply(5), Response::Error { .. }));
    h.shutdown();
}

#[test]
fn limits_outside_their_range_and_more_than_sixteen_live_runs_are_refused() {
    watchdog();
    let mut h = start(&[]);
    let mut env = HashMap::new();
    env.insert("PATH".to_string(), "/usr/bin:/bin".to_string());
    for (i, (timeout_ms, max_bytes)) in [(10u64, 4096usize), (900_000, 4096), (5_000, 10), (5_000, 100 * 1024 * 1024)].into_iter().enumerate() {
        h.send(&Request::ExecRun { id: 50 + i as u64, program: "/usr/bin/perl".into(), argv: vec!["perl".into(), "-e".into(), "exit 0;".into()], env: env.clone(), askpass: None, timeout_ms, max_bytes });
        match h.read_reply(50 + i as u64) {
            Response::Error { code, .. } => assert_eq!(code, "exec_limits_rejected"),
            other => panic!("limits ({timeout_ms}, {max_bytes}) were accepted: {other:?}"),
        }
    }
    let mut started = Vec::new();
    for i in 0..16u64 {
        started.push(run_with(&mut h, 100 + i, "sleep 30;", 60_000, 4096));
    }
    h.send(&Request::ExecRun { id: 200, program: "/usr/bin/perl".into(), argv: vec!["perl".into(), "-e".into(), "exit 0;".into()], env, askpass: None, timeout_ms: 5_000, max_bytes: 4096 });
    match h.read_reply(200) {
        Response::Error { code, .. } => assert_eq!(code, "too_many_runs"),
        other => panic!("the 17th run was accepted: {other:?}"),
    }
    for (i, run) in started.iter().enumerate() {
        h.send(&Request::ExecCancel { id: 300 + i as u64, exec_id: run.exec_id });
        let _ = h.read_reply(300 + i as u64);
    }
    h.shutdown();
}
