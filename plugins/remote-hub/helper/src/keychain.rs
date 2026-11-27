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
use crate::binding::Bind;
use crate::secret::Secret;
use serde::{Deserialize, Serialize};

/// The only account names the helper will touch in the Keychain: our own
/// references (rh-cred:v1:<executionHostId>:<uuid>). A request cannot name any
/// other Keychain item.
pub fn valid_credential_ref(reference: &str) -> bool {
    reference.starts_with("rh-cred:v1:")
        && reference.len() <= 96
        && reference.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b':' || b == b'-')
}

/// The Keychain service every Remote Hub item is stored under.
pub const SERVICE: &str = "remote-hub";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeychainError {
    /// The login keychain is locked (or the lock state could not be read: the message then names both remedies).
    Locked,
    /// The keychain is unlocked but macOS has not allowed THIS helper build to read the item (an item made by an earlier build
    /// of the unsigned helper): only the owner's "Allow access" action, which lets macOS ask, can fix it.
    NeedsApproval,
    /// The user (or the access control list) refused.
    Denied,
    /// No such item.
    Missing,
    /// No keychain, or any other failure.
    Unavailable,
    /// The central Credential Vault could not safely complete the operation.
    VaultUnavailable,
    /// The item exists but carries no binding (saved before bindings existed): it is never used.
    Unbound,
}

