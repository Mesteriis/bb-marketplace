//! Stage 3b spike: can the helper create, read and delete a generic password in
//! a TEMPORARY keychain opened by PATH, without touching the login keychain or
//! the user's keychain search list / default keychain?
//!
//! The only `security` command used is the READ-ONLY `list-keychains` and
//! `default-keychain` query, to prove they are unchanged afterwards.
#![cfg(target_os = "macos")]

use security_framework::os::macos::keychain::{CreateOptions, SecKeychain};
use std::process::Command;

fn security(args: &[&str]) -> String {
    let out = Command::new("/usr/bin/security").args(args).output().expect("run security");
    String::from_utf8_lossy(&out.stdout).to_string()
}

#[test]
fn a_temporary_keychain_opened_by_path_holds_a_generic_password_and_nothing_else_changes() {
    let dir = std::env::temp_dir().join(format!("rh-spike-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("spike.keychain-db");

    let list_before = security(&["list-keychains", "-d", "user"]);
    let default_before = security(&["default-keychain", "-d", "user"]);

    let keychain = CreateOptions::new().password("spike-throwaway").create(&path).expect("create by path");
    keychain.set_generic_password("remote-hub-spike", "acct-1", b"S3cr3t-SPIKE-1").expect("store");
    // Reopen BY PATH, as the helper will, and read it back from that keychain only.
    let reopened = SecKeychain::open(&path).expect("open by path");
    let (password, item) = reopened.find_generic_password("remote-hub-spike", "acct-1").expect("read");
    assert_eq!(&*password, b"S3cr3t-SPIKE-1");
    drop(password);
    // Delete the item, and it is gone from that keychain.
    item.delete();
    assert!(reopened.find_generic_password("remote-hub-spike", "acct-1").is_err());

    // The user-level settings are exactly as before.
    assert_eq!(list_before, security(&["list-keychains", "-d", "user"]), "the keychain search list changed");
    assert_eq!(default_before, security(&["default-keychain", "-d", "user"]), "the default keychain changed");
    // The item never reached the login keychain's search path.
    assert!(!security(&["list-keychains", "-d", "user"]).contains("rh-spike"));

    // The temporary keychain is a plain file in a private directory: removing it removes it.
    drop(reopened);
    let _ = std::fs::remove_dir_all(&dir);
}
