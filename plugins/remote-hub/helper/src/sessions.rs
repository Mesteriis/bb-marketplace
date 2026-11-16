//! Session ownership: the helper creates a real PTY per session, forks a child
//! into it, and reaps children on close and on shutdown so none are ever
//! orphaned. All session fds are non-blocking and close-on-exec; the child path
//! between fork and exec performs no allocation.

use std::collections::HashMap;
use std::ffi::CString;
use std::os::fd::{AsRawFd, FromRawFd, IntoRawFd, OwnedFd, RawFd};
use std::time::{Duration, Instant};

/// Per-session bound on buffered, not-yet-flushed PTY output.
pub const PENDING_OUTPUT_CAP: usize = 256 * 1024;
/// Per-session bound on buffered input that has not yet been written to the PTY.
pub const PENDING_INPUT_CAP: usize = 256 * 1024;
/// Most bytes read from a PTY per poll wake-up.
pub const READ_CHUNK: usize = 64 * 1024;
/// Most bytes written to a PTY per poll wake-up.
pub const WRITE_CHUNK: usize = 64 * 1024;
/// How long to wait for the PTY to reach EOF after the direct child exits
/// before the process group is reaped (lingering descendants).
pub const LINGER_GRACE: Duration = Duration::from_secs(2);

/// A validated child spawn: built before fork, never through a shell.
pub struct SpawnSpec {
    pub program: CString,
    pub argv: Vec<CString>,
    pub env: Vec<(CString, CString)>,
    pub cwd: Option<CString>,
    pub allow_fds: Vec<i32>,
}

/// Owned argv/env strings and the null-terminated C pointers built from them.
/// Keeping the owners and the pointers together fixes the previous dangling
/// envp (the CStrings were dropped while execve still read them).
struct ExecArgv {
    prog: CString,
    argv: Vec<CString>,
    env: Vec<CString>,
    c_args: Vec<*const libc::c_char>,
    envp: Vec<*const libc::c_char>,
}

pub struct Session {
    pub id: u32,
    pub child: libc::pid_t,
    pub master: RawFd,
    pub seq: u32,
    pub pending_out: Vec<u8>,
    pub pending_in: Vec<u8>,
    pub child_exited: bool,
    pub pty_done: bool,
    /// Bytes the client has granted this session for output in flight.
    pub credit: u64,
    pub exit_code: Option<i32>,
    pub signal: Option<i32>,
    pub close_reason: Option<String>,
    pub child_exited_at: Option<Instant>,
    pub kind: String,
}

impl Session {
    fn finished(&self) -> bool {
        self.child_exited && self.pty_done && self.pending_out.is_empty()
    }
}

pub struct SessionManager {
    sessions: HashMap<u32, Session>,
    next_id: u32,
    /// Test-only argv hook (never exposed over RPC): when set, open_echo execs
    /// this argv instead of /bin/cat.
    echo_argv: Option<Vec<CString>>,
}

