//! The PVE path through the REAL helper binary: wire requests in, engine child process, fake PVE (in this
//! process, on a tokio runtime), stream frames and events out. Fixtures only; no real server, no login keychain.
mod common;
#[path = "common/pve_fake.rs"]
mod pve_fake;

use std::time::Duration;

use common::*;
use pve_fake::*;
use remote_hub_helper::binding::Bind;
use remote_hub_helper::keychain::create_at;
use remote_hub_helper::protocol::{decode_response, PveConnect, Request, Response, FRAME_KIND_CONTROL, FRAME_KIND_STREAM};
use remote_hub_helper::pve::protocol::{ConsoleTarget, Trust};
use remote_hub_helper::secret::Secret;

const LEAF_FP: &str = "B6:88:41:D8:62:DD:80:8C:E2:A8:39:E1:26:D1:66:00:9D:51:54:09:DD:16:E2:A7:CB:DF:0D:3B:E1:1D:43:2E";

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

struct World {
    rt: tokio::runtime::Runtime,
    fake: Fake,
}

fn world(state: State) -> World {
    let rt = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().unwrap();
    let fake = rt.block_on(start_fake(state));
    World { rt, fake }
}

fn connect(port: u16, password: Option<&str>, reference: Option<&str>, trust: Trust) -> PveConnect {
    PveConnect {
        host: "127.0.0.1".into(),
        port,
        auth_mode: "ticket".into(),
        user: USER.into(),
        password: password.map(Secret::new),
        credential_ref: reference.map(str::to_string),
        trust,
    }
}

fn ca() -> Trust {
    Trust::Ca { der_hex: hex(CA_DER) }
}

/// Console bytes of session `sid` until `want` has arrived (stream frames: sid u32, seq u32, bytes).
fn read_stream_until(h: &mut Helper, sid: u32, want: &[u8]) -> Vec<u8> {
    let mut got: Vec<u8> = Vec::new();
    let want = want.to_vec();
    h.read_until(Duration::from_secs(20), |k, p| {
        if k == FRAME_KIND_STREAM && p.len() >= 8 && u32::from_le_bytes([p[0], p[1], p[2], p[3]]) == sid {
            got.extend_from_slice(&p[8..]);
            if got.windows(want.len()).any(|w| w == &want[..]) {
                return Some(());
            }
        }
        None
    });
    got
}

fn wait_closed(h: &mut Helper, sid: u32) -> String {
    h.read_until(Duration::from_secs(20), |k, p| {
        if k != FRAME_KIND_CONTROL {
            return None;
        }
        match decode_response(p).ok()? {
            Response::SessionClosed { session_id, reason, .. } if session_id == sid => Some(reason),
            _ => None,
        }
    })
}

fn open_lxc(h: &mut Helper, id: u64, c: PveConnect) -> Response {
    h.send(&Request::OpenPve { id, connect: c, target: ConsoleTarget::Lxc { node: "pve1".into(), vmid: 101 }, cols: 80, rows: 24, keepalive_secs: None });
    h.read_reply(id)
}

#[test]
fn a_console_opens_echoes_resizes_and_closes_through_the_helper() {
    let w = world(default_state());
    let mut h = start(&[]);
    let Response::SessionOpened { session_id, pid, kind, .. } = open_lxc(&mut h, 1, connect(w.fake.port, Some(PASSWORD), None, ca())) else { panic!("not opened") };
    assert_eq!(kind, "pve");
    read_stream_until(&mut h, session_id, b"root@ct101:~# ");
    h.send(&Request::SessionInput { id: 2, session_id, data: "ls\r".into(), owner: None });
    assert!(matches!(h.read_reply(2), Response::SessionInputAck { .. }));
    read_stream_until(&mut h, session_id, b"ls\r");
    h.send(&Request::SessionResize { id: 3, session_id, cols: 100, rows: 30 });
    assert!(matches!(h.read_reply(3), Response::SessionResized { cols: 100, rows: 30, .. }));
    h.send(&Request::SessionInput { id: 4, session_id, data: "x".into(), owner: None });
    read_stream_until(&mut h, session_id, b"x");
    h.send(&Request::SessionClose { id: 5, session_id });
    match h.read_reply(5) {
        Response::SessionClosed { reason, session_id: s, .. } => {
            assert_eq!(s, session_id);
            assert_eq!(reason, "closed_by_user");
        }
        other => panic!("{other:?}"),
    }
    assert!(wait_pid_gone(pid, Duration::from_secs(5)), "the engine outlived its console");
    {
        let st = w.fake.state.lock().unwrap();
        assert_eq!(st.ws_input, b"ls\rx");
        assert_eq!(st.resizes, vec![(80, 24), (100, 30)]);
    }
    h.shutdown();
    drop(w.rt);
}

