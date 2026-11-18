//! The helper-owned known_hosts overlay and the private copy a saved-secret ssh session gets (W1, W5). One
//! test function: it names the overlay through an environment variable of THIS process, which is shared.
//! Every path is a fixture directory under the system temp dir, with a SPACE in it, like the production path.
use remote_hub_helper::known_hosts::{add_lines, merge_now, merge_session, read_lines, remove_host, session_copy, ssh_known_hosts_option, KnownHostsError};
use std::os::unix::fs::DirBuilderExt;

const ED: &str = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const ED2: &str = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

#[test]
fn the_overlay_has_one_writer_and_ssh_gets_a_private_quoted_copy() {
    let root = std::env::temp_dir().join(format!("rh-khs-{}", std::process::id()));
    let dir = root.join("Application Support").join("Remote Hub");
    std::fs::DirBuilder::new().recursive(true).mode(0o700).create(&dir).unwrap();
    let overlay = dir.join("known_hosts");
    std::env::set_var("REMOTE_HUB_KNOWN_HOSTS_PATH", &overlay);

    // --- W1: a path with a space is ONE quoted file; paths ssh would expand or misread are refused.
    let copy = session_copy().unwrap();
    let option = ssh_known_hosts_option(&copy.path).unwrap();
    assert_eq!(option, format!("UserKnownHostsFile=\"{}\"", copy.path.display()));
    assert!(option.contains("Application Support/Remote Hub/sessions/"), "{option}");
    for bad in ["/tmp/a\"b", "/tmp/a%hb", "/tmp/a$HOME", "/tmp/a\\b", "relative/path", "/tmp/~/x", "/tmp/a\nb"] {
        assert_eq!(ssh_known_hosts_option(std::path::Path::new(bad)), Err(KnownHostsError::Unsafe), "{bad:?}");
    }
    merge_session(&copy);
    assert!(!copy.path.exists(), "the copy is removed");

    // --- W8: a line that trusts one key for many hosts is not accepted.
    for bad in [format!("* {ED}"), format!("*.example.test {ED}"), format!("h?st {ED}"), format!("!h {ED}"), format!("@cert-authority h {ED}")] {
        assert_eq!(add_lines(&[bad.clone()]), Err(KnownHostsError::Unsafe), "{bad}");
    }
    assert_eq!(add_lines(&[format!("alpha.example.test {ED}"), format!("beta.example.test {ED2}")]), Ok(2));
    assert_eq!(add_lines(&[format!("alpha.example.test {ED}")]), Ok(0), "no duplicate");

    // --- W5: ssh writes only its COPY. A key it records while the user forgets another host is not lost.
    let copy = session_copy().unwrap();
    assert_eq!(copy.snapshot.len(), 2);
    let snapshot_text = std::fs::read_to_string(&copy.path).unwrap();
    assert!(snapshot_text.contains("alpha.example.test") && snapshot_text.contains("beta.example.test"));
    // ssh appends the key the user just confirmed (a complete line) and, killed mid-write, half of another.
    use std::io::Write;
    let mut f = std::fs::OpenOptions::new().append(true).open(&copy.path).unwrap();
    writeln!(f, "[gamma.example.test]:2222 {ED}").unwrap();
    write!(f, "delta.example.test ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIC").unwrap();
    drop(f);
    // The user forgets another host in the meantime: the helper, the only writer, replaces the overlay.
    assert_eq!(remove_host("beta.example.test"), Ok(1));
    merge_session(&copy);
    let lines = read_lines().unwrap();
    assert!(lines.iter().any(|l| l.starts_with("alpha.example.test ")), "{lines:?}");
    assert!(lines.iter().any(|l| l.starts_with("[gamma.example.test]:2222 ")), "the confirmed key survived the forget: {lines:?}");
    assert!(!lines.iter().any(|l| l.starts_with("beta.example.test ")), "the forgotten host stayed forgotten: {lines:?}");
    assert!(!lines.iter().any(|l| l.starts_with("delta.")), "a half-written line is never taken: {lines:?}");

    // --- X3: a key the user confirmed in session A counts for session B BEFORE A closes.
    let mut a = session_copy().unwrap();
    let mut f = std::fs::OpenOptions::new().append(true).open(&a.path).unwrap();
    writeln!(f, "[epsilon.example.test]:2222 {ED}").unwrap();
    drop(f);
    assert_eq!(merge_now(&mut a), Ok(1));
    assert_eq!(merge_now(&mut a), Ok(0), "nothing new the second time");
    let b = session_copy().unwrap(); // session B opens while A is still running
    assert!(b.snapshot.iter().any(|l| l.starts_with("[epsilon.example.test]:2222 ")), "B sees the key A confirmed: {:?}", b.snapshot);
    // A's later key is the only thing its final merge still adds; nothing is duplicated.
    let mut f = std::fs::OpenOptions::new().append(true).open(&a.path).unwrap();
    writeln!(f, "zeta.example.test {ED2}").unwrap();
    drop(f);
    merge_session(&a);
    merge_session(&b);
    let lines = read_lines().unwrap();
    assert_eq!(lines.iter().filter(|l| l.starts_with("[epsilon.example.test]:2222 ")).count(), 1, "{lines:?}");
    assert_eq!(lines.iter().filter(|l| l.starts_with("zeta.example.test ")).count(), 1, "{lines:?}");

    // --- the copy cannot smuggle anything the overlay would refuse.
    let copy = session_copy().unwrap();
    let mut f = std::fs::OpenOptions::new().append(true).open(&copy.path).unwrap();
    writeln!(f, "* {ED}").unwrap();
    writeln!(f, "@cert-authority * {ED}").unwrap();
    drop(f);
    merge_session(&copy);
    assert!(read_lines().unwrap().iter().all(|l| !l.starts_with('*') && !l.starts_with('@')));

    // --- W5: the size is checked before anything is published, and a refused write leaves the file as it was.
    let before = std::fs::read(&overlay).unwrap();
    let filler = format!("filler.example.test {ED}\n");
    let max = 4 * 1024 * 1024usize;
    let mut big = before.clone();
    while big.len() + filler.len() < max - 20 {
        big.extend_from_slice(filler.as_bytes());
    }
    std::fs::write(&overlay, &big).unwrap();
    std::fs::set_permissions(&overlay, std::os::unix::fs::PermissionsExt::from_mode(0o600)).unwrap();
    assert_eq!(add_lines(&[format!("a-very-long-host-name-for-the-last-line.example.test {ED}")]), Err(KnownHostsError::Unsafe));
    assert_eq!(std::fs::read(&overlay).unwrap(), big, "nothing was published");

    // --- the helper start removes copies a dead helper left behind.
    std::fs::write(&overlay, &before).unwrap();
    let left = session_copy().unwrap();
    remote_hub_helper::known_hosts::cleanup_stale_copies();
    assert!(!left.path.exists());
    let _ = std::fs::remove_dir_all(&root);
}
