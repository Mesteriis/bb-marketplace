//! The helper-owned known_hosts overlay (stage 3c-2).
//!
//! A saved-secret SSH session does not read the user's own known_hosts (a file the caller could point
//! anywhere is refused, T3); it reads and writes THIS file, which only the helper chooses and which lives in
//! the user's Application Support directory: `~/Library/Application Support/Remote Hub/known_hosts`
//! (test-hooks builds: `REMOTE_HUB_KNOWN_HOSTS_PATH`). OpenSSH's normal trust flow applies to it: an unknown
//! host raises the confirm prompt, and a "yes" makes ssh append the key here. The page can also add lines
//! (imported from a known_hosts source the user switched on), list them and forget a host; every line is
//! validated, so nothing but plain host-key lines (no `@cert-authority`, no `@revoked`) can enter.
use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};

#[derive(Debug, PartialEq, Eq)]
pub enum KnownHostsError {
    /// The overlay or its directory is not what it must be (a link, someone else's, open to others).
    Unsafe,
    Io,
}

const MAX_LINE: usize = 4096;
const MAX_FILE: u64 = 4 * 1024 * 1024;
const MAX_LINES_PER_ADD: usize = 2000;

const KEY_TYPES: &[&str] = &[
    "ssh-rsa",
    "ssh-ed25519",
    "ssh-dss",
    "ecdsa-sha2-nistp256",
    "ecdsa-sha2-nistp384",
    "ecdsa-sha2-nistp521",
    "sk-ssh-ed25519@openssh.com",
    "sk-ecdsa-sha2-nistp256@openssh.com",
];

/// Where the overlay is. Never an input of a request.
pub fn overlay_path() -> Result<PathBuf, KnownHostsError> {
    #[cfg(feature = "test-hooks")]
    if let Some(path) = std::env::var_os("REMOTE_HUB_KNOWN_HOSTS_PATH") {
        return Ok(PathBuf::from(path));
    }
    let home = home_dir().ok_or(KnownHostsError::Io)?;
    Ok(home.join("Library").join("Application Support").join("Remote Hub").join("known_hosts"))
}

fn home_dir() -> Option<PathBuf> {
    // The passwd entry, not $HOME: the environment is not something a caller of this helper decides.
    let mut buf = vec![0u8; 4096];
    let mut pwd: libc::passwd = unsafe { std::mem::zeroed() };
    let mut out: *mut libc::passwd = std::ptr::null_mut();
    let rc = unsafe { libc::getpwuid_r(libc::geteuid(), &mut pwd, buf.as_mut_ptr() as *mut libc::c_char, buf.len(), &mut out) };
    if rc != 0 || out.is_null() || pwd.pw_dir.is_null() {
        return None;
    }
    let dir = unsafe { std::ffi::CStr::from_ptr(pwd.pw_dir) }.to_str().ok()?;
    Some(PathBuf::from(dir))
}

fn euid() -> u32 {
    unsafe { libc::geteuid() }
}