#[test]
fn input_to_an_unknown_console_is_session_not_found() {
    let mut h = start(&[]);
    h.send(&Request::SessionInput { id: 1, session_id: 9999, data: "x".into(), owner: None });
    match h.read_reply(1) {
        Response::Error { code, .. } => assert_eq!(code, "session_not_found"),
        other => panic!("{other:?}"),
    }
    h.shutdown();
}

#[test]
fn discovery_answers_and_failures_are_distinguishable() {
    let w = world(default_state());
    let mut h = start(&[]);
    h.send(&Request::PveTargets { id: 1, connect: connect(w.fake.port, Some(PASSWORD), None, ca()) });
    match h.read_reply(1) {
        Response::PveTargetsResult { version, nodes, guests, .. } => {
            assert_eq!(version.as_deref(), Some("9.0.3"));
            assert_eq!(nodes.len(), 2);
            assert_eq!(guests.len(), 3);
        }
        other => panic!("{other:?}"),
    }
    h.send(&Request::PveTargets { id: 2, connect: connect(w.fake.port, Some("wrong-PW-1"), None, ca()) });
    assert!(matches!(h.read_reply(2), Response::PveFailed { ref code, .. } if code == "login_failed"));
    h.send(&Request::PveTargets { id: 3, connect: connect(w.fake.port, Some(PASSWORD), None, Trust::System) });
    match h.read_reply(3) {
        Response::PveFailed { code, fingerprint, .. } => {
            assert_eq!(code, "tls_untrusted");
            assert_eq!(fingerprint.as_deref(), Some(LEAF_FP));
        }
        other => panic!("{other:?}"),
    }
    h.send(&Request::PveTargets { id: 4, connect: connect(closed_port(), Some(PASSWORD), None, ca()) });
    assert!(matches!(h.read_reply(4), Response::PveFailed { ref code, .. } if code == "unreachable"));
    h.shutdown();
    drop(w.rt);
}

#[test]
fn a_request_needs_exactly_one_credential_source() {
    let mut h = start(&[]);
    h.send(&Request::PveTargets { id: 1, connect: connect(1, None, None, ca()) });
    assert!(matches!(h.read_reply(1), Response::Error { ref code, .. } if code == "invalid_credential_source"));
    h.send(&Request::PveTargets { id: 2, connect: connect(1, Some("a"), Some("rh-cred-x"), ca()) });
    assert!(matches!(h.read_reply(2), Response::Error { ref code, .. } if code == "invalid_credential_source"));
    h.shutdown();
}

