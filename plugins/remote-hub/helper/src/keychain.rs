//! Generic passwords in the macOS Keychain (stage 3b).
//!
//! One service name, one account per credential reference. The helper is the
//! only place a secret is read back: the TypeScript side saves and deletes by
//! reference and never receives one. Every operation runs with Keychain user
//! interaction DISABLED, so a locked keychain or an item the helper may not
//! use without approval is reported as an error instead of a dialog that would
//! block the helper's single event loop. There is no plaintext fallback: when
//! the Keychain refuses, the operation fails with a code.
//!
//! Production builds always use the user's default keychain. A `test-hooks`
//! build can be pointed at a temporary keychain FILE by path with
//! `REMOTE_HUB_KEYCHAIN_PATH` (never through the user's keychain search list
//! or default keychain, which are not touched).
use crate::secret::Secret;

/// The Keychain service every Remote Hub item is stored under.
pub const SERVICE: &str = "remote-hub";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeychainError {
    /// The keychain is locked, or the item needs an approval the helper may not ask for.
    Locked,
    /// The user (or the access control list) refused.
    Denied,
    /// No such item.
    Missing,
    /// No keychain, or any other failure.
    Unavailable,
}

impl KeychainError {
    /// The stable code that crosses the wire.
    pub fn code(self) -> &'static str {
        match self {
            KeychainError::Locked => "keychain_locked",
            KeychainError::Denied => "keychain_denied",
            KeychainError::Missing => "credential_missing",
            KeychainError::Unavailable => "keychain_unavailable",
        }
    }

    pub fn message(self) -> &'static str {
        match self {
            KeychainError::Locked => "the Keychain is locked or needs approval; unlock it and try again",
            KeychainError::Denied => "the Keychain refused access to the saved credential",
            KeychainError::Missing => "the saved credential no longer exists in the Keychain",
            KeychainError::Unavailable => "the Keychain is not available",
        }
    }
}

/// Maps an OSStatus to a KeychainError. Pure, so it is tested without a keychain.
pub fn classify(status: i32) -> KeychainError {
    match status {
        // errSecInteractionNotAllowed, and errSecAuthFailed, which is what a locked
        // keychain answers when it may not ask for its password.
        -25308 | -25293 => KeychainError::Locked,
        -128 => KeychainError::Denied,    // errSecUserCanceled: the user said no
        -25300 => KeychainError::Missing, // errSecItemNotFound
        _ => KeychainError::Unavailable,  // NoDefaultKeychain, NoSuchKeychain, ...
    }
}

#[derive(Clone, Debug)]
enum Target {
    Default,
    #[cfg(feature = "test-hooks")]
    Path(std::path::PathBuf),
}

#[derive(Clone, Debug)]
pub struct Keychain {
    target: Target,
}

impl Keychain {
    /// The keychain this helper process uses: the default one, or (test-hooks
    /// only) the temporary keychain named by REMOTE_HUB_KEYCHAIN_PATH.
    pub fn from_env() -> Keychain {
        #[cfg(feature = "test-hooks")]
        if let Some(path) = std::env::var_os("REMOTE_HUB_KEYCHAIN_PATH") {
            let path = std::path::PathBuf::from(path);
            // Test-only: create the file when asked to, with a throwaway password.
            if !path.exists() {
                if let Some(password) = std::env::var_os("REMOTE_HUB_KEYCHAIN_CREATE_PASSWORD") {
                    let _ = create_at(&path, &password.to_string_lossy());
                }
            }
            return Keychain { target: Target::Path(path) };
        }
        Keychain { target: Target::Default }
    }

    /// A keychain file by path (test-hooks only).
    #[cfg(feature = "test-hooks")]
    pub fn at_path(path: impl Into<std::path::PathBuf>) -> Keychain {
        Keychain { target: Target::Path(path.into()) }
    }

    pub fn set(&self, account: &str, secret: &Secret) -> Result<(), KeychainError> {
        imp::set(&self.target, account, secret.expose().as_bytes())
    }

