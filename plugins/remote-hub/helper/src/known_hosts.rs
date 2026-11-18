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
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt};
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
        !hosts.is_empty() && hosts.split(',').all(|h| !h.is_empty() && h.len() <= 255 && h.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b':' | b'-' | b'_' | b'[' | b']' | b'*' | b'?' | b'!')))
    };
    host_ok && blob.len() >= 16 && blob.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'/' | b'='))
}

fn lock(file: &File) {
    unsafe {
        libc::flock(std::os::fd::AsRawFd::as_raw_fd(file), libc::LOCK_EX);
    }
}

fn read_all(path: &Path) -> Result<String, KnownHostsError> {
    let mut text = String::new();
    File::open(path).and_then(|f| f.take(MAX_FILE).read_to_string(&mut text)).map_err(|_| KnownHostsError::Io)?;
    Ok(text)
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
    let mut file = OpenOptions::new().read(true).append(true).open(&path).map_err(|_| KnownHostsError::Io)?;
    lock(&file);
    let existing: std::collections::HashSet<String> = read_all(&path)?.lines().map(|l| l.trim_end().to_string()).collect();
    let mut added = 0;
    for line in lines {
        if existing.contains(line.trim_end()) {
            continue;
        }
        writeln!(file, "{line}").map_err(|_| KnownHostsError::Io)?;
        added += 1;
    }
    file.sync_all().map_err(|_| KnownHostsError::Io)?;
    Ok(added)
}

/// Removes every line whose host list names exactly `host` (hashed lines cannot be matched by name and stay).
pub fn remove_host(host: &str) -> Result<usize, KnownHostsError> {
    if host.is_empty() || host.len() > 255 || host.chars().any(|c| c.is_control() || c == ' ' || c == ',') {
        return Err(KnownHostsError::Unsafe);
    }
    let path = ensure()?;
    let lock_file = OpenOptions::new().read(true).open(&path).map_err(|_| KnownHostsError::Io)?;
    lock(&lock_file);
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
    if removed == 0 {
        return Ok(0);
    }
    let tmp = path.with_extension("tmp");
    {
        let mut out = OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(&tmp).map_err(|_| KnownHostsError::Io)?;
        out.write_all(kept.as_bytes()).map_err(|_| KnownHostsError::Io)?;
        out.sync_all().map_err(|_| KnownHostsError::Io)?;
    }
    std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600)).map_err(|_| KnownHostsError::Io)?;
    std::fs::rename(&tmp, &path).map_err(|_| KnownHostsError::Io)?;
    Ok(removed)
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