#[derive(Debug)]
pub enum SessionError {
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

fn is_transient_errno(errno: i32) -> bool {
    let e = errno.abs();
    e == libc::EAGAIN || e == libc::EINTR || e == libc::ENXIO
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

fn clear_cloexec(fd: RawFd) -> Result<(), SessionError> {
    unsafe {
        let flags = libc::fcntl(fd, libc::F_GETFD);
        if flags < 0 {
            return Err(SessionError::Sys { step: "fcntl", errno: last_errno() });
        }
        if libc::fcntl(fd, libc::F_SETFD, flags & !libc::FD_CLOEXEC) < 0 {
            return Err(SessionError::Sys { step: "fcntl", errno: last_errno() });
        }
    }
    Ok(())
}

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

fn parse_status(status: libc::c_int) -> (Option<i32>, Option<i32>) {
    if libc::WIFEXITED(status) {
        (Some(libc::WEXITSTATUS(status)), None)
    } else if libc::WIFSIGNALED(status) {
        (None, Some(libc::WTERMSIG(status)))
    } else {
        (None, None)
    }
}

/// ssh exits 255 for a closed interactive session; surface it as ssh_error
/// rather than a normal exit, on every teardown path (reap and orphan).
fn close_reason_for(kind: &str, code: Option<i32>) -> String {
    if kind == "ssh" && code == Some(255) {
        "ssh_error".to_string()
    } else {
        "exited".to_string()
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

    pub fn wants_write(&self, id: u32) -> bool {
        self.sessions.get(&id).map(|s| !s.pending_in.is_empty()).unwrap_or(false)
    }

    pub fn can_read_output(&self, id: u32) -> bool {
        self.sessions
            .get(&id)
            .map(|s| s.pending_out.len() < PENDING_OUTPUT_CAP && !s.pty_done && s.credit > 0)
            .unwrap_or(false)
    }

    pub fn pending_output_len(&self, id: u32) -> usize {
        self.sessions.get(&id).map(|s| s.pending_out.len()).unwrap_or(0)
    }

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

    pub fn add_credit(&mut self, id: u32, bytes: u64) -> bool {
        match self.sessions.get_mut(&id) {
            Some(s) => {
                s.credit = s.credit.saturating_add(bytes);
                true
            }
            None => false,
        }
    }

    /// The default echo spawn spec (/bin/cat) or the test-hook override.
    fn echo_spec(&self) -> SpawnSpec {
        #[cfg(feature = "test-hooks")]
        if let Ok(v) = std::env::var("REMOTE_HUB_TEST_ALLOW_PIPE") {
            if v == "1" {
                // A pipe carrying "token\n"; allowlist its read end and run a
                // shell that reads from it, then sleeps (so the test can lsof).
                if let Some(r) = make_token_pipe() {
                    let cmd = format!("read x <&{r}; echo got:$x; sleep 30");
                    return SpawnSpec {
                        program: CString::new("/bin/sh").unwrap(),
                        argv: vec![
                            CString::new("sh").unwrap(),
                            CString::new("-c").unwrap(),
                            CString::new(cmd).unwrap(),
                        ],
                        env: Vec::new(),
                        cwd: None,
                        allow_fds: vec![r],
                    };
                }
            }
        }
        match &self.echo_argv {
            Some(args) if !args.is_empty() => SpawnSpec {
                program: args[0].clone(),
                argv: args.clone(),
                env: Vec::new(),
                cwd: None,
                allow_fds: Vec::new(),
            },
            _ => SpawnSpec {
                program: CString::new("/bin/cat").unwrap(),
                argv: vec![CString::new("cat").unwrap()],
                env: Vec::new(),
                cwd: None,
                allow_fds: Vec::new(),
            },
        }
    }

    pub fn open_echo(&mut self, cols: u16, rows: u16) -> Result<u32, SessionError> {
        let spec = self.echo_spec();
        self.open_session(spec, cols, rows, "echo".to_string())
    }

    /// Open an SSH session from a client-provided (already validated) spawn spec.
    pub fn open_ssh(
        &mut self,
        spec: SpawnSpec,
        cols: u16,
        rows: u16,
    ) -> Result<u32, SessionError> {
        self.open_session(spec, cols, rows, "ssh".to_string())
    }

    /// Owning argv/env storage plus the C pointers built from it. The
    /// pointers stay valid exactly as long as the returned value is alive, so
    /// `open_session` keeps it alive until after fork/exec.
    fn build_exec_argv(&self, spec: &SpawnSpec) -> ExecArgv {
        let argv = spec.argv.clone();
        let env: Vec<CString> = spec
            .env
            .iter()
            .map(|(k, v)| {
                let mut kv = k.as_bytes().to_vec();
                kv.push(b'=');
                kv.extend_from_slice(v.as_bytes());
                CString::new(kv).expect("env has no NUL")
            })
            .collect();
        let mut c_args: Vec<*const libc::c_char> = argv.iter().map(|a| a.as_ptr()).collect();
        c_args.push(std::ptr::null());
        let mut envp: Vec<*const libc::c_char> = env.iter().map(|s| s.as_ptr()).collect();
        envp.push(std::ptr::null());
        ExecArgv {
            prog: spec.program.clone(),
            argv,
            env,
            c_args,
            envp,
        }
    }

    pub fn open_session(
        &mut self,
        spec: SpawnSpec,
        cols: u16,
        rows: u16,
        kind: String,
    ) -> Result<u32, SessionError> {
        let exec = self.build_exec_argv(&spec);
        let mut master: libc::c_int = -1;
        let mut slave: libc::c_int = -1;
        let mut winsize = libc::winsize {
            ws_row: rows,
            ws_col: cols,
            ws_xpixel: 0,
            ws_ypixel: 0,
        };
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
            std::thread::sleep(Duration::from_millis(2));
        }
        if master < 0 || slave < 0 {
            return Err(SessionError::Sys { step: "openpty", errno: openpty_errno });
        }
        let master_owned = unsafe { OwnedFd::from_raw_fd(master) };
        let slave_owned = unsafe { OwnedFd::from_raw_fd(slave) };
        let master = master_owned.as_raw_fd();
        let slave = slave_owned.as_raw_fd();
        set_cloexec(master)?;
        set_cloexec(slave)?;
        set_nonblocking(master)?;

        unsafe {
            let mut tio: libc::termios = std::mem::zeroed();
            if libc::tcgetattr(slave, &mut tio) != 0 {
                return Err(SessionError::Sys { step: "termios", errno: last_errno() });
            }
            // The echo console round-trips bytes exactly once, so it runs raw
            // (no tty echo, no signal generation). SSH must start from a normal
            // interactive termios: ssh saves it, enters raw mode locally, and
            // forwards the saved modes to the remote PTY. A raw slave here would
            // be forwarded and disable ISIG/ICANON/ECHO on the remote, breaking
            // Ctrl+C and command echo in the remote session.
            if kind == "echo" {
                libc::cfmakeraw(&mut tio);
                if libc::tcsetattr(slave, libc::TCSANOW, &tio) != 0 {
                    return Err(SessionError::Sys { step: "termios", errno: last_errno() });
                }
            }
        }

        // Allowlisted fds must survive exec: clear CLOEXEC on them.
        for fd in &spec.allow_fds {
            clear_cloexec(*fd)?;
        }
        let inherited = open_fds_above_two()?;
        let allow_fds = spec.allow_fds.clone();

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
            std::thread::sleep(Duration::from_millis(1));
        }
        if pid < 0 {
            restore_signal_mask(&old_mask);
            return Err(SessionError::Sys { step: "fork", errno: fork_errno });
        }
        if pid == 0 {
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
                    if *fd != slave && !allow_fds.contains(fd) {
                        libc::close(*fd);
                    }
                }
                if let Some(cwd) = &spec.cwd {
                    libc::chdir(cwd.as_ptr());
                }
                libc::execve(exec.prog.as_ptr(), exec.c_args.as_ptr(), exec.envp.as_ptr());
                libc::_exit(127);
            }
        }

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
                credit: if kind == "echo" { u64::MAX } else { 0 },
                exit_code: None,
                signal: None,
                close_reason: None,
                child_exited_at: None,
                kind,
            },
        );
        Ok(id)
    }

    pub fn child_pid(&self, id: u32) -> Option<libc::pid_t> {
        self.sessions.get(&id).map(|s| s.child)
    }

    pub fn enqueue_input(&mut self, id: u32, data: &[u8]) -> Result<(), SessionError> {
        let session = self.sessions.get_mut(&id).ok_or(SessionError::Unknown)?;
        if session.child_exited || session.pty_done {
            return Err(SessionError::Unknown);
        }
        if session.pending_in.len() + data.len() > PENDING_INPUT_CAP {
            return Err(SessionError::InputOverflow);
        }
        session.pending_in.extend_from_slice(data);
        Ok(())
    }

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

    pub fn read_output(&mut self, id: u32) -> Result<usize, SessionError> {
        let session = self.sessions.get_mut(&id).ok_or(SessionError::Unknown)?;
        if session.pty_done || session.credit == 0 {
            return Ok(0);
        }
        let free = PENDING_OUTPUT_CAP.saturating_sub(session.pending_out.len());
        if free == 0 {
            return Ok(0);
        }
        let budget = session.credit.min(free as u64) as usize;
        let chunk = budget.min(READ_CHUNK);
        if chunk == 0 {
            return Ok(0);
        }
        let mut buf = vec![0u8; chunk];
        let n = unsafe {
            libc::read(session.master, buf.as_mut_ptr() as *mut libc::c_void, chunk as libc::size_t)
        };
        if n < 0 {
            let errno = last_errno();
            if errno == libc::EINTR || errno == libc::EAGAIN {
                return Ok(0);
            }
            session.pty_done = true;
            return Err(SessionError::Sys { step: "read", errno });
        }
        if n == 0 {
            session.pty_done = true;
            return Ok(0);
        }
        session.pending_out.extend_from_slice(&buf[..n as usize]);
        session.credit = session.credit.saturating_sub(n as u64);
        Ok(n as usize)
    }

    /// Reap one reaped child and update the matching session. Returns the
    /// session id when a session claimed this child.
    fn reap_one(&mut self, pid: libc::pid_t, status: libc::c_int) -> Option<u32> {
        let (code, sig) = parse_status(status);
        for session in self.sessions.values_mut() {
            if session.child == pid && !session.child_exited {
                session.child_exited = true;
                session.exit_code = code;
                session.signal = sig;
                // ssh exits 255 for a closed interactive session; surface it
                // as ssh_error rather than a normal exit.
                session.close_reason = Some(close_reason_for(&session.kind, code));
                session.child_exited_at = Some(Instant::now());
                #[cfg(feature = "test-hooks")]
                eprintln!("helper-reaped pid={pid}");
                return Some(session.id);
            }
        }
        None
    }

    pub fn reap(&mut self) -> Vec<u32> {
        let mut newly = Vec::new();
        loop {
            let mut status: libc::c_int = 0;
            let r = unsafe { libc::waitpid(-1, &mut status, libc::WNOHANG) };
            if r <= 0 {
                break;
            }
            if let Some(id) = self.reap_one(r, status) {
                newly.push(id);
            }
        }
        // V9: the kernel closes the slave before the child is a zombie, so a
        // PTY that just reached EOF may not be reapable in the same instant. Wait
        // a bounded 200 ms before remove_finished misreads the child as an orphan
        // and SIGTERMs its process group.
        let eof_unreaped: Vec<libc::pid_t> = self
            .sessions
            .values()
            .filter(|s| s.pty_done && !s.child_exited)
            .map(|s| s.child)
            .collect();
        for pid in eof_unreaped {
            let deadline = Instant::now() + Duration::from_millis(200);
            let mut status: libc::c_int = 0;
            loop {
                let r = unsafe { libc::waitpid(pid, &mut status, libc::WNOHANG) };
                if r == pid {
                    if let Some(id) = self.reap_one(pid, status) {
                        newly.push(id);
                    }
                    break;
                }
                if r < 0 || Instant::now() >= deadline {
                    break;
                }
                std::thread::sleep(Duration::from_millis(2));
            }
        }
        newly
    }

    pub fn remove_finished(&mut self, keep: bool) -> Vec<(u32, Option<i32>, Option<i32>, String)> {
        let orphans: Vec<u32> = self
            .sessions
            .values()
            .filter(|s| s.pty_done && !s.child_exited)
            .map(|s| s.id)
            .collect();
        for id in orphans {
            if let Some(session) = self.sessions.get_mut(&id) {
                let (code, sig) = terminate_orphan(session.child);
                session.child_exited = true;
                session.exit_code = code;
                session.signal = sig;
                session.close_reason = Some(close_reason_for(&session.kind, code));
                session.child_exited_at = Some(Instant::now());
            }
        }

        // Lingering descendants: after the grace period, reap the process group.
        let lingerers: Vec<u32> = self
            .sessions
            .values()
            .filter(|s| s.child_exited && !s.pty_done)
            .filter(|s| s.child_exited_at.map(|t| t.elapsed() >= LINGER_GRACE).unwrap_or(false))
            .map(|s| s.id)
            .collect();
        for id in lingerers {
            if let Some(session) = self.sessions.get_mut(&id) {
                kill_process_group(session.child);
                session.pty_done = true;
            }
        }

        if keep {
            return Vec::new();
        }
        let ids: Vec<(u32, Option<i32>, Option<i32>, String)> = self
            .sessions
            .values()
            .filter(|s| s.finished())
            .map(|s| {
                (
                    s.id,
                    s.exit_code,
                    s.signal,
                    s.close_reason.clone().unwrap_or_else(|| "exited".to_string()),
                )
            })
            .collect();
        for (id, _, _, _) in &ids {
            if let Some(session) = self.sessions.remove(id) {
                unsafe { libc::close(session.master) };
            }
        }
        ids
    }

    pub fn close(&mut self, id: u32) -> Option<(u32, Vec<Vec<u8>>, Option<i32>, Option<i32>, String)> {
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
        let (code, sig, reason) = if session.child_exited {
            (
                session.exit_code,
                session.signal,
                session.close_reason.unwrap_or_else(|| "exited".to_string()),
            )
        } else {
            let (c, s) = terminate_child(session.child, session.master);
            (c, s, "killed_by_close".to_string())
        };
        Some((base_seq, chunks, code, sig, reason))
    }

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

