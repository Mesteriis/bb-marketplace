//! Session ownership: the helper creates a real PTY per echo session, forks a
//! child into it, and reaps children on close and on shutdown so none are ever
//! orphaned. All session fds are non-blocking and close-on-exec; the child path
//! between fork and exec performs no allocation.

use std::collections::HashMap;
use std::ffi::CString;
use std::os::fd::{AsRawFd, FromRawFd, IntoRawFd, OwnedFd, RawFd};

/// Per-session bound on buffered, not-yet-flushed PTY output. When a session's
/// pending output reaches this bound the helper stops reading from its PTY,
/// which fills the kernel PTY buffer and applies backpressure to the child.
pub const PENDING_OUTPUT_CAP: usize = 256 * 1024;
/// Per-session bound on buffered input that has not yet been written to the
/// PTY. Input beyond this bound is refused with input_overflow.
pub const PENDING_INPUT_CAP: usize = 256 * 1024;
/// Most bytes read from a PTY per poll wake-up.
pub const READ_CHUNK: usize = 64 * 1024;
/// Most bytes written to a PTY per poll wake-up.
pub const WRITE_CHUNK: usize = 64 * 1024;

pub struct Session {
    pub id: u32,
    pub child: libc::pid_t,
    pub master: RawFd,
    pub seq: u32,
    pub pending_out: Vec<u8>,
    pub pending_in: Vec<u8>,
    pub child_exited: bool,
    /// The PTY is complete: read returned 0 (EOF) or EIO.
    pub pty_done: bool,
}

impl Session {
    fn finished(&self) -> bool {
        self.child_exited && self.pty_done && self.pending_out.is_empty()
    }
}

pub struct SessionManager {
    sessions: HashMap<u32, Session>,
    next_id: u32,
    /// Test-only argv hook (never exposed over RPC, and only compiled when the
    /// test-hooks cargo feature is on): open_echo execs this argv instead of
    /// /bin/cat.
    echo_argv: Option<Vec<CString>>,
}

#[derive(Debug)]
pub enum SessionError {
    /// A named step failed with this errno (diagnosable in the error frame).
    Sys { step: &'static str, errno: i32 },
    Unknown,
    InputOverflow,
}

impl std::fmt::Display for SessionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SessionError::Sys { step, errno } => write!(f, "{step} failed: {}", errno_text(*errno)),
            SessionError::Unknown => write!(f, "no such session"),
            SessionError::InputOverflow => write!(f, "session input overflows the pending-input window"),
        }
    }
}

fn last_errno() -> i32 {
    std::io::Error::last_os_error().raw_os_error().unwrap_or(0)
}

fn errno_text(errno: i32) -> String {
    let name = match errno {
        libc::EAGAIN => Some("EAGAIN"),
        libc::EINTR => Some("EINTR"),
        libc::ENOSPC => Some("ENOSPC"),
        libc::EMFILE => Some("EMFILE"),
        libc::ENFILE => Some("ENFILE"),
        libc::EIO => Some("EIO"),
        libc::EPERM => Some("EPERM"),
        libc::ENOENT => Some("ENOENT"),
        libc::EACCES => Some("EACCES"),
        libc::ECHILD => Some("ECHILD"),
        _ => None,
    };
    match name {
        Some(name) => format!("{name} ({errno})"),
        None => std::io::Error::from_raw_os_error(errno).to_string(),
    }
}

/// Transient errnos (positive or the negative values macOS pty code paths
/// store) that a bounded retry may clear: EAGAIN, EINTR, ENXIO.
fn is_transient_errno(errno: i32) -> bool {
    let e = errno.abs();
    e == libc::EAGAIN || e == libc::EINTR || e == libc::ENXIO
}

