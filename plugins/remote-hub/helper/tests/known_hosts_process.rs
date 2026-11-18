//! The helper-owned known_hosts overlay through the real helper process (stage 3c-2). Every path is a fixture
//! directory under the system temp dir; the user's own known_hosts is never named.
mod common;

use common::*;
use remote_hub_helper::protocol::{Request, Response};
use std::os::unix::fs::{symlink, DirBuilderExt, PermissionsExt};
use std::path::PathBuf;

const ED: &str = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

fn watchdog() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        std::thread::spawn(|| {
            std::thread::sleep(std::time::Duration::from_secs(60));
            eprintln!("known_hosts tests: watchdog expired; aborting");
            std::process::abort();
        });
    });
}

struct Fx {
    dir: PathBuf,
    file: PathBuf,
    h: Option<Helper>,
}

impl Fx {
    fn new(tag: &str) -> Fx {
        watchdog();
        let dir = std::env::temp_dir().join(format!("rh-kh-{}-{tag}", std::process::id()));
        std::fs::DirBuilder::new().mode(0o700).create(&dir).unwrap();
        let file = dir.join("known_hosts");
        let h = start(&[("REMOTE_HUB_KNOWN_HOSTS_PATH", file.to_str().unwrap())]);
        Fx { dir, file, h: Some(h) }
    }
    fn h(&mut self) -> &mut Helper {
        self.h.as_mut().unwrap()
    }
    fn list(&mut self, id: u64) -> Vec<String> {
        self.h().send(&Request::KnownHostsList { id });
        match self.h().read_reply(id) {
            Response::KnownHostsLines { lines, .. } => lines,
            other => panic!("expected lines, got {other:?}"),
        }
    }
    fn add(&mut self, id: u64, lines: &[&str]) -> Response {
        self.h().send(&Request::KnownHostsAdd { id, lines: lines.iter().map(|s| s.to_string()).collect() });
        self.h().read_reply(id)
    }
    fn remove(&mut self, id: u64, host: &str) -> Response {
        self.h().send(&Request::KnownHostsRemove { id, host: host.into() });
        self.h().read_reply(id)
    }
}

impl Drop for Fx {
    fn drop(&mut self) {
        if let Some(h) = self.h.take() {
            h.shutdown();
        }
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn count(r: Response) -> u32 {
    match r {
        Response::KnownHostsDone { count, .. } => count,
        other => panic!("expected done, got {other:?}"),
    }
}

fn code(r: Response) -> String {
    match r {
        Response::Error { code, .. } => code,
        other => panic!("expected an error, got {other:?}"),
    }
}

#[test]
fn lines_are_added_once_listed_and_forgotten_by_host_and_the_file_is_private() {
    let mut f = Fx::new("basic");
    assert_eq!(f.list(1), Vec::<String>::new());
    let a = format!("[127.0.0.1]:2222 {ED}");
    let b = format!("other.example.test,alias.example.test {ED} comment");
    assert_eq!(count(f.add(2, &[&a, &b])), 2);
    assert_eq!(count(f.add(3, &[&a])), 0, "a line already there is not added twice");
    assert_eq!(f.list(4), vec![a.clone(), b.clone()]);
    assert_eq!(std::fs::metadata(&f.file).unwrap().permissions().mode() & 0o777, 0o600);
    assert_eq!(count(f.remove(5, "ALIAS.example.test")), 1, "forgetting a host name removes the line that names it, case-insensitively");
    assert_eq!(f.list(6), vec![a]);
    assert_eq!(count(f.remove(7, "nothing.example.test")), 0);
}

#[test]
fn a_line_that_is_not_a_plain_host_key_refuses_the_whole_call() {
    let mut f = Fx::new("invalid");
    let good = format!("h.example.test {ED}");
    for bad in [format!("@cert-authority * {ED}"), format!("@revoked h {ED}"), "h ssh-ed25519 short".to_string(), format!("h {ED}\u{7}")] {
        assert_eq!(code(f.add(1, &[&good, &bad])), "known_hosts_refused", "{bad:?}");
    }
    assert_eq!(f.list(2), Vec::<String>::new(), "nothing from a refused call is kept");
    assert_eq!(code(f.remove(3, "a b")), "known_hosts_refused");
}

#[test]
fn an_overlay_or_directory_that_is_not_ours_alone_is_refused() {
    let mut f = Fx::new("unsafe");
    assert_eq!(count(f.add(1, &[&format!("h.example.test {ED}")])), 1);
    // The file open to others.
    std::fs::set_permissions(&f.file, std::fs::Permissions::from_mode(0o644)).unwrap();
    assert_eq!(code(f.add(2, &[&format!("g.example.test {ED}")])), "known_hosts_refused");
    std::fs::set_permissions(&f.file, std::fs::Permissions::from_mode(0o600)).unwrap();
    // The directory open to others.
    std::fs::set_permissions(&f.dir, std::fs::Permissions::from_mode(0o755)).unwrap();
    f.h().send(&Request::KnownHostsList { id: 3 });
    assert_eq!(code(f.h().read_reply(3)), "known_hosts_refused");
    std::fs::set_permissions(&f.dir, std::fs::Permissions::from_mode(0o700)).unwrap();
    // The file replaced by a link to somewhere else.
    let elsewhere = f.dir.join("elsewhere");
    std::fs::write(&elsewhere, format!("evil.example.test {ED}\n")).unwrap();
    std::fs::set_permissions(&elsewhere, std::fs::Permissions::from_mode(0o600)).unwrap();
    std::fs::remove_file(&f.file).unwrap();
    symlink(&elsewhere, &f.file).unwrap();
    f.h().send(&Request::KnownHostsList { id: 4 });
    assert_eq!(code(f.h().read_reply(4)), "known_hosts_refused");
}

#[test]
fn the_overlay_is_created_private_when_missing_and_no_request_can_name_a_path() {
    let mut f = Fx::new("create");
    assert!(!f.file.exists());
    assert_eq!(f.list(1), Vec::<String>::new());
    assert!(f.file.exists());
    // The wire messages carry lines and a host name: there is no field that holds a path.
    let text = serde_json::to_string(&Request::KnownHostsAdd { id: 2, lines: vec![] }).unwrap();
    assert!(!text.contains("path"), "{text}");
}