fn terminate_child(pid: libc::pid_t, master: RawFd) -> (Option<i32>, Option<i32>) {
    unsafe { libc::close(master) };
    terminate_orphan(pid)
}

fn terminate_orphan(pid: libc::pid_t) -> (Option<i32>, Option<i32>) {
    #[cfg(feature = "test-hooks")]
    eprintln!("helper-signal pid={pid} sig=SIGTERM");
    unsafe {
        libc::kill(pid, libc::SIGTERM);
        libc::kill(-pid, libc::SIGTERM);
        let mut status: libc::c_int = 0;
        for _ in 0..5 {
            let r = libc::waitpid(pid, &mut status, libc::WNOHANG);
            if r == pid {
                return parse_status(status);
            }
            if r < 0 {
                return (None, None);
            }
            std::thread::sleep(Duration::from_millis(1));
        }
        libc::kill(pid, libc::SIGKILL);
        libc::kill(-pid, libc::SIGKILL);
        libc::waitpid(pid, &mut status, 0);
        parse_status(status)
    }
}

fn kill_process_group(pid: libc::pid_t) {
    unsafe {
        libc::kill(-pid, libc::SIGHUP);
        libc::kill(-pid, libc::SIGTERM);
        libc::kill(-pid, libc::SIGKILL);
    }
}

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

#[cfg(feature = "test-hooks")]
fn make_token_pipe() -> Option<i32> {
    let mut fds = [0i32; 2];
    if unsafe { libc::pipe(fds.as_mut_ptr()) } != 0 {
        return None;
    }
    let token = b"token\n";
    let mut written = 0usize;
    while written < token.len() {
        let n = unsafe { libc::write(fds[1], token[written..].as_ptr() as *const libc::c_void, token.len() - written) };
        if n <= 0 {
            unsafe {
                libc::close(fds[0]);
                libc::close(fds[1]);
            }
            return None;
        }
        written += n as usize;
    }
    unsafe { libc::close(fds[1]) };
    Some(fds[0])
}