/// Makes sure the directory (0700) and the file (0600) exist, are ours, are not links and are closed to others.
pub fn ensure() -> Result<PathBuf, KnownHostsError> {
    let path = overlay_path()?;
    let dir = path.parent().ok_or(KnownHostsError::Io)?;
    if !dir.exists() {
        std::fs::DirBuilder::new().recursive(true).mode(0o700).create(dir).map_err(|_| KnownHostsError::Io)?;
    }
    let meta = std::fs::symlink_metadata(dir).map_err(|_| KnownHostsError::Io)?;
    // The directory is ours and closed to others. (An ancestor such as ~/Library may be shared as usual;
    // only the overlay's own directory and file are checked.)
    if !meta.file_type().is_dir() || meta.uid() != euid() || meta.mode() & 0o077 != 0 {
        return Err(KnownHostsError::Unsafe);
    }
    match std::fs::symlink_metadata(&path) {
        Ok(file) => {
            if !file.file_type().is_file() || file.uid() != euid() || file.mode() & 0o077 != 0 || file.len() > MAX_FILE {
                return Err(KnownHostsError::Unsafe);
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            OpenOptions::new().write(true).create_new(true).mode(0o600).open(&path).map_err(|_| KnownHostsError::Io)?;
        }
        Err(_) => return Err(KnownHostsError::Io),
    }
    Ok(path)
}

/// One plain host-key line: `hosts keytype base64 [comment]`. No markers, no control characters, no hash of
/// nothing: what ssh itself would write for an accepted key.
pub fn valid_line(line: &str) -> bool {
    if line.is_empty() || line.len() > MAX_LINE || line.chars().any(|c| c.is_control()) || line.starts_with('@') || line.starts_with('#') {
        return false;
    }
    let mut parts = line.splitn(4, ' ');
    let (Some(hosts), Some(kind), Some(blob)) = (parts.next(), parts.next(), parts.next()) else { return false };
    if !KEY_TYPES.contains(&kind) {
        return false;
    }
    let host_ok = if hosts.starts_with("|1|") {
        hosts.len() < 200 && hosts[3..].split('|').count() == 2 && hosts[3..].bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'/' | b'=' | b'|'))
    } else {
        !hosts.is_empty() && hosts.split(',').all(|h| !h.is_empty() && h.len() <= 255 && h.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b':' | b'-' | b'_' | b'[' | b']')))
    };
    // No wildcard or negated pattern (`*`, `?`, `!`): such a line would trust one key for many hosts.
    host_ok && blob.len() >= 16 && blob.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'/' | b'='))
}

/// The one lock every writer of the overlay takes: a separate, stable file (the overlay itself is replaced by
/// rename, so a lock on its inode would mean nothing after the first replacement).
struct OverlayLock {
    _file: File,
}

fn take_lock(dir: &Path) -> Result<OverlayLock, KnownHostsError> {
    let file = OpenOptions::new().read(true).write(true).create(true).truncate(false).mode(0o600).open(dir.join("known_hosts.lock")).map_err(|_| KnownHostsError::Io)?;
    if unsafe { libc::flock(std::os::fd::AsRawFd::as_raw_fd(&file), libc::LOCK_EX) } != 0 {
        return Err(KnownHostsError::Io);
    }
    Ok(OverlayLock { _file: file })
}

fn read_all(path: &Path) -> Result<String, KnownHostsError> {
    let mut text = String::new();
    File::open(path).and_then(|f| f.take(MAX_FILE).read_to_string(&mut text)).map_err(|_| KnownHostsError::Io)?;
    Ok(text)
}

/// Replaces the overlay with `content`: size checked BEFORE anything is published, written to a private
/// temporary file, synced, renamed over the overlay, and the directory synced. A reader (ssh, through its own
/// session copy, or this helper) sees the old file or the new one, never half of either.
fn publish(path: &Path, content: &str) -> Result<(), KnownHostsError> {
    if content.len() as u64 > MAX_FILE {
        return Err(KnownHostsError::Unsafe);
    }
    let dir = path.parent().ok_or(KnownHostsError::Io)?;
    let tmp = dir.join(format!("known_hosts.new{}", std::process::id()));
    let _ = std::fs::remove_file(&tmp);
    {
        let mut out = OpenOptions::new().write(true).create_new(true).mode(0o600).open(&tmp).map_err(|_| KnownHostsError::Io)?;
        out.write_all(content.as_bytes()).map_err(|_| KnownHostsError::Io)?;
        out.sync_all().map_err(|_| KnownHostsError::Io)?;
    }
    if std::fs::rename(&tmp, path).is_err() {
        let _ = std::fs::remove_file(&tmp);
        return Err(KnownHostsError::Io);
    }
    if let Ok(d) = File::open(dir) {
        let _ = d.sync_all();
    }
    Ok(())
}

