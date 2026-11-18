//! The helper's supervision of its `--keychain-op` child (R1). The child here is a FAKE that
//! never touches a keychain (test-hooks mode `REMOTE_HUB_KEYCHAIN_OP_FAKE`); what is tested is
//! that the helper never hangs, always kills and reaps the child, checks its exit status and
//! survives a SIGCHLD during the wait. Every test runs under a 60 s abort watchdog.
#![cfg(target_os = "macos")]
mod common;

use common::*;
use remote_hub_helper::protocol::{Request, Response};
use std::time::{Duration, Instant};

const REF: &str = "rh-cred:v1:local:0b8e6f4a-5c2d-4e1b-9a37-1f2e3d4c5b6a";

fn watchdog() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        std::thread::spawn(|| {
            std::thread::sleep(Duration::from_secs(60));
            eprintln!("keychain_child tests: watchdog expired; aborting");
            std::process::abort();
        });
    });
}

fn start_with(mode: &str) -> Helper {
    start_timeout(mode, "1500")
}

fn start_timeout(mode: &str, timeout_ms: &str) -> Helper {
    watchdog();
    start(&[("REMOTE_HUB_KEYCHAIN_OP_FAKE", mode), ("REMOTE_HUB_KEYCHAIN_CHILD_TIMEOUT_MS", timeout_ms)])
}

fn status(h: &mut Helper, id: u64) -> Response {
    h.send(&Request::CredentialStatus { id, reference: REF.into() });
    h.read_reply(id)
}

fn code(r: &Response) -> String {
    match r {
        Response::Error { code, .. } => code.clone(),
        other => panic!("expected an error, got {other:?}"),
    }
}

/// Direct children of a process.
fn children_of(pid: u32) -> Vec<String> {
    let out = std::process::Command::new("pgrep").args(["-P", &pid.to_string()]).output().unwrap();
    String::from_utf8_lossy(&out.stdout).lines().map(str::to_string).collect()
}

fn assert_helper_alive_and_clean(h: &mut Helper) {
    h.send(&Request::Ping { id: 900 });
    assert!(matches!(h.read_reply(900), Response::Pong { .. }), "the helper stopped answering");
    assert!(children_of(h.pid()).is_empty(), "a keychain child was left behind: {:?}", children_of(h.pid()));
}

#[test]
fn a_child_that_never_answers_is_killed_within_the_deadline() {
    let mut h = start_with("stall");
    let started = Instant::now();
    assert_eq!(code(&status(&mut h, 1)), "keychain_unavailable");
    assert!(started.elapsed() < Duration::from_secs(4), "took {:?}", started.elapsed());
    assert_helper_alive_and_clean(&mut h);
    h.shutdown();
}

#[test]
fn a_child_that_writes_one_byte_and_stalls_cannot_trap_the_helper() {
    let mut h = start_with("onebyte");
    let started = Instant::now();
    assert_eq!(code(&status(&mut h, 1)), "keychain_unavailable");
    assert!(started.elapsed() < Duration::from_secs(4), "took {:?}", started.elapsed());
    assert_helper_alive_and_clean(&mut h);
    h.shutdown();
}

#[test]
fn a_valid_answer_from_a_child_that_exits_with_failure_is_not_trusted() {
    let mut h = start_with("exit3");
    assert_eq!(code(&status(&mut h, 1)), "keychain_unavailable");
    assert_helper_alive_and_clean(&mut h);
    h.shutdown();
}

#[test]
fn a_sigchld_during_the_wait_is_not_a_timeout() {
    let mut h = start_timeout("slow", "5000"); // the fake answers after 1.5 s: well inside the deadline
    let (_echo, echo_pid) = h.open_echo();
    h.send(&Request::CredentialStatus { id: 1, reference: REF.into() });
    // The helper is now waiting ~1.5 s for the fake child; another child dies meanwhile.
    std::thread::sleep(Duration::from_millis(300));
    unsafe { libc::kill(echo_pid as libc::pid_t, libc::SIGKILL) };
    let reply = h.read_reply(1);
    assert!(matches!(reply, Response::CredentialStatus { present: true, .. }), "an interrupted wait was treated as a failure: {reply:?}");
    h.shutdown();
}