/// The fds above 2 currently open in this process, listed from /dev/fd. Built
/// in the parent so the child can close exactly the open ones without any
/// allocation between fork and exec.
fn open_fds_above_two() -> Result<Vec<i32>, SessionError> {
    let mut fds: Vec<i32> = Vec::new();
    match std::fs::read_dir("/dev/fd") {
        Ok(entries) => {
            for entry in entries.flatten() {
                let name = entry.file_name();
                if let Some(name) = name.to_str() {
                    if let Ok(n) = name.parse::<i32>() {
                        if n > 2 {
                            fds.push(n);
                        }
                    }
                }
            }
        }
        Err(e) => {
            return Err(SessionError::Sys {
                step: "fd_enumeration",
                errno: e.raw_os_error().unwrap_or(0),
            });
        }
    }
    fds.sort_unstable();
    fds.dedup();
    Ok(fds)
}

fn set_cloexec(fd: RawFd) -> Result<(), SessionError> {
    unsafe {
        let flags = libc::fcntl(fd, libc::F_GETFD);
        if flags < 0 {
            return Err(SessionError::Sys { step: "fcntl", errno: last_errno() });
        }
        if libc::fcntl(fd, libc::F_SETFD, flags | libc::FD_CLOEXEC) < 0 {
            return Err(SessionError::Sys { step: "fcntl", errno: last_errno() });
        }
    }
    Ok(())
}

fn set_nonblocking(fd: RawFd) -> Result<(), SessionError> {
    unsafe {
        let flags = libc::fcntl(fd, libc::F_GETFL);
        if flags < 0 {
            return Err(SessionError::Sys { step: "fcntl", errno: last_errno() });
        }
        if libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) < 0 {
            return Err(SessionError::Sys { step: "fcntl", errno: last_errno() });
        }
    }
    Ok(())
}

/// Block every signal in the calling (parent) thread around fork so the child
/// cannot run a handler that belongs to the helper. Stores the previous mask.
fn block_all_signals(old_mask: &mut libc::sigset_t) {
    unsafe {
        let mut all: libc::sigset_t = std::mem::zeroed();
        libc::sigfillset(&mut all);
        libc::pthread_sigmask(libc::SIG_SETMASK, &all, old_mask);
    }
}

fn restore_signal_mask(old_mask: &libc::sigset_t) {
    unsafe { libc::pthread_sigmask(libc::SIG_SETMASK, old_mask, std::ptr::null_mut()) };
}

/// Child-side, before exec: reset every disposition to SIG_DFL and unblock all
/// signals. Async-signal-safe (only sigaction/sigemptyset/pthread_sigmask).
fn reset_signals_and_unblock() {
    unsafe {
        let mut sa: libc::sigaction = std::mem::zeroed();
        sa.sa_sigaction = libc::SIG_DFL;
        libc::sigemptyset(&mut sa.sa_mask);
        sa.sa_flags = 0;
        let mut sig = 1;
        while sig < 32 {
            libc::sigaction(sig, &sa, std::ptr::null_mut());
            sig += 1;
        }
        let mut empty: libc::sigset_t = std::mem::zeroed();
        libc::sigemptyset(&mut empty);
        libc::pthread_sigmask(libc::SIG_SETMASK, &empty, std::ptr::null_mut());
    }
}

impl SessionManager {
    pub fn new(echo_argv: Option<Vec<String>>) -> Self {
        let argv = echo_argv.map(|args| {
            args.iter()
                .map(|a| CString::new(a.as_str()).expect("echo argv has no NUL"))
                .collect()
        });
        SessionManager {
            sessions: HashMap::new(),
            next_id: 1,
            echo_argv: argv,
        }
    }

    pub fn count(&self) -> usize {
        self.sessions.len()
    }

    pub fn fds(&self) -> Vec<(u32, RawFd)> {
        self.sessions.iter().map(|(&id, s)| (id, s.master)).collect()
    }

    /// Whether a session has input waiting to be written to its PTY.
    pub fn wants_write(&self, id: u32) -> bool {
        self.sessions.get(&id).map(|s| !s.pending_in.is_empty()).unwrap_or(false)
    }