/// The lines of the overlay (as ssh wrote them), valid or not skipped silently.
pub fn read_lines() -> Result<Vec<String>, KnownHostsError> {
    let path = ensure()?;
    Ok(read_all(&path)?.lines().filter(|l| valid_line(l)).map(str::to_string).collect())
}

/// Appends the valid lines that are not there yet. Returns how many were added; an invalid line refuses the whole call.
pub fn add_lines(lines: &[String]) -> Result<usize, KnownHostsError> {
    if lines.len() > MAX_LINES_PER_ADD || lines.iter().any(|l| !valid_line(l)) {
        return Err(KnownHostsError::Unsafe);
    }
    let path = ensure()?;
    let _lock = take_lock(path.parent().ok_or(KnownHostsError::Io)?)?;
    append_missing(&path, lines)
}

/// With the lock held: adds what is missing and publishes once.
fn append_missing(path: &Path, lines: &[String]) -> Result<usize, KnownHostsError> {
    let mut text = read_all(path)?;
    let existing: std::collections::HashSet<String> = text.lines().map(|l| l.trim_end().to_string()).collect();
    let mut added = 0;
    let mut seen = existing;
    for line in lines {
        if !seen.insert(line.trim_end().to_string()) {
            continue;
        }
        if !text.is_empty() && !text.ends_with('\n') {
            text.push('\n');
        }
        text.push_str(line.trim_end());
        text.push('\n');
        added += 1;
    }
    if added > 0 {
        publish(path, &text)?;
    }
    Ok(added)
}

/// Removes every line whose host list names exactly `host`. A hashed line cannot be matched by name: it stays,
/// and the page says so.
pub fn remove_host(host: &str) -> Result<usize, KnownHostsError> {
    if host.is_empty() || host.len() > 255 || host.chars().any(|c| c.is_control() || c == ' ' || c == ',') {
        return Err(KnownHostsError::Unsafe);
    }
    let path = ensure()?;
    let _lock = take_lock(path.parent().ok_or(KnownHostsError::Io)?)?;
    let text = read_all(&path)?;
    let mut kept = String::new();
    let mut removed = 0;
    for line in text.lines() {
        let names = line.split(' ').next().unwrap_or("");
        if !line.starts_with("|1|") && names.split(',').any(|n| n.eq_ignore_ascii_case(host)) {
            removed += 1;
        } else {
            kept.push_str(line);
            kept.push('\n');
        }
    }
    if removed > 0 {
        publish(&path, &kept)?;
    }
    Ok(removed)
}

/// What a saved-secret SSH session reads and writes instead of the overlay itself: ssh never touches the
/// overlay, so the helper is its only writer (one owner, one lock, atomic replace). What the user confirmed
/// during the session is merged into the overlay when the session ends (`merge_session`); a crash loses at
/// most that confirmation, and the question is asked again next time.
#[derive(Debug, Clone)]
pub struct SessionCopy {
    pub path: PathBuf,
    /// The overlay's lines when the copy was made; only lines beyond these are merged back.
    pub snapshot: Vec<String>,
}

fn sessions_dir(overlay: &Path) -> Result<PathBuf, KnownHostsError> {
    let dir = overlay.parent().ok_or(KnownHostsError::Io)?.join("sessions");
    if !dir.exists() {
        std::fs::DirBuilder::new().mode(0o700).create(&dir).map_err(|_| KnownHostsError::Io)?;
    }
    let meta = std::fs::symlink_metadata(&dir).map_err(|_| KnownHostsError::Io)?;
    if !meta.file_type().is_dir() || meta.uid() != euid() || meta.mode() & 0o077 != 0 {
        return Err(KnownHostsError::Unsafe);
    }
    Ok(dir)
}

