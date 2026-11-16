//! Session ownership: the helper creates a real PTY per echo session, forks a
//! child into it, and reaps children on close and on shutdown so none are ever
//! orphaned. All session fds are non-blocking and close-on-exec; the child path
//! between fork and exec performs no allocation.

use std::collections::HashMap;
use std::ffi::CString;
use std::io;
use std::os::fd::RawFd;

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
    Pty,
    Fork,
    Unknown,
    InputOverflow,
    Io(io::Error),
}

fn set_cloexec(fd: RawFd) {
    unsafe {
        let flags = libc::fcntl(fd, libc::F_GETFD);
        libc::fcntl(fd, libc::F_SETFD, flags | libc::FD_CLOEXEC);
    }
}

fn set_nonblocking(fd: RawFd) {
    unsafe {
        let flags = libc::fcntl(fd, libc::F_GETFL);
        libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK);
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
        let ret = unsafe {
            libc::openpty(
                &mut master,
                &mut slave,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                &mut winsize,
            )
        };
        if ret != 0 {
            return Err(SessionError::Pty);
        }
        set_cloexec(master);
        set_cloexec(slave);
        set_nonblocking(master);

        // Raw mode is applied to the slave by the parent, before fork, so no
        // input is ever processed in canonical/ECHO mode (which would double
        // the echo and translate newlines).
        unsafe {
            let mut tio: libc::termios = std::mem::zeroed();
            libc::tcgetattr(slave, &mut tio);
            libc::cfmakeraw(&mut tio);
            libc::tcsetattr(slave, libc::TCSANOW, &tio);
        }

        let pid = unsafe { libc::fork() };
        if pid < 0 {
            unsafe {
                libc::close(master);
                libc::close(slave);
            }
            return Err(SessionError::Fork);
        }
        if pid == 0 {
            // Child: new session, the slave as controlling terminal, raw mode,
            // stdin/stdout/stderr to the slave, then exec the echo command.
            // No allocation here: prog/c_args were built by the parent, and
            // every other inherited fd is close-on-exec.
            unsafe {
                libc::setsid();
                libc::ioctl(slave, libc::TIOCSCTTY as libc::c_ulong, 0);
                libc::dup2(slave, 0);
                libc::dup2(slave, 1);
                libc::dup2(slave, 2);
                if slave > 2 {
                    libc::close(slave);
                }
                libc::close(master);
                libc::execv(prog.as_ptr(), c_args.as_ptr());
                libc::_exit(127);
            }
        }

        // Parent keeps the master and closes the slave.
        unsafe { libc::close(slave) };
        let id = self.next_id;
        self.next_id = self.next_id.wrapping_add(1);
        self.sessions.insert(
            id,
            Session {
                id,
                child: pid,
                master,
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
            let err = io::Error::last_os_error();
            if err.kind() == io::ErrorKind::Interrupted || err.kind() == io::ErrorKind::WouldBlock {
                return Ok(0);
            }
            return Err(SessionError::Io(err));
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
            return Err(SessionError::Io(io::Error::last_os_error()));
        }
        let mut readback: libc::winsize = unsafe { std::mem::zeroed() };
        let ret = unsafe { libc::ioctl(session.master, libc::TIOCGWINSZ as libc::c_ulong, &mut readback) };
        if ret != 0 {
            return Err(SessionError::Io(io::Error::last_os_error()));
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
            let err = io::Error::last_os_error();
            if err.kind() == io::ErrorKind::Interrupted || err.kind() == io::ErrorKind::WouldBlock {
                return Ok(0);
            }
            // EIO (or any other read error) also completes the PTY.
            session.pty_done = true;
            return Ok(0);
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
                }
            }
        }
        newly
    }

    /// Terminate and reap live children whose PTY is already done, then remove
    /// sessions that are fully finished (child reaped, PTY done, output drained).
    pub fn remove_finished(&mut self) -> Vec<u32> {
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
            if all.len() >= PENDING_OUTPUT_CAP {
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
        terminate_child(session.child, session.master);
        Some((base_seq, chunks))
    }

    /// Kill and reap every child immediately. Used on shutdown; leaves nothing.
    pub fn terminate_all(&mut self) {
        let ids: Vec<u32> = self.sessions.keys().copied().collect();
        for id in ids {
            if let Some(session) = self.sessions.remove(&id) {
                kill_and_reap(session.child, session.master);
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
    unsafe {
        libc::close(master);
        libc::kill(pid, libc::SIGKILL);
        libc::kill(-pid, libc::SIGKILL);
        libc::waitpid(pid, std::ptr::null_mut(), 0);
    }
}
