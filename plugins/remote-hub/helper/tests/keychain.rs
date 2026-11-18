//! The helper's Keychain module against a REAL temporary keychain file opened
//! by path. Nothing here touches the login keychain, the user's keychain search
//! list or the default keychain; the only `security` command used is
//! `lock-keychain <path>`, which acts on that one file.
#![cfg(target_os = "macos")]

use remote_hub_helper::keychain::{create_at, Keychain, KeychainError};
use remote_hub_helper::secret::Secret;
use std::path::PathBuf;
use std::process::Command;

const SENTINEL: &str = "S3cr3t-KC-5150";

/// A keychain call that waits for a dialog would block forever. Every test
/// starts a watchdog that aborts the whole binary after 60 s, so a prompt can
/// never hold a run for minutes.
fn watchdog() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        std::thread::spawn(|| {
            std::thread::sleep(std::time::Duration::from_secs(60));
            eprintln!("keychain tests: watchdog expired after 60 s (a keychain call is blocked); aborting");
            std::process::abort();
        });
    });
}

struct Temp {
    dir: PathBuf,
    path: PathBuf,
}

impl Temp {
    fn new(tag: &str) -> Temp {
        watchdog();
        let dir = std::env::temp_dir().join(format!("rh-kc-{}-{tag}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("test.keychain-db");
        create_at(&path, "throwaway-kc-password").expect("create the temporary keychain");
        Temp { dir, path }
    }
    fn keychain(&self) -> Keychain {
        Keychain::at_path(&self.path)
    }
}

impl Drop for Temp {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

#[test]
fn set_get_overwrite_exists_and_delete_round_trip() {
    let t = Temp::new("rt");
    let kc = t.keychain();
    let account = "rh-cred:v1:local:0b8e6f4a-5c2d-4e1b-9a37-1f2e3d4c5b6a";
    assert_eq!(kc.exists(account), Ok(false));
    assert_eq!(kc.get(account).unwrap_err(), KeychainError::Missing);
    kc.set(account, &Secret::new(SENTINEL)).unwrap();
    assert_eq!(kc.exists(account), Ok(true));
    assert_eq!(kc.get(account).unwrap().expose(), SENTINEL);
    kc.set(account, &Secret::new("second")).unwrap(); // update in place
    assert_eq!(kc.get(account).unwrap().expose(), "second");
    kc.delete(account).unwrap();
    assert_eq!(kc.exists(account), Ok(false));
    assert_eq!(kc.delete(account).unwrap_err(), KeychainError::Missing);
}

#[test]
fn accounts_are_separate_items() {
    let t = Temp::new("acct");
    let kc = t.keychain();
    kc.set("a", &Secret::new("one")).unwrap();
    kc.set("b", &Secret::new("two")).unwrap();
    assert_eq!(kc.get("a").unwrap().expose(), "one");
    assert_eq!(kc.get("b").unwrap().expose(), "two");
    kc.delete("a").unwrap();
    assert_eq!(kc.get("b").unwrap().expose(), "two");
}

#[test]
fn a_locked_keychain_is_an_error_not_a_dialog_and_not_a_fallback() {
    let t = Temp::new("lock");
    let kc = t.keychain();
    kc.set("acct", &Secret::new(SENTINEL)).unwrap();
    let status = Command::new("/usr/bin/security").arg("lock-keychain").arg(&t.path).status().unwrap();
    assert!(status.success());
    // With user interaction disabled the refusal is immediate (no prompt to wait on).
    assert_eq!(kc.get("acct").unwrap_err(), KeychainError::Locked);
    assert_eq!(kc.set("acct", &Secret::new("x")).unwrap_err(), KeychainError::Locked);
    assert_eq!(kc.exists("acct"), Err(KeychainError::Locked));
}

#[test]
fn a_keychain_file_that_does_not_exist_is_unavailable() {
    let kc = Keychain::at_path(std::env::temp_dir().join("rh-kc-does-not-exist-1/none.keychain-db"));
    watchdog();
    let missing = kc.set("a", &Secret::new("x")).unwrap_err();
    assert!(matches!(missing, KeychainError::Unavailable | KeychainError::Missing), "{missing:?}");
    assert!(!std::env::temp_dir().join("rh-kc-does-not-exist-1").exists(), "a missing keychain file must not be created");
}

#[test]
fn nothing_prints_the_secret() {
    let t = Temp::new("dbg");
    let kc = t.keychain();
    kc.set("acct", &Secret::new(SENTINEL)).unwrap();
    let got = kc.get("acct").unwrap();
    assert!(!format!("{got:?} {kc:?}").contains(SENTINEL));
}

/// The switch that allows dialogs is off from the first keychain call on and stays off while
/// other threads use the keychain at the same time (the race a per-call guard had).
#[test]
fn interaction_stays_off_under_concurrent_use() {
    let t = Temp::new("conc");
    let kc = t.keychain();
    kc.set("acct", &Secret::new("one")).unwrap();
    assert!(Keychain::interaction_is_off(), "prompts must be off after the first call");
    let handles: Vec<_> = (0..8)
        .map(|i| {
            let kc = kc.clone();
            std::thread::spawn(move || {
                for n in 0..20 {
                    kc.set(&format!("a{i}"), &Secret::new(format!("v{n}"))).unwrap();
                    assert!(Keychain::interaction_is_off());
                    kc.get(&format!("a{i}")).unwrap();
                }
            })
        })
        .collect();
    for h in handles {
        h.join().unwrap();
    }
    assert!(Keychain::interaction_is_off());
}