#[test]
fn a_saved_secret_is_used_only_for_the_endpoint_it_was_saved_for() {
    let w = world(default_state());
    let dir = std::env::temp_dir().join(format!("rh-pve-{}", std::process::id()));
    std::os::unix::fs::DirBuilderExt::mode(&mut std::fs::DirBuilder::new(), 0o700).create(&dir).unwrap();
    let path = dir.join("kc.keychain-db");
    create_at(&path, "throwaway-kc-password").expect("temporary keychain");
    let mut h = start(&[("REMOTE_HUB_KEYCHAIN_PATH", path.to_str().unwrap())]);
    let bind = |port: u16| Bind::Endpoint { protocol: "pve".into(), host: "127.0.0.1".into(), port, user: Some(USER.into()), domain: None, cert: None };
    h.send(&Request::CredentialSave { id: 1, reference: "rh-cred:v1:local:0b8e6f4a-5c2d-4e1b-9a37-1f2e3d4c5b01".into(), secret: Secret::new(PASSWORD), bind: bind(w.fake.port) });
    let r1 = h.read_reply(1);
    assert!(matches!(r1, Response::CredentialOk { .. }), "{r1:?}");
    h.send(&Request::CredentialSave { id: 2, reference: "rh-cred:v1:local:0b8e6f4a-5c2d-4e1b-9a37-1f2e3d4c5b02".into(), secret: Secret::new(PASSWORD), bind: bind(w.fake.port + 1) });
    assert!(matches!(h.read_reply(2), Response::CredentialOk { .. }));

    h.send(&Request::PveTargets { id: 3, connect: connect(w.fake.port, None, Some("rh-cred:v1:local:0b8e6f4a-5c2d-4e1b-9a37-1f2e3d4c5b01"), ca()) });
    assert!(matches!(h.read_reply(3), Response::PveTargetsResult { ref guests, .. } if guests.len() == 3));
    h.send(&Request::PveTargets { id: 4, connect: connect(w.fake.port, None, Some("rh-cred:v1:local:0b8e6f4a-5c2d-4e1b-9a37-1f2e3d4c5b02"), ca()) });
    assert!(matches!(h.read_reply(4), Response::Error { ref code, .. } if code == "credential_target_mismatch"));
    // The mismatch was refused in the helper: the fake saw exactly one login (request 3).
    assert_eq!(w.fake.state.lock().unwrap().logins, 1);
    h.shutdown();
    drop(w.rt);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_killed_engine_ends_its_console_as_engine_exited_and_the_helper_carries_on() {
    let w = world(default_state());
    let mut h = start(&[]);
    let Response::SessionOpened { session_id, pid, .. } = open_lxc(&mut h, 1, connect(w.fake.port, Some(PASSWORD), None, ca())) else { panic!() };
    read_stream_until(&mut h, session_id, b"root@ct101:~# ");
    unsafe { libc::kill(pid as libc::pid_t, libc::SIGKILL) };
    assert_eq!(wait_closed(&mut h, session_id), "engine_exited");
    h.send(&Request::Ping { id: 9 });
    assert!(matches!(h.read_reply(9), Response::Pong { .. }));
    h.shutdown();
    drop(w.rt);
}

#[test]
fn shutting_the_helper_down_takes_its_engines_with_it() {
    let w = world(default_state());
    let mut h = start(&[]);
    let Response::SessionOpened { session_id, pid, .. } = open_lxc(&mut h, 1, connect(w.fake.port, Some(PASSWORD), None, ca())) else { panic!() };
    read_stream_until(&mut h, session_id, b"root@ct101:~# ");
    h.shutdown();
    assert!(wait_pid_gone(pid, Duration::from_secs(5)), "the engine survived the helper");
    drop(w.rt);
}

#[test]
fn the_password_is_in_no_argv_and_no_stderr() {
    let w = world(default_state());
    let mut h = start(&[]);
    let Response::SessionOpened { session_id, pid, .. } = open_lxc(&mut h, 1, connect(w.fake.port, Some(PASSWORD), None, ca())) else { panic!() };
    read_stream_until(&mut h, session_id, b"root@ct101:~# ");
    let ps = std::process::Command::new("/bin/ps").args(["-ww", "-o", "command=", "-p", &pid.to_string()]).output().unwrap();
    assert!(!String::from_utf8_lossy(&ps.stdout).contains(PASSWORD));
    assert!(!h.stderr_text().contains(PASSWORD));
    h.shutdown();
    drop(w.rt);
}