    /// Whether a session's pending output has room to read more PTY bytes.
    pub fn can_read_output(&self, id: u32) -> bool {
        self.sessions
            .get(&id)
            .map(|s| s.pending_out.len() < PENDING_OUTPUT_CAP && !s.pty_done)
            .unwrap_or(false)
    }

    /// Build the exec argv BEFORE fork so the child performs no allocation.
    fn build_exec_argv(&self) -> (CString, Vec<CString>, Vec<*const libc::c_char>) {
        let (prog, argv): (CString, Vec<CString>) = match &self.echo_argv {
            Some(args) if !args.is_empty() => (args[0].clone(), args.clone()),
            _ => (
                CString::new("/bin/cat").unwrap(),
                vec![CString::new("cat").unwrap()],
            ),
        };
        let mut c_args: Vec<*const libc::c_char> = argv.iter().map(|a| a.as_ptr()).collect();
        c_args.push(std::ptr::null());
        (prog, argv, c_args)
    }

    pub fn open_echo(&mut self, cols: u16, rows: u16) -> Result<u32, SessionError> {
        let (prog, _argv, c_args) = self.build_exec_argv();
        let mut master: libc::c_int = -1;
        let mut slave: libc::c_int = -1;
        let mut winsize = libc::winsize {
            ws_row: rows,
            ws_col: cols,
            ws_xpixel: 0,
            ws_ypixel: 0,
        };

        // openpty fails transiently (EAGAIN/EINTR/ENXIO) under concurrent PTY
        // creation; retry a bounded number of times and keep the last errno.
        let mut openpty_errno = 0;
        for _ in 0..8 {
            master = -1;
            slave = -1;
            let ret = unsafe {
                libc::openpty(
                    &mut master,
                    &mut slave,
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    &mut winsize,
                )
            };
            if ret == 0 {
                break;
            }
            openpty_errno = last_errno();
            if !is_transient_errno(openpty_errno) {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(2));
        }
        if master < 0 || slave < 0 {
            return Err(SessionError::Sys {
                step: "openpty",
                errno: openpty_errno,
            });
        }
        // RAII ownership: any setup failure below (or the fork-failure path)
        // closes both descriptors.
        let master_owned = unsafe { OwnedFd::from_raw_fd(master) };
        let slave_owned = unsafe { OwnedFd::from_raw_fd(slave) };
        let master = master_owned.as_raw_fd();
        let slave = slave_owned.as_raw_fd();
        set_cloexec(master)?;
        set_cloexec(slave)?;
        set_nonblocking(master)?;

        // Raw mode is applied to the slave by the parent, before fork, so no
        // input is ever processed in canonical/ECHO mode (which would double
        // the echo and translate newlines).
        unsafe {
            let mut tio: libc::termios = std::mem::zeroed();
            if libc::tcgetattr(slave, &mut tio) != 0 {
                return Err(SessionError::Sys { step: "termios", errno: last_errno() });
            }
            libc::cfmakeraw(&mut tio);
            if libc::tcsetattr(slave, libc::TCSANOW, &tio) != 0 {
                return Err(SessionError::Sys { step: "termios", errno: last_errno() });
            }
        }

        // List the fds the child will inherit (before fork) so the child can
        // close exactly the open ones, including any non-CLOEXEC fd it got from
        // its parent.
        let inherited = open_fds_above_two()?;

        // Block every signal around fork so the child never runs a helper
        // handler (e.g. writing S into the signal pipe) before exec.
        let mut old_mask: libc::sigset_t = unsafe { std::mem::zeroed() };
        block_all_signals(&mut old_mask);
        let mut pid: libc::pid_t;
        let mut fork_errno = 0;
        let mut fork_attempts = 0;
        loop {
            pid = unsafe { libc::fork() };
            if pid >= 0 {
                break;
            }
            fork_errno = last_errno();
            fork_attempts += 1;
            if !is_transient_errno(fork_errno) || fork_attempts >= 8 {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(1));
        }
        if pid < 0 {
            restore_signal_mask(&old_mask);
            // master_owned/slave_owned drop here, closing both descriptors.
            return Err(SessionError::Sys {
                step: "fork",
                errno: fork_errno,
            });
        }
        if pid == 0 {
            // Child: default dispositions, unblocked signals, the slave as
            // controlling terminal, raw mode, stdin/stdout/stderr to the slave,
            // then exec. No allocation here: prog/c_args/inherited were built
            // by the parent.
            reset_signals_and_unblock();
            unsafe {
                libc::setsid();
                libc::ioctl(slave, libc::TIOCSCTTY as libc::c_ulong, 0);
                libc::dup2(slave, 0);
                libc::dup2(slave, 1);
                libc::dup2(slave, 2);
                if slave > 2 {
                    libc::close(slave);
                }
                for fd in &inherited {
                    if *fd != slave {
                        libc::close(*fd);
                    }
                }
                libc::execv(prog.as_ptr(), c_args.as_ptr());
                libc::_exit(127);
            }
        }

        // Parent restores its signal mask, closes the slave, and transfers
        // ownership of the master into the session.
        restore_signal_mask(&old_mask);
        drop(slave_owned);
        let master_raw = master_owned.into_raw_fd();
        let id = self.next_id;
        self.next_id = self.next_id.wrapping_add(1);
        self.sessions.insert(
            id,
            Session {
                id,
                child: pid,
                master: master_raw,
                seq: 0,
                pending_out: Vec::new(),
                pending_in: Vec::new(),
                child_exited: false,
                pty_done: false,
            },
        );
        Ok(id)
    }

