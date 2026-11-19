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
use remote_hub_helper::protocol::{decode_response, encode_stream, PveConnect, PveSave, Request, Response, FRAME_KIND_CONTROL, FRAME_KIND_STREAM};
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
fn the_humans_keys_as_a_binary_stream_frame_reach_a_proxmox_terminal() {
    let w = world(default_state());
    let mut h = start(&[]);
    let Response::SessionOpened { session_id, .. } = open_lxc(&mut h, 1, connect(w.fake.port, Some(PASSWORD), None, ca())) else { panic!("not opened") };
    read_stream_until(&mut h, session_id, b"root@ct101:~# ");
    // the same path SSH uses for the human's keys: not a session.input request
    use std::io::Write as _;
    h.stdin.write_all(&encode_stream(session_id, 0, b"pwd\r")).unwrap();
    h.stdin.flush().unwrap();
    read_stream_until(&mut h, session_id, b"pwd\r");
    assert_eq!(w.fake.state.lock().unwrap().ws_input, b"pwd\r");
    h.send(&Request::SessionClose { id: 2, session_id });
    h.read_reply(2);
    h.shutdown();
    drop(w.rt);
}

fn set_owner(h: &mut Helper, id: u64, session_id: u32, owner: &str) -> Response {
    h.send(&Request::SessionSetOwner { id, session_id, owner: owner.into() });
    h.read_reply(id)
}

fn input_as(h: &mut Helper, id: u64, session_id: u32, data: &str, owner: Option<&str>) -> Response {
    h.send(&Request::SessionInput { id, session_id, data: data.into(), owner: owner.map(str::to_string) });
    h.read_reply(id)
}

#[test]
fn only_the_current_driver_may_type_into_a_proxmox_terminal() {
    let w = world(default_state());
    let mut h = start(&[]);
    let Response::SessionOpened { session_id, .. } = open_lxc(&mut h, 1, connect(w.fake.port, Some(PASSWORD), None, ca())) else { panic!("not opened") };
    read_stream_until(&mut h, session_id, b"root@ct101:~# ");
    assert!(matches!(set_owner(&mut h, 2, session_id, "agent:L1"), Response::SessionOwnerSet { .. }));
    // the human (no tag) and an older lease are refused; the current lease is taken
    assert!(matches!(input_as(&mut h, 3, session_id, "human\r", None), Response::Error { code, .. } if code == "stale_owner"));
    assert!(matches!(input_as(&mut h, 4, session_id, "old\r", Some("agent:L0")), Response::Error { code, .. } if code == "stale_owner"));
    assert!(matches!(input_as(&mut h, 5, session_id, "agent\r", Some("agent:L1")), Response::SessionInputAck { .. }));
    read_stream_until(&mut h, session_id, b"agent\r");
    // the human's keys on the stream path are dropped while the agent drives
    use std::io::Write as _;
    h.stdin.write_all(&encode_stream(session_id, 0, b"keys\r")).unwrap();
    h.stdin.flush().unwrap();
    assert!(matches!(set_owner(&mut h, 6, session_id, "human"), Response::SessionOwnerSet { .. }));
    assert!(matches!(input_as(&mut h, 7, session_id, "back\r", None), Response::SessionInputAck { .. }));
    read_stream_until(&mut h, session_id, b"back\r");
    assert_eq!(w.fake.state.lock().unwrap().ws_input, b"agent\rback\r", "only the driver's bytes reached the console");
    h.send(&Request::SessionClose { id: 8, session_id });
    h.read_reply(8);
    h.shutdown();
    drop(w.rt);
}