impl KeychainError {
    /// The stable code that crosses the wire.
    pub fn code(self) -> &'static str {
        match self {
            KeychainError::Locked => "keychain_locked",
            KeychainError::NeedsApproval => "keychain_needs_approval",
            KeychainError::Denied => "keychain_denied",
            KeychainError::Missing => "credential_missing",
            KeychainError::Unavailable => "keychain_unavailable",
            KeychainError::Unbound => "credential_unbound",
            KeychainError::VaultUnavailable => "vault_unavailable",
        }
    }

    pub fn message(self) -> &'static str {
        match self {
            KeychainError::Locked => "the login Keychain is locked, or macOS has not allowed this Remote Hub build to read the saved credential; unlock the Keychain, then use Allow access",
            KeychainError::NeedsApproval => "macOS has not allowed this Remote Hub build to read the saved credential (the helper was updated); use Allow access and choose Always Allow",
            KeychainError::Denied => "the Keychain refused access to the saved credential",
            KeychainError::Missing => "the saved credential no longer exists in the Keychain",
            KeychainError::Unavailable => "the Keychain is not available",
            KeychainError::Unbound => "this saved credential has no binding; save it again",
            KeychainError::VaultUnavailable => "Credential Vault is unavailable; check its status in BB",
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

/// What the Keychain item holds: the secret and its binding, as one JSON value.
#[derive(Serialize, Deserialize)]
struct StoredItem {
    /// Fixed marker: a bare legacy secret that merely parses as JSON is never taken for an envelope.
    magic: String,
    v: u8,
    bind: Bind,
    secret: Secret,
}

const ENVELOPE_MAGIC: &str = "remote-hub/credential-envelope";

pub struct Item {
    pub bind: Bind,
    pub secret: Secret,
}

#[derive(Clone, Debug)]
enum Target {
    #[cfg(not(feature = "test-hooks"))]
    Default,
    #[cfg(feature = "test-hooks")]
    Path(std::path::PathBuf),
    /// A test-hooks build with no keychain named: there is NO default. No test may reach
    /// the user's login keychain by forgetting to name a temporary one.
    #[cfg(feature = "test-hooks")]
    Unconfigured,
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
        #[cfg(feature = "test-hooks")]
        return Keychain { target: Target::Unconfigured };
        #[cfg(not(feature = "test-hooks"))]
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

    /// Saves the secret TOGETHER with what it is for, as one Keychain item.
    pub fn set_item(&self, account: &str, bind: &Bind, secret: &Secret) -> Result<(), KeychainError> {
        self.set(account, &Secret::new(encode_item(bind, secret)?))
    }

    /// The secret and its binding. An item without a binding is `Unbound`, never a bare secret.
    pub fn get_item(&self, account: &str) -> Result<Item, KeychainError> {
        decode_item(self.get(account)?.expose())
    }

    /// The owner's "Allow access": ONE read with interaction enabled. Never call this from the long-lived helper; `run_op` only.
    pub fn allow(&self, account: &str) -> Result<(), KeychainError> {
        imp::get_interactive(&self.target, account).map(|_| ())
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

/// Validates a keychain path BEFORE any Security call: the file must be a regular file (not a
/// symlink) owned by us, in a directory that is a real directory (not a symlink) owned by us and
/// closed to everyone else (0700). Test-hooks only: production never names a keychain by path.
#[cfg(all(feature = "test-hooks", unix))]
fn validate_keychain_path(path: &std::path::Path) -> Result<(), KeychainError> {
    use std::os::unix::fs::MetadataExt;
    let euid = unsafe { libc::geteuid() };
    validate_keychain_dir(path.parent().ok_or(KeychainError::Unavailable)?)?;
    let file = std::fs::symlink_metadata(path).map_err(|_| KeychainError::Unavailable)?;
    if !file.file_type().is_file() || file.uid() != euid {
        return Err(KeychainError::Unavailable);
    }
    Ok(())
}

/// Which file a path names right now: device and inode (the path itself is not followed if it is a link).
#[cfg(all(feature = "test-hooks", unix))]
fn file_identity(path: &std::path::Path) -> Option<(u64, u64)> {
    use std::os::unix::fs::MetadataExt;
    std::fs::symlink_metadata(path).ok().map(|m| (m.dev(), m.ino()))
}

#[cfg(all(feature = "test-hooks", unix))]
fn validate_keychain_dir(dir: &std::path::Path) -> Result<(), KeychainError> {
    use std::os::unix::fs::MetadataExt;
    let euid = unsafe { libc::geteuid() };
    let meta = std::fs::symlink_metadata(dir).map_err(|_| KeychainError::Unavailable)?;
    if !meta.file_type().is_dir() || meta.uid() != euid || meta.mode() & 0o077 != 0 {
        return Err(KeychainError::Unavailable);
    }
    Ok(())
}

/// Creates a keychain FILE at `path` (test-hooks only). It is not added to the user's search
/// list. The directory must be one the caller owns exclusively (0700, not a symlink), the file
/// must not exist yet, and user interaction is switched off BEFORE anything is created.
#[cfg(all(feature = "test-hooks", target_os = "macos"))]
pub fn create_at(path: &std::path::Path, password: &str) -> Result<(), KeychainError> {
    validate_keychain_dir(path.parent().ok_or(KeychainError::Unavailable)?)?;
    if std::fs::symlink_metadata(path).is_ok() {
        return Err(KeychainError::Unavailable); // exclusive: never adopt or follow an existing entry
    }
    imp::prepare()?;
    security_framework::os::macos::keychain::CreateOptions::new()
        .password(password)
        .create(path)
        .map_err(|e| classify(e.code()))?;
    validate_keychain_path(path)
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
            #[cfg(not(feature = "test-hooks"))]
            Target::Default => SecKeychain::default().map_err(|e| classify(e.code())),
            #[cfg(feature = "test-hooks")]
            Target::Unconfigured => Err(KeychainError::Unavailable),
            #[cfg(feature = "test-hooks")]
            Target::Path(path) => {
                // Validated BEFORE any Security call (see validate_keychain_path), then verified
                // AFTER the open: SecKeychainOpen hands back a reference even for a file that is
                // not there or was swapped, and a write through such a reference lands in the
                // user's DEFAULT keychain. So the reference must report exactly the intended file
                // and a healthy status, or the operation fails closed.
                super::validate_keychain_path(path)?;
                let before = super::file_identity(path).ok_or(KeychainError::Unavailable)?;
                let keychain = SecKeychain::open(path).map_err(|e| classify(e.code()))?;
                verify_opened(&keychain, path, before)?;
                Ok(keychain)
            }
        }
    }

    #[cfg(feature = "test-hooks")]
    fn verify_opened(keychain: &SecKeychain, expected: &std::path::Path, before: (u64, u64)) -> Result<(), KeychainError> {
        use core_foundation::base::TCFType;
        let raw = keychain.as_concrete_TypeRef() as *mut std::ffi::c_void;
        let mut buf = [0 as std::ffi::c_char; 1024];
        let mut len = buf.len() as u32;
        if unsafe { SecKeychainGetPath(raw, &mut len, buf.as_mut_ptr()) } != 0 {
            return Err(KeychainError::Unavailable);
        }
        let bytes: Vec<u8> = buf[..len as usize].iter().map(|c| *c as u8).collect();
        let reported = std::fs::canonicalize(std::path::PathBuf::from(std::ffi::OsString::from(String::from_utf8_lossy(&bytes).to_string())));
        let wanted = std::fs::canonicalize(expected);
        match (&reported, &wanted) {
            (Ok(a), Ok(b)) if a == b => {}
            _ => return Err(KeychainError::Unavailable),
        }
        // The same FILE, not just the same name: the file Security opened, and the file at the path
        // now, must both be the one that was validated before the open (a replacement in between is
        // a different inode).
        let reported_id = super::file_identity(reported.as_ref().expect("checked above"));
        let now = super::file_identity(expected);
        if reported_id != Some(before) || now != Some(before) {
            return Err(KeychainError::Unavailable);
        }
        let mut status: u32 = 0;
        if unsafe { SecKeychainGetStatus(raw, &mut status) } != 0 {
            return Err(KeychainError::Unavailable);
        }
        // The file must still be the validated one right before the caller writes.
        super::validate_keychain_path(expected)
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
    #[cfg(feature = "test-hooks")]
    pub fn prepare() -> Result<(), KeychainError> {
        quiet()
    }

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
        validate_first(target)?;
        quiet()?;
        open(target)?.set_generic_password(SERVICE, account, secret).map_err(|e| classify(e.code()))
    }

    pub fn get(target: &Target, account: &str) -> Result<Vec<u8>, KeychainError> {
        validate_first(target)?;
        quiet()?;
        let keychain = open(target)?;
        let (password, _item) = keychain.find_generic_password(SERVICE, account).map_err(|e| refine(&keychain, classify(e.code())))?;
        Ok(password.to_vec())
    }

    /// One read of an item with user interaction ENABLED, so macOS may ask the owner (and offer "Always Allow"). Only the
    /// short-lived `--keychain-op` child may call this (see `run_op`): the long-lived helper's switch stays off for good.
    pub fn get_interactive(target: &Target, account: &str) -> Result<Vec<u8>, KeychainError> {
        use core_foundation::base::TCFType;
        validate_first(target)?;
        // Resolve and validate the default file before enabling dialogs. A missing
        // Keychain is an error, never a reason to offer the system reset dialog.
        let quiet = SecKeychain::disable_user_interaction().map_err(|e| classify(e.code()))?;
        let keychain = open(target)?;
        let raw = keychain.as_concrete_TypeRef() as *mut std::ffi::c_void;
        let mut path = [0 as std::ffi::c_char; 4096];
        let mut len = (path.len() - 1) as u32;
        let mut status = 0u32;
        if unsafe { SecKeychainGetPath(raw, &mut len, path.as_mut_ptr()) } != 0
            || len as usize >= path.len() || unsafe { SecKeychainGetStatus(raw, &mut status) } != 0
        {
            return Err(KeychainError::Unavailable);
        }
        use std::os::unix::ffi::OsStrExt;
        let actual = unsafe { std::ffi::CStr::from_ptr(path.as_ptr()) };
        if !std::path::Path::new(std::ffi::OsStr::from_bytes(actual.to_bytes())).is_file() {
            return Err(KeychainError::Unavailable);
        }
        if status & 1 == 0 {
            return Err(KeychainError::Locked);
        }
        drop(quiet);
        let (password, _item) = keychain.find_generic_password(SERVICE, account).map_err(|e| classify(e.code()))?;
        Ok(password.to_vec())
    }

    /// Tells a locked keychain from an item this build may not read: both answer errSecInteractionNotAllowed.
    fn refine(keychain: &SecKeychain, error: KeychainError) -> KeychainError {
        use core_foundation::base::TCFType;
        if error != KeychainError::Locked {
            return error;
        }
        let mut status: u32 = 0;
        let raw = keychain.as_concrete_TypeRef() as *mut std::ffi::c_void;
        if unsafe { SecKeychainGetStatus(raw, &mut status) } != 0 {
            return KeychainError::Locked; // cannot tell: the combined message names both remedies
        }
        // kSecUnlockStateStatus = 1: set while the keychain is unlocked.
        if status & 1 != 0 { KeychainError::NeedsApproval } else { KeychainError::Locked }
    }

    pub fn delete(target: &Target, account: &str) -> Result<(), KeychainError> {
        use core_foundation::base::TCFType;
        validate_first(target)?;
        quiet()?;
        let keychain = open(target)?;
        let (_password, item) = keychain.find_generic_password(SERVICE, account).map_err(|e| classify(e.code()))?;
        // The crate's `SecKeychainItem::delete` discards the status, so a failed delete would
        // look like a success. The status is read here and mapped.
        let status = unsafe { SecKeychainItemDelete(item.as_concrete_TypeRef() as *mut std::ffi::c_void) };
        if status != 0 {
            return Err(classify(status));
        }
        Ok(())
    }

    /// Checked before ANY Security call, including the one that switches prompts off.
    fn validate_first(target: &Target) -> Result<(), KeychainError> {
        match target {
            #[cfg(feature = "test-hooks")]
            Target::Path(path) => super::validate_keychain_path(path),
            #[cfg(feature = "test-hooks")]
            Target::Unconfigured => Err(KeychainError::Unavailable),
            #[cfg(not(feature = "test-hooks"))]
            Target::Default => Ok(()),
        }
    }

    #[link(name = "Security", kind = "framework")]
    extern "C" {
        fn SecKeychainItemDelete(item: *mut std::ffi::c_void) -> i32;
        fn SecKeychainGetPath(keychain: *mut std::ffi::c_void, length: *mut u32, path: *mut std::ffi::c_char) -> i32;
        fn SecKeychainGetStatus(keychain: *mut std::ffi::c_void, status: *mut u32) -> i32;
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
    pub fn get_interactive(_: &Target, _: &str) -> Result<Vec<u8>, KeychainError> {
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
        for e in [KeychainError::Locked, KeychainError::NeedsApproval, KeychainError::Denied, KeychainError::Missing, KeychainError::Unavailable] {
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

#[derive(Serialize, Deserialize)]
pub struct OpRequest {
    pub op: String,
    #[serde(rename = "ref")]
    pub reference: String,
    #[serde(default)]
    pub secret: Option<Secret>,
    /// What the secret is for; required by `save`.
    #[serde(default)]
    pub bind: Option<Bind>,
}

#[derive(Serialize, Deserialize, Default)]
pub struct OpReply {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub present: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub secret: Option<Secret>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bind: Option<Bind>,
    /// The answer of `pin`: "written" (it was empty), "match" or "mismatch".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pin: Option<String>,
}

/// Executes one request against `keychain`. Pure of I/O, so it is tested directly.
pub fn execute(keychain: &Keychain, request: &OpRequest) -> OpReply {
    execute_with(&Storage { legacy: keychain, vault: None }, request)
}

fn execute_with(keychain: &Storage<'_>, request: &OpRequest) -> OpReply {
    let fail = |e: KeychainError| OpReply { error: Some(e.code().to_string()), ..OpReply::default() };
    match (request.op.as_str(), &request.secret) {
        ("save", Some(secret)) => match &request.bind {
            Some(bind) if bind.is_valid() => match keychain.set_item(&request.reference, &bind.clone().canonical(), secret) {
                Ok(()) => OpReply::default(),
                Err(e) => fail(e),
            },
            _ => OpReply { error: Some("invalid_bind".to_string()), ..OpReply::default() },
        },
        // Test-hooks only: a bare secret with no binding, as a pre-binding helper would have stored.
        #[cfg(feature = "test-hooks")]
        ("save_raw", Some(secret)) => match keychain.legacy.set(&request.reference, secret) {
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
        ("get", _) => match keychain.get_item(&request.reference) {
            Ok(item) => OpReply { secret: Some(item.secret), bind: Some(item.bind), ..OpReply::default() },
            Err(e) => fail(e),
        },
        // Pin-or-compare the server certificate of a saved RDP password, in one child call: when the item is
        // bound to exactly this endpoint and has no pin, write it ("written"); when it has one, compare
        // ("match" or "mismatch"). An item bound elsewhere is a mismatch. A pin is never replaced (saving the
        // password again is the way to start over). The caller treats anything but written/match as a refusal.
        ("pin", _) => match &request.bind {
            Some(wanted) if wanted.is_valid() && wanted.pin().is_some() => {
                #[cfg(feature = "test-hooks")]
                if std::env::var_os("REMOTE_HUB_TEST_PIN_FAIL").is_some() {
                    return OpReply { error: Some("keychain_unavailable".to_string()), ..OpReply::default() };
                }
                match keychain.get_item(&request.reference) {
                    Ok(item) => {
                        let wanted = wanted.clone().canonical();
                        let wanted_pin = wanted.pin().unwrap_or_default().to_string();
                        let pin = match item.bind.pin() {
                            Some(have) => {
                                let same = item.bind.with_pin(&wanted_pin) == wanted && crate::rdp::cert::fingerprint_matches(have, &wanted_pin);
                                if same { "match" } else { "mismatch" }
                            }
                            None if item.bind.with_pin(&wanted_pin) == wanted => match keychain.set_item(&request.reference, &wanted, &item.secret) {
                                Ok(()) => "written",
                                Err(e) => return fail(e),
                            },
                            None => "mismatch",
                        };
                        OpReply { pin: Some(pin.to_string()), ..OpReply::default() }
                    }
                    Err(e) => fail(e),
                }
            }
            _ => OpReply { error: Some("invalid_bind".to_string()), ..OpReply::default() },
        },
        // The binding alone: for checking an open BEFORE anything is started; no secret leaves the child.
        ("bind", _) => match keychain.get_item(&request.reference) {
            Ok(item) => OpReply { bind: Some(item.bind), ..OpReply::default() },
            Err(e) => fail(e),
        },
        _ => OpReply { error: Some("keychain_unavailable".to_string()), ..OpReply::default() },
    }
}

fn encode_item(bind: &Bind, secret: &Secret) -> Result<String, KeychainError> {
    let stored = StoredItem { magic: ENVELOPE_MAGIC.to_string(), v: 1, bind: bind.clone(), secret: secret.clone() };
    serde_json::to_string(&stored).map_err(|_| KeychainError::Unavailable)
}

fn decode_item(raw: &str) -> Result<Item, KeychainError> {
    match serde_json::from_str::<StoredItem>(raw) {
        Ok(stored) if stored.magic == ENVELOPE_MAGIC && stored.v == 1 && stored.bind.is_valid() => {
            Ok(Item { bind: stored.bind, secret: stored.secret })
        }
        _ => Err(KeychainError::Unbound),
    }
}

// A deletion marker prevents a retained legacy backup from ever being re-imported.
const DELETED: &str = "remote-hub/deleted-v1";

struct Storage<'a> {
    legacy: &'a Keychain,
    vault: Option<&'a crate::vault_bridge::Client>,
}

impl Storage<'_> {
    fn get_item(&self, reference: &str) -> Result<Item, KeychainError> {
        self.read_item(reference, false)
    }

    fn read_item(&self, reference: &str, interactive: bool) -> Result<Item, KeychainError> {
        let Some(vault) = self.vault else { return self.legacy.get_item(reference) };
        if let Some(current) = vault.get(reference)? {
            return Self::decode_vault(&current);
        }
        let raw = if interactive {
            let bytes = imp::get_interactive(&self.legacy.target, reference)?;
            Secret::new(String::from_utf8(bytes).map_err(|_| KeychainError::Unbound)?)
        } else {
            self.legacy.get(reference)?
        };
        let legacy = decode_item(raw.expose())?;
        let inserted = vault.write("import", reference, raw.expose())?;
        let stored = vault.get(reference)?.ok_or(KeychainError::VaultUnavailable)?;
        let item = Self::decode_vault(&stored)?;
        // A concurrent import or replacement wins. If this child inserted,
        // verify that the value and the original binding survived the write.
        if inserted && (item.bind != legacy.bind || item.secret != legacy.secret) {
            return Err(KeychainError::VaultUnavailable);
        }
        Ok(item)
    }

    fn decode_vault(raw: &str) -> Result<Item, KeychainError> {
        if raw == DELETED {
            return Err(KeychainError::Missing);
        }
        decode_item(raw)
    }

    fn set_item(&self, reference: &str, bind: &Bind, secret: &Secret) -> Result<(), KeychainError> {
        let Some(vault) = self.vault else { return self.legacy.set_item(reference, bind, secret) };
        let item = encode_item(bind, secret)?;
        if !vault.write("put", reference, &item)? {
            return Err(KeychainError::VaultUnavailable);
        }
        Ok(())
    }

    fn delete(&self, reference: &str) -> Result<(), KeychainError> {
        let Some(vault) = self.vault else { return self.legacy.delete(reference) };
        if !vault.write("put", reference, DELETED)? {
            return Err(KeychainError::VaultUnavailable);
        }
        Ok(())
    }

    fn exists(&self, reference: &str) -> Result<bool, KeychainError> {
        if self.vault.is_none() {
            return self.legacy.exists(reference);
        }
        match self.get_item(reference) {
            Ok(_) => Ok(true),
            Err(KeychainError::Missing) => Ok(false),
            Err(error) => Err(error),
        }
    }
}

/// The `--keychain-op` entry point: one request in, one reply out.
pub fn run_op() -> i32 {
    use std::io::{Read, Write};
    // Only the helper itself may ask: this mode hands a saved secret to its caller. (A same-user
    // process that can already drive the helper is a limit the docs state; this closes the
    // standalone read-back.) A test-hooks build lets a test start it directly.
    #[cfg(feature = "test-hooks")]
    let allowed = std::env::var_os("REMOTE_HUB_TEST_ANY_PARENT").is_some() || crate::peer::parent_is_this_binary();
    #[cfg(not(feature = "test-hooks"))]
    let allowed = crate::peer::parent_is_this_binary();
    if !allowed {
        return 3;
    }
    let mut input = String::new();
    if std::io::stdin().take(64 * 1024).read_to_string(&mut input).is_err() {
        return 2;
    }
    #[cfg(feature = "test-hooks")]
    if let Ok(mode) = std::env::var("REMOTE_HUB_KEYCHAIN_OP_FAKE") {
        return fake_op(&mode);
    }
    let Ok(request) = serde_json::from_str::<OpRequest>(&input) else { return 2 };
    if !valid_credential_ref(&request.reference) {
        return 2;
    }
    let legacy = Keychain::from_env();
    let reply = match crate::vault_bridge::Client::from_env() {
        Err(error) => OpReply { error: Some(error.code().to_string()), ..OpReply::default() },
        Ok(vault) => {
            let store = Storage { legacy: &legacy, vault: vault.as_ref() };
            if request.op == "allow" {
                // Only an owner action may ask macOS about a legacy item.
                let result = if store.vault.is_some() {
                    store.read_item(&request.reference, true).map(|_| ())
                } else {
                    legacy.allow(&request.reference)
                };
                match result {
                    Ok(()) => OpReply { present: Some(true), ..OpReply::default() },
                    Err(e) => OpReply { error: Some(e.code().to_string()), ..OpReply::default() },
                }
            } else {
                execute_with(&store, &request)
            }
        }
    };
    let Ok(text) = serde_json::to_string(&reply) else { return 2 };
    let mut out = std::io::stdout();
    if out.write_all(text.as_bytes()).and_then(|()| out.flush()).is_err() {
        return 2;
    }
    0
}

/// Test-hooks only: a keychain child that misbehaves, to test the helper's supervision of it.
/// It never touches a keychain.
///   stall    - answers nothing, for a minute
///   onebyte  - writes one byte, then stalls (a reader waiting for EOF would hang)
///   exit3    - writes a valid answer and exits with status 3
///   slow     - answers {"present":true} after 1.5 s (long enough for a signal to arrive meanwhile)
#[cfg(feature = "test-hooks")]
fn fake_op(mode: &str) -> i32 {
    use std::io::Write;
    let say = |text: &str| {
        let mut out = std::io::stdout();
        let _ = out.write_all(text.as_bytes());
        let _ = out.flush();
    };
    match mode {
        "stall" => {
            std::thread::sleep(std::time::Duration::from_secs(60));
            0
        }
        "onebyte" => {
            say("{");
            std::thread::sleep(std::time::Duration::from_secs(60));
            0
        }
        "exit3" => {
            say("{\"present\":true}");
            3
        }
        "slow" => {
            std::thread::sleep(std::time::Duration::from_millis(1500));
            say("{\"present\":true}");
            0
        }
        _ => 2,
    }
}

#[cfg(all(test, feature = "test-hooks", unix))]
mod identity_tests {
    use super::file_identity;

    #[test]
    fn a_file_swapped_in_under_the_same_name_has_a_different_identity() {
        let dir = std::env::temp_dir().join(format!("rh-kc-id-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let (a, b) = (dir.join("a"), dir.join("b"));
        std::fs::write(&a, "1").unwrap();
        std::fs::write(&b, "2").unwrap();
        let before = file_identity(&a).unwrap();
        assert_eq!(file_identity(&a), Some(before), "stable while nothing changes");
        std::fs::rename(&b, &a).unwrap(); // a different file now answers to the name
        assert_ne!(file_identity(&a), Some(before));
        std::fs::remove_file(&a).unwrap();
        assert_eq!(file_identity(&a), None);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