    pub fn child_pid(&self, id: u32) -> Option<libc::pid_t> {
        self.sessions.get(&id).map(|s| s.child)
    }

    /// Buffer input for a session; refused when the session would exceed the
    /// bounded pending-input window.
    pub fn enqueue_input(&mut self, id: u32, data: &str) -> Result<(), SessionError> {
        let session = self.sessions.get_mut(&id).ok_or(SessionError::Unknown)?;
        if session.child_exited || session.pty_done {
            return Err(SessionError::Unknown);
        }
        if session.pending_in.len() + data.len() > PENDING_INPUT_CAP {
            return Err(SessionError::InputOverflow);
        }
        session.pending_in.extend_from_slice(data.as_bytes());
        Ok(())
    }

    /// Write as much pending input as the PTY accepts right now (non-blocking).
    pub fn write_pending_input(&mut self, id: u32) -> Result<usize, SessionError> {
        let session = self.sessions.get_mut(&id).ok_or(SessionError::Unknown)?;
        if session.pending_in.is_empty() || session.child_exited || session.pty_done {
            return Ok(0);
        }
        let chunk = session.pending_in.len().min(WRITE_CHUNK);
        let mut buf = vec![0u8; chunk];
        buf.copy_from_slice(&session.pending_in[..chunk]);
        let n = unsafe {
            libc::write(session.master, buf.as_ptr() as *const libc::c_void, chunk as libc::size_t)
        };
        if n < 0 {
            let errno = last_errno();
            if errno == libc::EINTR || errno == libc::EAGAIN {
                return Ok(0);
            }
            return Err(SessionError::Sys { step: "write", errno });
        }
        session.pending_in.drain(..n as usize);
        Ok(n as usize)
    }