    pub fn get(&self, account: &str) -> Result<Secret, KeychainError> {
        let bytes = imp::get(&self.target, account)?;
        String::from_utf8(bytes).map(Secret::new).map_err(|_| KeychainError::Unavailable)
    }

    /// Deleting something that is not there is Missing, so a caller can tell.
    pub fn delete(&self, account: &str) -> Result<(), KeychainError> {
        imp::delete(&self.target, account)
    }

    /// Whether the item exists and the keychain would hand it over, without returning it.
    /// Whether the keychain switch that allows dialogs is off in this process.
    #[cfg(target_os = "macos")]
    pub fn interaction_is_off() -> bool {
        imp::interaction_is_off()
    }

    pub fn exists(&self, account: &str) -> Result<bool, KeychainError> {
        match imp::get(&self.target, account) {
            Ok(_) => Ok(true),
            Err(KeychainError::Missing) => Ok(false),
            Err(other) => Err(other),
        }
    }
}

/// Creates a keychain FILE at `path` (test-hooks only). It is not added to the
/// user's search list.
#[cfg(all(feature = "test-hooks", target_os = "macos"))]
pub fn create_at(path: &std::path::Path, password: &str) -> Result<(), KeychainError> {
    security_framework::os::macos::keychain::CreateOptions::new()
        .password(password)
        .create(path)
        .map(|_| ())
        .map_err(|e| classify(e.code()))
}

#[cfg(all(feature = "test-hooks", not(target_os = "macos")))]
pub fn create_at(_path: &std::path::Path, _password: &str) -> Result<(), KeychainError> {
    Err(KeychainError::Unavailable)
}

#[cfg(target_os = "macos")]
mod imp {
    use super::{classify, KeychainError, Target, SERVICE};
    use security_framework::os::macos::keychain::SecKeychain;

    fn open(target: &Target) -> Result<SecKeychain, KeychainError> {
        match target {
            Target::Default => SecKeychain::default().map_err(|e| classify(e.code())),
            #[cfg(feature = "test-hooks")]
            Target::Path(path) => SecKeychain::open(path).map_err(|e| classify(e.code())),
        }
    }

    /// No dialog may ever open: with interaction off, a locked keychain or an
    /// item that needs approval is an error code.
    ///
    /// The Keychain's interaction switch is PROCESS-GLOBAL and the crate's guard
    /// turns it back ON when dropped. A per-call guard therefore races with any
    /// other thread's keychain call: one thread's drop re-enables prompts under
    /// another thread's call (a locked keychain then opens a password dialog and
    /// blocks). So it is switched off ONCE per process, before the first keychain
    /// call, and the guard is leaked: it is never switched back on. Every
    /// operation goes through `quiet()`, which is what makes the switch happen
    /// before that call.
    fn quiet() -> Result<(), KeychainError> {
        static OFF: std::sync::OnceLock<Result<(), KeychainError>> = std::sync::OnceLock::new();
        *OFF.get_or_init(|| match SecKeychain::disable_user_interaction() {
            Ok(guard) => {
                std::mem::forget(guard);
                Ok(())
            }
            Err(e) => Err(classify(e.code())),
        })
    }

    /// Whether prompts are off right now (for tests and for the helper's self-check).
    pub fn interaction_is_off() -> bool {
        matches!(SecKeychain::user_interaction_allowed(), Ok(false))
    }

    pub fn set(target: &Target, account: &str, secret: &[u8]) -> Result<(), KeychainError> {
        quiet()?;
        open(target)?.set_generic_password(SERVICE, account, secret).map_err(|e| classify(e.code()))
    }

    pub fn get(target: &Target, account: &str) -> Result<Vec<u8>, KeychainError> {
        quiet()?;
        let keychain = open(target)?;
        let (password, _item) = keychain.find_generic_password(SERVICE, account).map_err(|e| classify(e.code()))?;
        Ok(password.to_vec())
    }

    pub fn delete(target: &Target, account: &str) -> Result<(), KeychainError> {
        quiet()?;
        let keychain = open(target)?;
        let (_password, item) = keychain.find_generic_password(SERVICE, account).map_err(|e| classify(e.code()))?;
        item.delete();
        Ok(())
    }
}