#[test]
fn a_hand_over_through_the_helper_waits_for_nothing_upstream_and_nothing_of_the_old_driver_is_written_after_it() {
    let w = world(default_state());
    let mut h = start(&[]);
    let Response::SessionOpened { session_id, .. } = open_lxc(&mut h, 1, connect(w.fake.port, Some(PASSWORD), None, ca())) else { panic!("not opened") };
    read_stream_until(&mut h, session_id, b"root@ct101:~# ");
    assert!(matches!(set_owner(&mut h, 2, session_id, "agent:L1"), Response::SessionOwnerSet { .. }));
    // the upstream stops reading and the agent keeps typing
    w.fake.state.lock().unwrap().ws_stall = true;
    let chunk = "a".repeat(16 * 1024);
    let mut sent: u64 = 0;
    for i in 0..40u64 {
        assert!(matches!(input_as(&mut h, 10 + i, session_id, &chunk, Some("agent:L1")), Response::SessionInputAck { .. }));
        sent += chunk.len() as u64;
    }
    std::thread::sleep(Duration::from_millis(400));
    // the takeover (the human takes the console back, or the watcher left) is answered although the transport is blocked
    let started = std::time::Instant::now();
    let Response::SessionOwnerSet { dropped, .. } = set_owner(&mut h, 100, session_id, "human") else { panic!("not owner_set") };
    assert!(started.elapsed() < Duration::from_secs(5), "the hand-over waited for a blocked transport: {:?}", started.elapsed());
    assert!(dropped >= 64 * 1024, "most of what the agent typed was still queued: {dropped}");
    // an old lease's late input is refused, the new driver's goes through
    assert!(matches!(input_as(&mut h, 101, session_id, "late\r", Some("agent:L1")), Response::Error { code, .. } if code == "stale_owner"));
    assert!(matches!(input_as(&mut h, 102, session_id, "NEW\r", None), Response::SessionInputAck { .. }));
    w.fake.state.lock().unwrap().ws_stall = false;
    read_stream_until(&mut h, session_id, b"NEW\r");
    h.send(&Request::SessionClose { id: 103, session_id });
    h.read_reply(103);
    let st = w.fake.state.lock().unwrap();
    assert!(st.ws_input.ends_with(b"NEW\r"));
    assert!(!String::from_utf8_lossy(&st.ws_input).contains("late"));
    let written = st.ws_input.len() as u64 - 4;
    assert_eq!(written + dropped, sent, "written {written} + dropped {dropped} must be what the agent typed {sent}");
    drop(st);
    h.shutdown();
    drop(w.rt);
}