    /// Apply a resize and read the effective size back from the PTY.
    pub fn resize(&mut self, id: u32, cols: u16, rows: u16) -> Result<(u16, u16), SessionError> {
        let session = self.sessions.get_mut(&id).ok_or(SessionError::Unknown)?;
        let winsize = libc::winsize {
            ws_row: rows,
            ws_col: cols,
            ws_xpixel: 0,
            ws_ypixel: 0,
        };
        let ret = unsafe { libc::ioctl(session.master, libc::TIOCSWINSZ as libc::c_ulong, &winsize) };
        if ret != 0 {
            return Err(SessionError::Sys { step: "ioctl", errno: last_errno() });
        }
        let mut readback: libc::winsize = unsafe { std::mem::zeroed() };
        let ret = unsafe { libc::ioctl(session.master, libc::TIOCGWINSZ as libc::c_ulong, &mut readback) };
        if ret != 0 {
            return Err(SessionError::Sys { step: "ioctl", errno: last_errno() });
        }
        Ok((readback.ws_col, readback.ws_row))
    }

    /// Read available PTY output into the session's bounded pending buffer.
    /// A non-blocking read of 0 (EOF) or an EIO marks the PTY done.
    pub fn read_output(&mut self, id: u32) -> Result<usize, SessionError> {
        let session = self.sessions.get_mut(&id).ok_or(SessionError::Unknown)?;
        if session.pty_done {
            return Ok(0);
        }
        let free = PENDING_OUTPUT_CAP.saturating_sub(session.pending_out.len());
        if free == 0 {
            return Ok(0); // backpressure: stop reading until the client drains us
        }
        let chunk = free.min(READ_CHUNK);
        let mut buf = vec![0u8; chunk];
        let n = unsafe {
            libc::read(session.master, buf.as_mut_ptr() as *mut libc::c_void, chunk as libc::size_t)
        };
        if n < 0 {
            let errno = last_errno();
            if errno == libc::EINTR || errno == libc::EAGAIN {
                return Ok(0);
            }
            // EIO (or any other read error) also completes the PTY.
            session.pty_done = true;
            return Err(SessionError::Sys { step: "read", errno });
        }
        if n == 0 {
            session.pty_done = true;
            return Ok(0);
        }
        session.pending_out.extend_from_slice(&buf[..n as usize]);
        Ok(n as usize)
    }

    /// Bytes of buffered, not-yet-flushed output for one session.
    pub fn pending_output_len(&self, id: u32) -> usize {
        self.sessions.get(&id).map(|s| s.pending_out.len()).unwrap_or(0)
    }

    /// Take up to READ_CHUNK bytes of a session's pending output as one
    /// (sequence, bytes) stream frame, so sequence numbers stay consecutive.
    pub fn take_pending_output_chunk(&mut self, id: u32) -> Option<(u32, Vec<u8>)> {
        let session = self.sessions.get_mut(&id)?;
        if session.pending_out.is_empty() {
            return None;
        }
        let n = session.pending_out.len().min(READ_CHUNK);
        let data: Vec<u8> = session.pending_out.drain(..n).collect();
        let seq = session.seq;
        session.seq = session.seq.wrapping_add(1);
        Some((seq, data))
    }

    /// Reap children that exited on their own; returns ids newly marked done.
    pub fn reap(&mut self) -> Vec<u32> {
        let mut newly = Vec::new();
        loop {
            let mut status: libc::c_int = 0;
            let r = unsafe { libc::waitpid(-1, &mut status, libc::WNOHANG) };
            if r <= 0 {
                break;
            }
            for session in self.sessions.values_mut() {
                if session.child == r && !session.child_exited {
                    session.child_exited = true;
                    newly.push(session.id);
                    #[cfg(feature = "test-hooks")]
                    eprintln!("helper-reaped pid={r}");
                }
            }
        }
        newly
    }