#[cfg(not(target_os = "macos"))]
mod imp {
    use super::{KeychainError, Target};
    pub fn set(_: &Target, _: &str, _: &[u8]) -> Result<(), KeychainError> {
        Err(KeychainError::Unavailable)
    }
    pub fn get(_: &Target, _: &str) -> Result<Vec<u8>, KeychainError> {
        Err(KeychainError::Unavailable)
    }
    pub fn delete(_: &Target, _: &str) -> Result<(), KeychainError> {
        Err(KeychainError::Unavailable)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn statuses_map_to_stable_codes() {
        assert_eq!(classify(-25308).code(), "keychain_locked");
        assert_eq!(classify(-25293).code(), "keychain_locked"); // what a locked keychain answers without a prompt
        assert_eq!(classify(-128).code(), "keychain_denied");
        assert_eq!(classify(-25300).code(), "credential_missing");
        assert_eq!(classify(-25307).code(), "keychain_unavailable"); // no default keychain
        assert_eq!(classify(-1).code(), "keychain_unavailable");
    }

    #[test]
    fn messages_never_mention_a_secret_or_an_account() {
        for e in [KeychainError::Locked, KeychainError::Denied, KeychainError::Missing, KeychainError::Unavailable] {
            assert!(!e.message().contains("rh-cred"));
        }
    }
}

// ---- the keychain child process ----------------------------------------------
//
// The Security framework starts its own threads on first use, and the helper
// must stay single-threaded (it forks PTY children and RDP engines; see
// threads.rs). So the helper never calls the framework itself: every Keychain
// operation runs in a short-lived child, `remote-hub-helper --keychain-op`, that
// reads ONE JSON request on stdin and writes ONE JSON reply on stdout. The secret
// travels over those pipes only (never argv or the environment) and the child's
// process is gone right after.

use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize)]
pub struct OpRequest {
    pub op: String,
    #[serde(rename = "ref")]
    pub reference: String,
    #[serde(default)]
    pub secret: Option<Secret>,
}

#[derive(Serialize, Deserialize, Default)]
pub struct OpReply {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub present: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub secret: Option<Secret>,
}

/// Executes one request against `keychain`. Pure of I/O, so it is tested directly.
pub fn execute(keychain: &Keychain, request: &OpRequest) -> OpReply {
    let fail = |e: KeychainError| OpReply { error: Some(e.code().to_string()), ..OpReply::default() };
    match (request.op.as_str(), &request.secret) {
        ("save", Some(secret)) => match keychain.set(&request.reference, secret) {
            Ok(()) => OpReply::default(),
            Err(e) => fail(e),
        },
        ("delete", _) => match keychain.delete(&request.reference) {
            Ok(()) => OpReply::default(),
            Err(e) => fail(e),
        },
        ("status", _) => match keychain.exists(&request.reference) {
            Ok(present) => OpReply { present: Some(present), ..OpReply::default() },
            Err(e) => fail(e),
        },
        ("get", _) => match keychain.get(&request.reference) {
            Ok(secret) => OpReply { secret: Some(secret), ..OpReply::default() },
            Err(e) => fail(e),
        },
        _ => OpReply { error: Some("keychain_unavailable".to_string()), ..OpReply::default() },
    }
}

/// The `--keychain-op` entry point: one request in, one reply out.
pub fn run_op() -> i32 {
    use std::io::{Read, Write};
    let mut input = String::new();
    if std::io::stdin().take(64 * 1024).read_to_string(&mut input).is_err() {
        return 2;
    }
    let Ok(request) = serde_json::from_str::<OpRequest>(&input) else { return 2 };
    let reply = execute(&Keychain::from_env(), &request);
    let Ok(text) = serde_json::to_string(&reply) else { return 2 };
    let mut out = std::io::stdout();
    if out.write_all(text.as_bytes()).and_then(|()| out.flush()).is_err() {
        return 2;
    }
    0
}