pub fn session_copy() -> Result<SessionCopy, KnownHostsError> {
    static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let overlay = ensure()?;
    let dir = sessions_dir(&overlay)?;
    let snapshot: Vec<String> = {
        let _lock = take_lock(overlay.parent().ok_or(KnownHostsError::Io)?)?;
        read_all(&overlay)?.lines().filter(|l| valid_line(l)).map(str::to_string).collect()
    };
    let path = dir.join(format!("s{}-{}", std::process::id(), COUNTER.fetch_add(1, std::sync::atomic::Ordering::SeqCst)));
    let mut text = snapshot.join("\n");
    if !text.is_empty() {
        text.push('\n');
    }
    let mut out = OpenOptions::new().write(true).create_new(true).mode(0o600).open(&path).map_err(|_| KnownHostsError::Io)?;
    out.write_all(text.as_bytes()).map_err(|_| KnownHostsError::Io)?;
    Ok(SessionCopy { path, snapshot })
}

/// The `-o` value that names the copy as ONE file. OpenSSH parses the value as a list split at spaces, so the
/// path is double-quoted; a path it would expand or misread (`%`, `~`, quotes, backslashes, control
/// characters) is refused.
pub fn ssh_known_hosts_option(path: &Path) -> Result<String, KnownHostsError> {
    let text = path.to_str().ok_or(KnownHostsError::Unsafe)?;
    if !text.starts_with('/') || text.chars().any(|c| c.is_control() || matches!(c, '"' | '\\' | '%' | '$')) || text.contains("/~") {
        return Err(KnownHostsError::Unsafe);
    }
    Ok(format!("UserKnownHostsFile=\"{text}\""))
}

/// Merges the keys ssh recorded in a session copy (complete, valid, plain lines that were not in the snapshot)
/// into the overlay, under the lock, and removes the copy. Never fails the caller: a problem leaves the
/// overlay as it was.
pub fn merge_session(copy: &SessionCopy) {
    let _ = merge_inner(copy);
    let _ = std::fs::remove_file(&copy.path);
}

fn merge_inner(copy: &SessionCopy) -> Result<(), KnownHostsError> {
    let text = read_all(&copy.path)?;
    // A last line without its newline may be half written (ssh killed mid-append): it is not taken.
    let complete = match text.rfind('\n') {
        Some(i) => &text[..i],
        None => return Ok(()),
    };
    let known: std::collections::HashSet<&str> = copy.snapshot.iter().map(String::as_str).collect();
    let fresh: Vec<String> = complete.lines().filter(|l| valid_line(l) && !known.contains(l.trim_end())).map(str::to_string).collect();
    if fresh.is_empty() {
        return Ok(());
    }
    let overlay = ensure()?;
    let _lock = take_lock(overlay.parent().ok_or(KnownHostsError::Io)?)?;
    append_missing(&overlay, &fresh).map(|_| ())
}

/// At helper start: copies left by a helper that died are removed.
pub fn cleanup_stale_copies() {
    let Ok(overlay) = overlay_path() else { return };
    let Some(parent) = overlay.parent() else { return };
    let Ok(entries) = std::fs::read_dir(parent.join("sessions")) else { return };
    for entry in entries.flatten() {
        let _ = std::fs::remove_file(entry.path());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ED: &str = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

    #[test]
    fn only_plain_host_key_lines_are_valid() {
        assert!(valid_line(&format!("[127.0.0.1]:2222 {ED}")));
        assert!(valid_line(&format!("a.example.test,b.example.test {ED} a comment")));
        assert!(valid_line(&format!("|1|c2FsdA==|aGFzaA== {ED}")));
        for bad in [
            format!("@cert-authority *.example.test {ED}"),
            format!("@revoked h {ED}"),
            format!("# h {ED}"),
            format!("h ssh-weird {}", &ED[12..]),
            format!("h {ED}\nsecond line {ED}"),
            "h ssh-ed25519 short".to_string(),
            format!("h {} {}", "ssh-ed25519", "!!!!!!!!!!!!!!!!!!!!"),
            format!("{} {ED}", "x".repeat(300)),
            String::new(),
            format!("h,,x {ED}"),
        ] {
            assert!(!valid_line(&bad), "{bad:?}");
        }
    }
}
