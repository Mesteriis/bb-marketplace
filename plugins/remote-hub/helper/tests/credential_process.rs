//! Saved credentials through the REAL helper process (stage 3b-1): credential.save /
//! status / delete and `session.open_rdp` with a `credentialRef`, against a
//! TEMPORARY keychain file the helper opens by path (test-hooks only). The login
//! keychain and the user's keychain list are never touched. A 60 s watchdog
//! aborts the binary so a keychain call can never hold a run.
#![cfg(target_os = "macos")]
mod common;

use common::*;
use remote_hub_helper::binding::Bind;
use remote_hub_helper::keychain::create_at;
use remote_hub_helper::protocol::{Request, Response};
use remote_hub_helper::secret::Secret;
use std::path::PathBuf;
use std::process::Command;

const FAKE: &str = "REMOTE_HUB_RDP_FAKE_ENGINE";
const SECRET: &str = "S3cr3t-CRED-1";
/// First 16 hex of SHA-256("S3cr3t-CRED-1"), computed outside this test.
const SECRET_DIGEST: &str = "8f430ef2e624ec5f";
const REF: &str = "rh-cred:v1:local:0b8e6f4a-5c2d-4e1b-9a37-1f2e3d4c5b6a";

fn watchdog() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        std::thread::spawn(|| {
            std::thread::sleep(std::time::Duration::from_secs(60));
            eprintln!("credential tests: watchdog expired after 60 s; aborting");
            std::process::abort();
        });
    });
}

/// The binding of the saved password for the RDP endpoint the tests open (127.0.0.1:<port> as "tester").
fn rdp_bind(port: u16) -> Bind {
    Bind::Endpoint { protocol: "rdp".into(), host: "127.0.0.1".into(), port, user: Some("tester".into()), domain: None, cert: None }
}

struct Fixture {
    dir: PathBuf,
    path: PathBuf,
    helper: Option<Helper>,
    /// The port the next `save` binds the password to.
    bind_port: u16,
}

