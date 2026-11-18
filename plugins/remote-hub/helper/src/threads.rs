//! The helper forks children (PTY sessions, RDP engines) without exec'ing in
//! between work: the child path is `fork` → a few async-signal-safe calls →
//! `execve`. That is only sound because the helper process is SINGLE-THREADED
//! (its poll loop is one thread). A second thread would make a forked child
//! inherit locks and libc once-state (macOS kills such a child inside `fork()`
//! with "os_once_t is corrupt ... crashed on child side of fork pre-exec").
//!
//! This module makes the invariant checkable: in a `test-hooks` build every
//! fork site asserts that the process has exactly one thread, so a change that
//! quietly adds a thread to the helper fails the integration suite at the first
//! spawn. Release builds do not pay for the check.

/// The number of threads in this process, if the platform can tell.
pub fn thread_count() -> Option<usize> {
    #[cfg(target_os = "macos")]
    {
        let mut info: libc::proc_taskinfo = unsafe { std::mem::zeroed() };
        let size = std::mem::size_of::<libc::proc_taskinfo>() as libc::c_int;
        let r = unsafe {
            libc::proc_pidinfo(
                libc::getpid(),
                libc::PROC_PIDTASKINFO,
                0,
                &mut info as *mut _ as *mut libc::c_void,
                size,
            )
        };
        if r == size {
            return Some(info.pti_threadnum as usize);
        }
        None
    }
    #[cfg(target_os = "linux")]
    {
        let status = std::fs::read_to_string("/proc/self/status").ok()?;
        status.lines().find_map(|l| l.strip_prefix("Threads:")).and_then(|n| n.trim().parse().ok())
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        None
    }
}

/// Panic unless the process is single-threaded. `test-hooks` builds only.
#[cfg(feature = "test-hooks")]
pub fn assert_single_threaded(site: &str) {
    match thread_count() {
        Some(1) => {}
        Some(n) => panic!("{site}: the helper must be single-threaded when it forks, but has {n} threads"),
        None => panic!("{site}: cannot count threads on this platform; the fork invariant is unchecked"),
    }
}

#[cfg(not(feature = "test-hooks"))]
#[inline(always)]
pub fn assert_single_threaded(_site: &str) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts_a_spawned_thread() {
        let before = thread_count().expect("thread count");
        let (stop_tx, stop_rx) = std::sync::mpsc::channel::<()>();
        let (up_tx, up_rx) = std::sync::mpsc::channel::<()>();
        let t = std::thread::spawn(move || {
            up_tx.send(()).unwrap();
            let _ = stop_rx.recv();
        });
        up_rx.recv().unwrap();
        // Other test threads may start or end meanwhile; ours is one more than
        // the count taken before it started, at the time it runs.
        assert!(thread_count().unwrap() >= 2);
        assert!(before >= 1);
        stop_tx.send(()).unwrap();
        t.join().unwrap();
    }

    /// Policy check: `libc::fork()` appears only at the two product fork sites
    /// (the PTY, RDP and PVE spawners, which assert a single thread) and never in
    /// test code, because a test binary is multi-threaded.
    #[test]
    fn fork_appears_only_at_the_guarded_product_sites() {
        fn visit(dir: &std::path::Path, out: &mut Vec<(String, bool)>) {
            for entry in std::fs::read_dir(dir).unwrap().flatten() {
                let path = entry.path();
                if path.is_dir() {
                    visit(&path, out);
                } else if path.extension().map(|e| e == "rs").unwrap_or(false) {
                    let text = std::fs::read_to_string(&path).unwrap();
                    let test_start = text.find("#[cfg(test)]").unwrap_or(text.len());
                    for (at, _) in text.match_indices("libc::fork()") {
                        out.push((path.to_string_lossy().to_string(), at >= test_start));
                    }
                }
            }
        }
        let mut sites = Vec::new();
        visit(&std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src"), &mut sites);
        sites.sort();
        // This file's own mention is in a string literal inside test code.
        sites.retain(|(f, _)| !f.ends_with("threads.rs"));
        let names: Vec<String> = sites.iter().map(|(f, _)| f.rsplit('/').take(2).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>().join("/")).collect();
        assert_eq!(names, vec!["pve/manager.rs", "rdp/manager.rs", "src/sessions.rs"], "unexpected fork() sites: {sites:?}");
        assert!(sites.iter().all(|(_, in_tests)| !in_tests), "a test forks without exec: {sites:?}");
    }

    /// The libtest process has many threads: the guard must refuse to fork.
    #[cfg(feature = "test-hooks")]
    #[test]
    #[should_panic(expected = "must be single-threaded when it forks")]
    fn refuses_to_fork_in_a_multithreaded_process() {
        let (stop_tx, stop_rx) = std::sync::mpsc::channel::<()>();
        let (up_tx, up_rx) = std::sync::mpsc::channel::<()>();
        let _t = std::thread::spawn(move || {
            up_tx.send(()).unwrap();
            let _ = stop_rx.recv();
        });
        up_rx.recv().unwrap();
        let _keep = stop_tx;
        assert_single_threaded("test site");
    }
}