#[test]
fn a_binary_stream_frame_never_reaches_a_graphical_console() {
    let w = world(default_state());
    let mut h = start(&[]);
    h.send(&Request::OpenPve { id: 1, connect: connect(w.fake.port, Some(PASSWORD), None, ca()), target: ConsoleTarget::Qemu { node: "pve1".into(), vmid: 100 }, cols: 80, rows: 24, keepalive_secs: None });
    let Response::SessionOpened { session_id, kind, .. } = h.read_reply(1) else { panic!("not opened") };
    assert_eq!(kind, "vnc");
    // the console's greeting arrives first; then text-style input as a stream frame must be dropped, not relayed as RFB
    read_stream_until(&mut h, session_id, b"RFB 003.008");
    use std::io::Write as _;
    h.stdin.write_all(&encode_stream(session_id, 0, b"not-rfb-bytes")).unwrap();
    h.stdin.flush().unwrap();
    // raw RFB goes through pve.vnc_input, which does reach the console
    h.send(&Request::PveVncInput { id: 2, session_id, data: "UkZCIDAwMy4wMDgK".into() });
    assert!(matches!(h.read_reply(2), Response::SessionInputAck { .. }));
    let mut got = Vec::new();
    for _ in 0..200 {
        got = w.fake.state.lock().unwrap().vnc_input.clone();
        if !got.is_empty() {
            break;
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    assert_eq!(got, b"RFB 003.008\n", "only the vnc_input bytes reached the console");
    h.send(&Request::SessionClose { id: 3, session_id });
    h.read_reply(3);
    h.shutdown();
    drop(w.rt);
}

#[test]
fn the_vnc_password_reaches_the_client_once_and_is_in_no_argv_and_no_stderr() {
    let w = world(default_state());
    let mut h = start(&[]);
    h.send(&Request::OpenPve { id: 1, connect: connect(w.fake.port, Some(PASSWORD), None, ca()), target: ConsoleTarget::Qemu { node: "pve1".into(), vmid: 100 }, cols: 80, rows: 24, keepalive_secs: None });
    let Response::SessionOpened { session_id, pid, .. } = h.read_reply(1) else { panic!("not opened") };
    let mut password = None;
    let mut greeting = Vec::new();
    h.read_until(Duration::from_secs(20), |k, p| {
        if k == FRAME_KIND_CONTROL {
            if let Ok(Response::PveVncPassword { session_id: s, password: pw }) = decode_response(p) {
                assert_eq!(s, session_id);
                password = Some(pw.expose().to_string());
            }
        } else if k == FRAME_KIND_STREAM && p.len() >= 8 && u32::from_le_bytes([p[0], p[1], p[2], p[3]]) == session_id {
            greeting.extend_from_slice(&p[8..]);
        }
        (password.is_some() && greeting.ends_with(b"RFB 003.008\n")).then_some(())
    });
    let issued = w.fake.state.lock().unwrap().vnc_password.clone().expect("the fake issued one");
    assert_eq!(password.as_deref(), Some(issued.as_str()));
    // not in the engine's command line, nor in the helper's stderr
    let args = std::process::Command::new("ps").args(["-ww", "-o", "args=", "-p", &pid.to_string()]).output().unwrap();
    assert!(!String::from_utf8_lossy(&args.stdout).contains(&issued));
    assert!(!h.stderr_text().contains(&issued));
    h.send(&Request::SessionClose { id: 2, session_id });
    h.read_reply(2);
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

fn admin_connect(port: u16) -> PveConnect {
    PveConnect {
        host: "127.0.0.1".into(),
        port,
        auth_mode: "ticket".into(),
        user: ADMIN.into(),
        password: Some(Secret::new(ADMIN_PASSWORD)),
        credential_ref: None,
        trust: ca(),
    }
}

const NEW_REF: &str = "rh-cred:v1:local:0b8e6f4a-5c2d-4e1b-9a37-1f2e3d4c5b77";
const SECOND_REF: &str = "rh-cred:v1:local:0b8e6f4a-5c2d-4e1b-9a37-1f2e3d4c5b78";

fn pve_bind(port: u16, user: &str) -> Bind {
    Bind::Endpoint { protocol: "pve".into(), host: "127.0.0.1".into(), port, user: Some(user.into()), domain: None, cert: None }
}

fn save(reference: &str, port: u16, user: &str) -> PveSave {
    PveSave { reference: reference.into(), bind: pve_bind(port, user) }
}

fn provision(id: u64, port: u16, dry_run: bool, digest: Option<&str>, saves: Vec<PveSave>) -> Request {
    Request::PveProvision {
        id,
        connect: admin_connect(port),
        dry_run,
        acl_path: "/".into(),
        user_id: USER.into(),
        replace_role: false,
        plan_digest: digest.map(str::to_string),
        save: saves,
    }
}

fn digest_of(reply: Response) -> String {
    match reply {
        Response::PvePlan { digest, .. } => digest,
        other => panic!("not a plan: {other:?}"),
    }
}

fn keychain(tag: &str) -> (std::path::PathBuf, std::path::PathBuf) {
    let dir = std::env::temp_dir().join(format!("rh-pve-{tag}-{}", std::process::id()));
    std::os::unix::fs::DirBuilderExt::mode(&mut std::fs::DirBuilder::new(), 0o700).create(&dir).unwrap();
    let path = dir.join("kc.keychain-db");
    create_at(&path, "throwaway-kc-password").expect("temporary keychain");
    (dir, path)
}

#[test]
fn provisioning_saves_the_new_password_in_the_keychain_and_never_returns_it() {
    let w = world(provision_state());
    let (dir, path) = keychain("prov");
    let mut h = start(&[("REMOTE_HUB_KEYCHAIN_PATH", path.to_str().unwrap())]);
    let port = w.fake.port;

    h.send(&provision(1, port, true, None, vec![]));
    let reply = h.read_reply(1);
    match &reply {
        Response::PvePlan { role, user, acl, user_id, .. } => assert_eq!((role.as_str(), user.as_str(), acl.as_str(), user_id.as_str()), ("create", "create", "create", USER)),
        other => panic!("{other:?}"),
    }
    let digest = digest_of(reply);
    assert!(w.fake.state.lock().unwrap().access_writes.is_empty());

    // Refused in the helper, before any call to the server: no digest, nowhere to save, the wrong user, a foreign endpoint.
    h.send(&provision(2, port, false, None, vec![save(NEW_REF, port, USER)]));
    assert!(matches!(h.read_reply(2), Response::Error { ref code, .. } if code == "plan_required"));
    h.send(&provision(3, port, false, Some(&digest), vec![]));
    assert!(matches!(h.read_reply(3), Response::Error { ref code, .. } if code == "invalid_request"));
    h.send(&provision(4, port, false, Some(&digest), vec![save(NEW_REF, port, "root@pam")]));
    assert!(matches!(h.read_reply(4), Response::Error { ref code, .. } if code == "invalid_request"));
    h.send(&provision(5, port, false, Some(&digest), vec![save(NEW_REF, port + 1, USER)]));
    assert!(matches!(h.read_reply(5), Response::Error { ref code, .. } if code == "invalid_request"));
    assert!(w.fake.state.lock().unwrap().access_writes.is_empty(), "a refused request must not reach the server");

    h.send(&provision(6, port, false, Some(&digest), vec![save(NEW_REF, port, USER)]));
    let reply = h.read_reply(6);
    assert!(matches!(reply, Response::PveProvisioned { ref steps, .. } if steps.role == "done" && steps.user == "done" && steps.acl == "done"), "{reply:?}");
    let new_password = w.fake.state.lock().unwrap().users.get(USER).cloned().unwrap();
    assert!(!format!("{reply:?}").contains(&new_password), "the new password came back to the client");

    // The digest is single use.
    h.send(&provision(7, port, false, Some(&digest), vec![save(NEW_REF, port, USER)]));
    assert!(matches!(h.read_reply(7), Response::Error { ref code, .. } if code == "plan_changed"));

    // The saved credential signs in as the created user.
    h.send(&Request::PveTargets { id: 8, connect: connect(port, None, Some(NEW_REF), ca()) });
    assert!(matches!(h.read_reply(8), Response::PveTargetsResult { ref guests, .. } if guests.len() == 3));
    assert!(!h.stderr_text().contains(&new_password));
    assert!(!h.stderr_text().contains(ADMIN_PASSWORD));
    h.shutdown();
    drop(w.rt);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_rotation_updates_every_credential_bound_to_that_user_so_an_older_profile_keeps_working() {
    let w = world(provision_state());
    let (dir, path) = keychain("rot");
    let mut h = start(&[("REMOTE_HUB_KEYCHAIN_PATH", path.to_str().unwrap())]);
    let port = w.fake.port;
    h.send(&provision(1, port, true, None, vec![]));
    let d1 = digest_of(h.read_reply(1));
    h.send(&provision(2, port, false, Some(&d1), vec![save(NEW_REF, port, USER)]));
    assert!(matches!(h.read_reply(2), Response::PveProvisioned { .. }));
    let first_password = w.fake.state.lock().unwrap().users.get(USER).cloned().unwrap();

    // A second run on the same server: the user is ours, so its password is replaced, and BOTH credentials get the new one.
    h.send(&provision(3, port, true, None, vec![]));
    let plan = h.read_reply(3);
    assert!(matches!(&plan, Response::PvePlan { user, .. } if user == "rotate_password"), "{plan:?}");
    let d2 = digest_of(plan);
    h.send(&provision(4, port, false, Some(&d2), vec![save(NEW_REF, port, USER), save(SECOND_REF, port, USER)]));
    assert!(matches!(h.read_reply(4), Response::PveProvisioned { .. }));
    let second_password = w.fake.state.lock().unwrap().users.get(USER).cloned().unwrap();
    assert_ne!(first_password, second_password);
    for (n, reference) in [(5u64, NEW_REF), (6, SECOND_REF)] {
        h.send(&Request::PveTargets { id: n, connect: connect(port, None, Some(reference), ca()) });
        assert!(matches!(h.read_reply(n), Response::PveTargetsResult { .. }), "the credential {reference} must hold the new password");
    }
    h.shutdown();
    drop(w.rt);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_failure_after_the_user_step_still_leaves_a_working_saved_password_and_the_steps_say_so() {
    let mut st = provision_state();
    st.fail_acl_put = true;
    let w = world(st);
    let (dir, path) = keychain("partial");
    let mut h = start(&[("REMOTE_HUB_KEYCHAIN_PATH", path.to_str().unwrap())]);
    let port = w.fake.port;
    h.send(&provision(1, port, true, None, vec![]));
    let digest = digest_of(h.read_reply(1));
    h.send(&provision(2, port, false, Some(&digest), vec![save(NEW_REF, port, USER)]));
    match h.read_reply(2) {
        Response::PveFailed { code, steps: Some(steps), .. } => {
            assert_eq!(code, "api_error");
            assert_eq!((steps.role.as_str(), steps.user.as_str(), steps.acl.as_str()), ("done", "done", "failed"));
        }
        other => panic!("{other:?}"),
    }
    // The password that is active on the server is in the Keychain: the login works (the fake does not model ACLs for reads).
    h.send(&Request::PveTargets { id: 3, connect: connect(port, None, Some(NEW_REF), ca()) });
    assert!(matches!(h.read_reply(3), Response::PveTargetsResult { .. }), "the saved password must be the one active on the server");
    h.shutdown();
    drop(w.rt);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn provisioning_needs_a_password_for_this_setup_not_a_saved_credential() {
    let mut h = start(&[]);
    let mut c = admin_connect(1);
    c.password = None;
    c.credential_ref = Some(NEW_REF.into());
    h.send(&Request::PveProvision { id: 1, connect: c, dry_run: true, acl_path: "/".into(), user_id: USER.into(), replace_role: false, plan_digest: None, save: vec![] });
    assert!(matches!(h.read_reply(1), Response::Error { ref code, .. } if code == "invalid_credential_source"));
    h.shutdown();
}

#[test]
fn what_the_server_says_in_an_error_never_reaches_the_client() {
    let mut st = default_state();
    st.echo_after_login = true;
    let w = world(st);
    let mut h = start(&[]);
    h.send(&Request::PveTargets { id: 1, connect: connect(w.fake.port, Some(PASSWORD), None, ca()) });
    match h.read_reply(1) {
        Response::PveFailed { code, message, .. } => {
            assert_eq!(code, "api_error");
            assert_eq!(message, "PVE answered 500");
        }
        other => panic!("{other:?}"),
    }
    assert!(!h.stderr_text().contains(PASSWORD));
    h.shutdown();
    drop(w.rt);
}