impl Fixture {
    fn new(tag: &str) -> Fixture {
        Fixture::with_mode(tag, "credential")
    }
    fn with_mode(tag: &str, mode: &str) -> Fixture {
        watchdog();
        let dir = std::env::temp_dir().join(format!("rh-cred-{}-{tag}", std::process::id()));
        std::os::unix::fs::DirBuilderExt::mode(&mut std::fs::DirBuilder::new(), 0o700).create(&dir).unwrap();
        let path = dir.join("kc.keychain-db");
        create_at(&path, "throwaway-kc-password").expect("temporary keychain");
        let helper = start(&[(FAKE, mode), ("REMOTE_HUB_KEYCHAIN_PATH", path.to_str().unwrap())]);
        Fixture { dir, path, helper: Some(helper), bind_port: 3389 }
    }
    /// A new helper process on the SAME temporary keychain, whose engine presents another certificate.
    fn restart(&mut self, mode: &str) {
        self.helper.take().unwrap().shutdown();
        self.helper = Some(start(&[(FAKE, mode), ("REMOTE_HUB_KEYCHAIN_PATH", self.path.to_str().unwrap())]));
    }
    fn h(&mut self) -> &mut Helper {
        self.helper.as_mut().unwrap()
    }
    fn save(&mut self, id: u64, reference: &str, secret: &str) -> Response {
        let bind = rdp_bind(self.bind_port);
        self.save_bound(id, reference, secret, bind)
    }
    fn save_bound(&mut self, id: u64, reference: &str, secret: &str, bind: Bind) -> Response {
        self.h().send(&Request::CredentialSave { id, reference: reference.into(), secret: Secret::new(secret), bind });
        self.h().read_reply(id)
    }
    fn status(&mut self, id: u64, reference: &str) -> Response {
        self.h().send(&Request::CredentialStatus { id, reference: reference.into() });
        self.h().read_reply(id)
    }
    fn delete(&mut self, id: u64, reference: &str) -> Response {
        self.h().send(&Request::CredentialDelete { id, reference: reference.into() });
        self.h().read_reply(id)
    }
    fn open_with(&mut self, id: u64, password: Option<&str>, reference: Option<&str>, port: u16) -> Response {
        self.h().send(&Request::OpenRdp {
            id,
            host: "127.0.0.1".into(),
            port,
            username: "tester".into(),
            password: password.map(Secret::new),
            credential_ref: reference.map(str::to_string),
            domain: None,
            width: 800,
            height: 600,
            expected_fingerprint: None,
        });
        self.h().read_reply(id)
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        if let Some(h) = self.helper.take() {
            h.shutdown();
        }
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn code(r: &Response) -> String {
    match r {
        Response::Error { code, .. } => code.clone(),
        other => panic!("expected an error, got {other:?}"),
    }
}

#[test]
fn a_saved_credential_is_resolved_by_the_helper_and_reaches_the_engine_only() {
    let mut f = Fixture::new("save");
    let server = silent_server();
    f.bind_port = server.port;
    assert!(matches!(f.status(1, REF), Response::CredentialStatus { present: false, .. }));
    assert!(matches!(f.save(2, REF, SECRET), Response::CredentialOk { .. }));
    assert!(matches!(f.status(3, REF), Response::CredentialStatus { present: true, .. }));
    let opened = f.open_with(4, None, Some(REF), server.port);
    let Response::SessionOpened { session_id, .. } = opened else { panic!("expected session.opened, got {opened:?}") };
    // The engine got exactly the saved password: its digest, never the password, is reported.
    let wanted = format!("pw_sha256={SECRET_DIGEST}");
    f.h().wait_state(session_id, &wanted);
    // Neither the helper's stderr nor anything printed with Debug mentions the secret.
    assert!(!f.h().stderr_text().contains(SECRET));
    assert!(!format!("{opened:?}").contains(SECRET));
}

#[test]
fn a_deleted_credential_cannot_be_used_and_the_error_is_a_code() {
    let mut f = Fixture::new("del");
    let server = silent_server();
    f.bind_port = server.port;
    f.save(1, REF, SECRET);
    assert!(matches!(f.delete(2, REF), Response::CredentialOk { .. }));
    assert!(matches!(f.status(3, REF), Response::CredentialStatus { present: false, .. }));
    assert_eq!(code(&f.delete(4, REF)), "credential_missing");
    assert_eq!(code(&f.open_with(5, None, Some(REF), server.port)), "credential_missing");
}

#[test]
fn the_helper_only_touches_its_own_references() {
    let mut f = Fixture::new("ref");
    for bad in ["login", "rh-cred:v1:local:UPPER", "../../x", "rh-cred:v2:local:abc", &format!("rh-cred:v1:{}", "a".repeat(100))] {
        assert_eq!(code(&f.save(1, bad, SECRET)), "invalid_credential_ref", "{bad}");
        assert_eq!(code(&f.status(2, bad)), "invalid_credential_ref", "{bad}");
        assert_eq!(code(&f.delete(3, bad)), "invalid_credential_ref", "{bad}");
        assert_eq!(code(&f.open_with(4, None, Some(bad), 1)), "invalid_credential_ref", "{bad}");
    }
}

#[test]
fn open_rdp_takes_exactly_one_secret_source() {
    let mut f = Fixture::new("src");
    f.save(1, REF, SECRET);
    assert_eq!(code(&f.open_with(2, Some("typed"), Some(REF), 1)), "invalid_credential_source");
    assert_eq!(code(&f.open_with(3, None, None, 1)), "invalid_credential_source");
}

#[test]
fn a_locked_keychain_is_a_code_for_every_operation_and_never_a_fallback() {
    let mut f = Fixture::new("lock");
    let server = silent_server();
    f.bind_port = server.port;
    f.save(1, REF, SECRET);
    let status = Command::new("/usr/bin/security").arg("lock-keychain").arg(&f.path).status().unwrap();
    assert!(status.success());
    assert_eq!(code(&f.status(2, REF)), "keychain_locked");
    assert_eq!(code(&f.save(3, REF, "other")), "keychain_locked");
    assert_eq!(code(&f.delete(4, REF)), "keychain_locked");
    assert_eq!(code(&f.open_with(5, None, Some(REF), server.port)), "keychain_locked");
    assert!(!f.h().stderr_text().contains(SECRET));
}

/// A test-hooks helper that was NOT given a temporary keychain has no keychain at all:
/// it must never fall back to the user's default (login) keychain.
#[test]
fn a_test_helper_without_a_named_keychain_has_none_and_never_uses_the_login_keychain() {
    watchdog();
    let mut h = start(&[]);
    h.send(&Request::CredentialSave { id: 1, reference: REF.into(), secret: Secret::new(SECRET), bind: rdp_bind(3389) });
    assert_eq!(code(&h.read_reply(1)), "keychain_unavailable");
    h.send(&Request::CredentialStatus { id: 2, reference: REF.into() });
    assert_eq!(code(&h.read_reply(2)), "keychain_unavailable");
    h.send(&Request::CredentialDelete { id: 3, reference: REF.into() });
    assert_eq!(code(&h.read_reply(3)), "keychain_unavailable");
    h.shutdown();
}

/// A named keychain that does not exist is an error, never a write to the default keychain.
#[test]
fn a_named_keychain_that_does_not_exist_is_unavailable() {
    watchdog();
    let missing = std::env::temp_dir().join(format!("rh-cred-{}-missing/none.keychain-db", std::process::id()));
    let mut h = start(&[("REMOTE_HUB_KEYCHAIN_PATH", missing.to_str().unwrap())]);
    h.send(&Request::CredentialSave { id: 1, reference: REF.into(), secret: Secret::new(SECRET), bind: rdp_bind(3389) });
    assert_eq!(code(&h.read_reply(1)), "keychain_unavailable");
    assert!(!missing.exists());
    h.shutdown();
}

/// S2: the helper itself refuses to hand a saved password to anywhere but where it was saved for.
#[test]
fn the_helper_refuses_a_saved_password_for_any_other_endpoint_kind_or_key() {
    let mut f = Fixture::new("bind");
    let server = silent_server();
    let ok_port = server.port;
    let mismatches: Vec<(&str, Bind)> = vec![
        ("host", Bind::Endpoint { protocol: "rdp".into(), host: "localhost".into(), port: ok_port, user: Some("tester".into()), domain: None, cert: None }),
        ("port", rdp_bind(ok_port.wrapping_add(1).max(1))),
        ("user", Bind::Endpoint { protocol: "rdp".into(), host: "127.0.0.1".into(), port: ok_port, user: Some("other".into()), domain: None, cert: None }),
        ("domain", Bind::Endpoint { protocol: "rdp".into(), host: "127.0.0.1".into(), port: ok_port, user: Some("tester".into()), domain: Some("CORP".into()), cert: None }),
        ("protocol (an ssh password)", Bind::Endpoint { protocol: "ssh".into(), host: "127.0.0.1".into(), port: ok_port, user: Some("tester".into()), domain: None, cert: None }),
        ("kind (a key passphrase)", Bind::Key { path: "/keys/id".into() }),
    ];
    for (n, (what, bind)) in mismatches.into_iter().enumerate() {
        let id = 10 + n as u64 * 3;
        assert!(matches!(f.save_bound(id, REF, SECRET, bind), Response::CredentialOk { .. }), "{what}: save");
        assert_eq!(code(&f.open_with(id + 1, None, Some(REF), ok_port)), "credential_target_mismatch", "{what}");
    }
    // The right binding opens, so the refusals above were about the binding and nothing else.
    f.save_bound(50, REF, SECRET, rdp_bind(ok_port));
    assert!(matches!(f.open_with(51, None, Some(REF), ok_port), Response::SessionOpened { .. }));
    assert!(!f.h().stderr_text().contains(SECRET));
}

/// A secret saved before bindings existed (a bare value) is never used: it is "unbound".
#[test]
fn a_legacy_item_without_a_binding_is_never_used() {
    let mut f = Fixture::new("legacy");
    let server = silent_server();
    // Written into the temporary keychain by the helper binary itself (so its ACL trusts it), as a
    // pre-binding helper would have: a bare secret.
    use std::io::Write;
    let mut child = Command::new(env!("CARGO_BIN_EXE_remote-hub-helper"))
        .arg("--keychain-op")
        .env("REMOTE_HUB_TEST_ANY_PARENT", "1")
        .env("REMOTE_HUB_KEYCHAIN_PATH", &f.path)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .unwrap();
    child.stdin.take().unwrap().write_all(format!("{{\"op\":\"save_raw\",\"ref\":\"{REF}\",\"secret\":\"{SECRET}\"}}").as_bytes()).unwrap();
    let out = child.wait_with_output().unwrap();
    assert!(out.status.success() && !String::from_utf8_lossy(&out.stdout).contains("error"), "raw save failed");
    assert_eq!(code(&f.open_with(1, None, Some(REF), server.port)), "credential_unbound");
    // A save with an invalid binding is refused too.
    let empty = Bind::Key { path: String::new() };
    assert_eq!(code(&f.save_bound(2, REF, SECRET, empty)), "invalid_bind");
}

/// T2 (RDP): a non-ASCII password survives save (Keychain envelope) and open (engine) byte for byte.
#[test]
fn a_non_ascii_rdp_password_reaches_the_engine_byte_for_byte() {
    let mut f = Fixture::new("utf8");
    let server = silent_server();
    f.bind_port = server.port;
    // SHA-256 of the UTF-8 bytes, first 16 hex, computed outside this test.
    assert!(matches!(f.save(1, REF, "pässwörd-é€-CRED-3"), Response::CredentialOk { .. }));
    let opened = f.open_with(2, None, Some(REF), server.port);
    let Response::SessionOpened { session_id, .. } = opened else { panic!("expected session.opened, got {opened:?}") };
    f.h().wait_state(session_id, "pw_sha256=d7ab5ce8b41ce7bf");
}

/// T5: a bare legacy secret that happens to LOOK like an envelope (same keys, no marker) is never taken for one.
#[test]
fn a_legacy_secret_shaped_like_an_envelope_is_still_unbound() {
    use std::io::Write;
    let mut f = Fixture::new("lookalike");
    let server = silent_server();
    let fake = format!(
        r#"{{\"v\":1,\"bind\":{{\"type\":\"endpoint\",\"protocol\":\"rdp\",\"host\":\"127.0.0.1\",\"port\":{},\"user\":\"tester\",\"domain\":null}},\"secret\":\"x\"}}"#,
        server.port
    );
    let mut child = Command::new(env!("CARGO_BIN_EXE_remote-hub-helper"))
        .arg("--keychain-op")
        .env("REMOTE_HUB_TEST_ANY_PARENT", "1")
        .env("REMOTE_HUB_KEYCHAIN_PATH", &f.path)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .unwrap();
    child.stdin.take().unwrap().write_all(format!("{{\"op\":\"save_raw\",\"ref\":\"{REF}\",\"secret\":\"{fake}\"}}").as_bytes()).unwrap();
    let out = child.wait_with_output().unwrap();
    assert!(out.status.success() && !String::from_utf8_lossy(&out.stdout).contains("error"), "raw save failed");
    assert_eq!(code(&f.open_with(1, None, Some(REF), server.port)), "credential_unbound");
}

const CERT_A: &str = "AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99";
const CERT_B: &str = "99:88:77:66:55:44:33:22:11:00:FF:EE:DD:CC:BB:AA:99:88:77:66:55:44:33:22:11:00:FF:EE:DD:CC:BB:AA";

fn opened_session(f: &mut Fixture, id: u64, port: u16) -> u32 {
    let opened = f.open_with(id, None, Some(REF), port);
    let Response::SessionOpened { session_id, .. } = opened else { panic!("expected session.opened, got {opened:?}") };
    session_id
}

/// T4: the first certificate that is accepted for a saved password is pinned to it, by the helper;
/// a later open that meets another certificate is closed as cert_changed before the password is used.
#[test]
fn a_saved_rdp_password_is_pinned_to_the_first_certificate_and_a_changed_one_never_gets_it() {
    let server = silent_server();
    let mut f = Fixture::with_mode("pin", &format!("cert:{CERT_A}"));
    f.bind_port = server.port;
    assert!(matches!(f.save(1, REF, SECRET), Response::CredentialOk { .. }));
    // First use: accepted and pinned (the engine reports the password digest only after the certificate).
    let sid = opened_session(&mut f, 2, server.port);
    f.h().wait_state(sid, &format!("pw_sha256={SECRET_DIGEST}"));
    // The same certificate again: fine.
    f.restart(&format!("cert:{CERT_A}"));
    let sid = opened_session(&mut f, 3, server.port);
    f.h().wait_state(sid, &format!("pw_sha256={SECRET_DIGEST}"));
    // Another certificate: closed as cert_changed, and the password digest is never reported.
    f.restart(&format!("cert:{CERT_B}"));
    let sid = opened_session(&mut f, 4, server.port);
    let (_, _, reason) = f.h().read_closed(sid);
    assert_eq!(reason, "cert_changed");
}

/// Saving the password again starts over: the new first certificate is pinned.
#[test]
fn saving_the_password_again_forgets_the_pin() {
    let server = silent_server();
    let mut f = Fixture::with_mode("repin", &format!("cert:{CERT_A}"));
    f.bind_port = server.port;
    assert!(matches!(f.save(1, REF, SECRET), Response::CredentialOk { .. }));
    let sid = opened_session(&mut f, 2, server.port);
    f.h().wait_state(sid, &format!("pw_sha256={SECRET_DIGEST}"));
    f.restart(&format!("cert:{CERT_B}"));
    assert!(matches!(f.save(3, REF, SECRET), Response::CredentialOk { .. }));
    let sid = opened_session(&mut f, 4, server.port);
    f.h().wait_state(sid, &format!("pw_sha256={SECRET_DIGEST}"));
    f.restart(&format!("cert:{CERT_A}"));
    let sid = opened_session(&mut f, 5, server.port);
    assert_eq!(f.h().read_closed(sid).2, "cert_changed");
}

/// A pin in the binding itself (as a caller can save one) is enforced from the very first open, and a
/// caller-supplied expected fingerprint cannot replace it.
#[test]
fn a_pin_given_at_save_time_is_enforced_even_against_the_callers_expected_fingerprint() {
    let server = silent_server();
    let mut f = Fixture::with_mode("given", &format!("cert:{CERT_B}"));
    let bind = Bind::Endpoint { protocol: "rdp".into(), host: "127.0.0.1".into(), port: server.port, user: Some("tester".into()), domain: None, cert: Some(CERT_A.into()) };
    assert!(matches!(f.save_bound(1, REF, SECRET, bind), Response::CredentialOk { .. }));
    f.h().send(&Request::OpenRdp {
        id: 2,
        host: "127.0.0.1".into(),
        port: server.port,
        username: "tester".into(),
        password: None,
        credential_ref: Some(REF.into()),
        domain: None,
        width: 800,
        height: 600,
        expected_fingerprint: Some(CERT_B.into()),
    });
    let Response::SessionOpened { session_id, .. } = f.h().read_reply(2) else { panic!("expected session.opened") };
    assert_eq!(f.h().read_closed(session_id).2, "cert_changed");
}

/// A password typed for one use has no pin to keep: the certificate decision stays the user's.
#[test]
fn a_typed_password_is_not_pinned() {
    let server = silent_server();
    let mut f = Fixture::with_mode("typed", &format!("cert:{CERT_A}"));
    let opened = f.open_with(1, Some(SECRET), None, server.port);
    let Response::SessionOpened { session_id, .. } = opened else { panic!("expected session.opened, got {opened:?}") };
    f.h().wait_state(session_id, &format!("pw_sha256={SECRET_DIGEST}"));
}