    /// Terminate and reap live children whose PTY is already done, then remove
    /// sessions that are fully finished (child reaped, PTY done, output
    /// drained). With keep=true (test hook) orphans are still terminated but
    /// finished sessions stay open for an explicit close.
    pub fn remove_finished(&mut self, keep: bool) -> Vec<u32> {
        // No orphan: a live child whose PTY closed still gets terminated+reaped.
        let orphans: Vec<u32> = self
            .sessions
            .values()
            .filter(|s| s.pty_done && !s.child_exited)
            .map(|s| s.id)
            .collect();
        for id in orphans {
            if let Some(session) = self.sessions.get_mut(&id) {
                terminate_orphan(session.child);
                session.child_exited = true;
            }
        }
        if keep {
            return Vec::new();
        }
        let ids: Vec<u32> = self
            .sessions
            .values()
            .filter(|s| s.finished())
            .map(|s| s.id)
            .collect();
        for id in &ids {
            if let Some(session) = self.sessions.remove(id) {
                unsafe { libc::close(session.master) };
            }
        }
        ids
    }

    /// Close one session now: emit everything already read (pending_out) plus
    /// the freshly drained tail, then kill and reap the child. Returns the
    /// base sequence number and READ_CHUNK-sized chunks to flush before the ack.
    pub fn close(&mut self, id: u32) -> Option<(u32, Vec<Vec<u8>>)> {
        let mut session = self.sessions.remove(&id)?;
        let mut all = std::mem::take(&mut session.pending_out);
        loop {
            if all.len() >= 2 * PENDING_OUTPUT_CAP {
                break;
            }
            let mut buf = [0u8; READ_CHUNK];
            let n = unsafe {
                libc::read(session.master, buf.as_mut_ptr() as *mut libc::c_void, buf.len())
            };
            if n > 0 {
                all.extend_from_slice(&buf[..n as usize]);
                continue;
            }
            break;
        }
        let base_seq = session.seq;
        let chunks: Vec<Vec<u8>> = if all.is_empty() {
            Vec::new()
        } else {
            all.chunks(READ_CHUNK).map(|c| c.to_vec()).collect()
        };
        if session.child_exited {
            // Already reaped by reap(): only close the master; never signal a
            // pid that may have been reused.
            unsafe { libc::close(session.master) };
        } else {
            terminate_child(session.child, session.master);
        }
        Some((base_seq, chunks))
    }

    /// Kill and reap every child immediately. Used on shutdown; leaves nothing.
    pub fn terminate_all(&mut self) {
        let ids: Vec<u32> = self.sessions.keys().copied().collect();
        for id in ids {
            if let Some(session) = self.sessions.remove(&id) {
                if session.child_exited {
                    unsafe { libc::close(session.master) };
                } else {
                    kill_and_reap(session.child, session.master);
                }
            }
        }
    }
}

/// Graceful, bounded teardown of one child (and its process group): SIGTERM, a
/// short non-blocking reap window, then SIGKILL and a guaranteed reap.
fn terminate_child(pid: libc::pid_t, master: RawFd) {
    unsafe {
        libc::close(master);
    }
    terminate_orphan(pid);
}

/// Terminate and reap a live child (and its process group) without touching
/// its master fd.
fn terminate_orphan(pid: libc::pid_t) {
    #[cfg(feature = "test-hooks")]
    eprintln!("helper-signal pid={pid} sig=SIGTERM");
    unsafe {
        libc::kill(pid, libc::SIGTERM);
        libc::kill(-pid, libc::SIGTERM);
        let mut status: libc::c_int = 0;
        for _ in 0..5 {
            let r = libc::waitpid(pid, &mut status, libc::WNOHANG);
            if r == pid || r < 0 {
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(1));
        }
        libc::kill(pid, libc::SIGKILL);
        libc::kill(-pid, libc::SIGKILL);
        libc::waitpid(pid, std::ptr::null_mut(), 0);
    }
}

/// Immediate SIGKILL teardown for shutdown.
fn kill_and_reap(pid: libc::pid_t, master: RawFd) {
    #[cfg(feature = "test-hooks")]
    eprintln!("helper-signal pid={pid} sig=SIGKILL");
    unsafe {
        libc::close(master);
        libc::kill(pid, libc::SIGKILL);
        libc::kill(-pid, libc::SIGKILL);
        libc::waitpid(pid, std::ptr::null_mut(), 0);
    }
}
