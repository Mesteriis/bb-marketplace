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
/// How long an EOF/HUP without a reaped child may wait before the child is
/// treated as an orphan (checked on later event-loop iterations, never slept).
pub const REAP_GRACE: Duration = Duration::from_millis(1000);

#[cfg(feature = "test-hooks")]
static HUP_BEFORE_REAP: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

fn record_hup_before_reap() {
    #[cfg(feature = "test-hooks")]
    {
        let n = HUP_BEFORE_REAP.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
        eprintln!("helper-hup-before-reap count={n}");
    }
}

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
    _argv: Vec<CString>,
    _env: Vec<CString>,
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
    /// Who may type into this session (stage 4b-1, Z2); pending_in only ever holds this owner's bytes.
    pub owner: String,
    pub child_exited: bool,
    pub pty_done: bool,
    /// Bytes the client has granted this session for output in flight.
    pub credit: u64,
    pub exit_code: Option<i32>,
    pub signal: Option<i32>,
    pub close_reason: Option<String>,
    pub child_exited_at: Option<Instant>,
    pub reap_deadline: Option<Instant>,
    pub kind: String,
}

impl Session {
    /// The terminal can no longer take input (hung up, or its child is gone):
    /// anything still queued can never be delivered, and keeping it would keep
    /// the fd in the poll set for POLLOUT, which a hung-up pty answers with an
    /// immediate POLLHUP every turn (a CPU spin while the client is not reading
    /// the output that still waits for room).
    fn end_input(&mut self) {
        self.pending_in.clear();
    }

    fn finished(&self) -> bool {
        self.child_exited && self.pty_done && self.pending_out.is_empty()
    }
}

pub struct SessionManager {
    sessions: HashMap<u32, Session>,
    ids: crate::ids::SessionIds,
    /// Test-only argv hook (never exposed over RPC): when set, open_echo execs
    /// this argv instead of /bin/cat.
    echo_argv: Option<Vec<CString>>,
    /// Created at the first SSH session that uses a saved credential (stage 3b-2).
    askpass: Option<crate::askpass::Broker>,
    /// The private known_hosts copy of each saved-secret ssh session; merged into the overlay when it ends.
    host_key_copies: HashMap<u32, crate::known_hosts::SessionCopy>,
    /// Sessions whose user just answered "yes" to a host-key question: ssh writes the key to the copy right after,
    /// and `merge_host_keys_pending` moves it into the overlay as soon as it is there.
    host_key_confirmed: HashMap<u32, Instant>,
    /// First-use endpoints (`host:port`, no key in the overlay yet) with the session that is deciding them. While
    /// a hold lives, another saved-secret open to the same endpoint is refused: its copy of the overlay would not
    /// have the key the first session is about to record, and it could be shown a DIFFERENT key as unknown.
    endpoint_holds: HashMap<String, (u32, Instant)>,
    /// Remote commands (stage 4b-2): ids come from the same allocator as sessions.
    pub(crate) exec: crate::exec::ExecManager,
    exec_copies: HashMap<u32, crate::known_hosts::SessionCopy>,
    pub(crate) sftp: crate::sftp::SftpManager,
}

/// How long a first-use hold lasts at most: long enough for a person to read a host-key question.
const ENDPOINT_HOLD: Duration = Duration::from_secs(120);

#[derive(Debug)]
pub enum SessionError {
    Sys { step: &'static str, errno: i32 },
    Unknown,
    InputOverflow,
    /// Input from someone who is not the session's current driver (Z2).
    StaleOwner,
    /// All 2^32 - 1 session ids have been issued.
    IdsExhausted,
}

impl std::fmt::Display for SessionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SessionError::Sys { step, errno } => write!(f, "{step} failed: {}", errno_text(*errno)),
            SessionError::Unknown => write!(f, "no such session"),
            SessionError::InputOverflow => write!(f, "session input overflows the pending-input window"),
            SessionError::StaleOwner => write!(f, "the input is from someone who no longer drives this session"),
            SessionError::IdsExhausted => write!(f, "session ids are exhausted"),
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

/// A pipe whose two ends are close-on-exec (the helper is single-threaded at the
/// fork sites, so nothing can fork between `pipe` and `fcntl`).
fn make_start_gate() -> Result<(RawFd, RawFd), SessionError> {
    let mut fds = [0i32; 2];
    if unsafe { libc::pipe(fds.as_mut_ptr()) } != 0 {
        return Err(SessionError::Sys { step: "pipe", errno: last_errno() });
    }
    for fd in fds {
        if let Err(e) = set_cloexec(fd) {
            unsafe {
                libc::close(fds[0]);
                libc::close(fds[1]);
            }
            return Err(e);
        }
    }
    Ok((fds[0], fds[1]))
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

pub(crate) fn open_fds_above_two() -> Result<Vec<i32>, SessionError> {
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

pub(crate) fn block_all_signals(old_mask: &mut libc::sigset_t) {
    unsafe {
        let mut all: libc::sigset_t = std::mem::zeroed();
        libc::sigfillset(&mut all);
        libc::pthread_sigmask(libc::SIG_SETMASK, &all, old_mask);
    }
}

pub(crate) fn restore_signal_mask(old_mask: &libc::sigset_t) {
    unsafe { libc::pthread_sigmask(libc::SIG_SETMASK, old_mask, std::ptr::null_mut()) };
}

pub(crate) fn reset_signals_and_unblock() {
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
        Self::with_ids(echo_argv, crate::ids::SessionIds::new())
    }

    /// A manager that draws session ids from a shared allocator, so ids never
    /// collide with another session kind's.
    pub fn with_ids(echo_argv: Option<Vec<String>>, ids: crate::ids::SessionIds) -> Self {
        let argv = echo_argv.map(|args| {
            args.iter()
                .map(|a| CString::new(a.as_str()).expect("echo argv has no NUL"))
                .collect()
        });
        SessionManager {
            sessions: HashMap::new(),
            ids,
            echo_argv: argv,
            askpass: None,
            host_key_copies: HashMap::new(),
            host_key_confirmed: HashMap::new(),
            endpoint_holds: HashMap::new(),
            exec: crate::exec::ExecManager::new(),
            exec_copies: HashMap::new(),
            sftp: crate::sftp::SftpManager::new(),
        }
    }

    /// Starts a remote command under a fresh id. With `askpass` the saved secret is answered for its ONE expected prompt
    /// and every other question is refused (nobody is there to answer); `copy` is the private known_hosts file ssh uses.
    pub fn exec_start(
        &mut self,
        mut spec: crate::exec::ExecSpec,
        askpass: Option<(String, crate::binding::Bind, String)>,
        helper_exe: &str,
        copy: Option<crate::known_hosts::SessionCopy>,
    ) -> Result<u32, crate::exec::ExecError> {
        let id = self.ids.next().ok_or(crate::exec::ExecError::Spawn(0))?;
        let nonce = self.unattended_askpass_env(askpass.is_some(), helper_exe, &mut spec.env).map_err(crate::exec::ExecError::Spawn)?;
        match self.exec.start(id, spec) {
            Ok(()) => {
                if let (Some(n), Some((reference, bind, expected))) = (nonce, askpass) {
                    let pid = self.exec.pid(id).unwrap_or(0);
                    if let Some(broker) = self.askpass.as_mut() {
                        broker.register(&n, id, pid, &reference, bind, &expected);
                        broker.set_refuse(id);
                    }
                }
                if let Some(c) = copy {
                    self.exec_copies.insert(id, c);
                }
                Ok(id)
            }
            Err(e) => {
                if let (Some(n), Some(broker)) = (nonce, self.askpass.as_mut()) {
                    broker.discard(&n);
                }
                if let Some(c) = copy {
                    let _ = std::fs::remove_file(&c.path);
                }
                Err(e)
            }
        }
    }

    /// Prepares the askpass of a run nobody watches: creates the broker if needed and puts its variables into `env`.
    /// Returns the nonce to register the started program under. Err is an errno.
    fn unattended_askpass_env(&mut self, wanted: bool, helper_exe: &str, env: &mut Vec<(String, String)>) -> Result<Option<String>, i32> {
        if !wanted {
            return Ok(None);
        }
        if self.askpass.is_none() {
            self.askpass = Some(crate::askpass::Broker::new(helper_exe).map_err(|e| e.raw_os_error().unwrap_or(0))?);
        }
        let broker = self.askpass.as_mut().expect("just created");
        let (n, vars) = broker.prepare();
        #[cfg(feature = "test-hooks")]
        let mut vars = vars;
        #[cfg(feature = "test-hooks")]
        for key in ["REMOTE_HUB_KEYCHAIN_PATH", "REMOTE_HUB_ASKPASS_UI_TIMEOUT_MS"] {
            if let Ok(value) = std::env::var(key) {
                vars.push((key.to_string(), value));
            }
        }
        for (k, v) in vars {
            env.retain(|(ek, _)| *ek != k);
            env.push((k, v));
        }
        Ok(Some(n))
    }

    /// Starts an SFTP channel under a fresh id, with the same askpass and host-key rules as a remote command.
    pub fn sftp_start(
        &mut self,
        mut spec: crate::sftp::SftpSpec,
        askpass: Option<(String, crate::binding::Bind, String)>,
        helper_exe: &str,
        copy: Option<crate::known_hosts::SessionCopy>,
    ) -> Result<u32, crate::sftp::SftpError> {
        let id = self.ids.next().ok_or(crate::sftp::SftpError::Spawn(0))?;
        let nonce = self.unattended_askpass_env(askpass.is_some(), helper_exe, &mut spec.env).map_err(crate::sftp::SftpError::Spawn)?;
        match self.sftp.start(id, spec) {
            Ok(()) => {
                if let (Some(n), Some((reference, bind, expected))) = (nonce, askpass) {
                    let pid = self.sftp.pid(id).unwrap_or(0);
                    if let Some(broker) = self.askpass.as_mut() {
                        broker.register(&n, id, pid, &reference, bind, &expected);
                        broker.set_refuse(id);
                    }
                }
                if let Some(c) = copy {
                    self.exec_copies.insert(id, c);
                }
                Ok(id)
            }
            Err(e) => {
                if let (Some(n), Some(broker)) = (nonce, self.askpass.as_mut()) {
                    broker.discard(&n);
                }
                if let Some(c) = copy {
                    let _ = std::fs::remove_file(&c.path);
                }
                Err(e)
            }
        }
    }

    /// Relays bytes and reaps; ends the askpass of the channels that closed and removes their host-key copies.
    pub fn sftp_pump(&mut self, budget: usize) -> (Vec<crate::sftp::Output>, Vec<crate::sftp::Closed>) {
        let (outputs, closed) = self.sftp.pump(budget);
        for c in &closed {
            if let Some(b) = self.askpass.as_mut() {
                b.session_closed(c.id);
            }
            if let Some(copy) = self.exec_copies.remove(&c.id) {
                let _ = std::fs::remove_file(&copy.path);
            }
        }
        (outputs, closed)
    }

    /// Reads, enforces limits, reaps; ends the askpass of the runs that finished and removes their host-key copies.
    pub fn exec_pump(&mut self) -> Vec<crate::exec::Finished> {
        let finished = self.exec.pump();
        for f in &finished {
            if let Some(b) = self.askpass.as_mut() {
                b.session_closed(f.id);
            }
            if let Some(c) = self.exec_copies.remove(&f.id) {
                let _ = std::fs::remove_file(&c.path);
            }
        }
        finished
    }

    /// Whether a live session is still deciding this endpoint's first host key.
    pub fn endpoint_pending(&mut self, endpoint: &str) -> bool {
        match self.endpoint_holds.get(endpoint) {
            Some((id, since)) if since.elapsed() < ENDPOINT_HOLD && self.sessions.contains_key(id) => true,
            Some(_) => {
                self.endpoint_holds.remove(endpoint);
                false
            }
            None => false,
        }
    }

    pub fn hold_endpoint(&mut self, id: u32, endpoint: String) {
        self.endpoint_holds.insert(endpoint, (id, Instant::now()));
    }

    fn release_endpoints(&mut self, id: u32) {
        self.endpoint_holds.retain(|_, (holder, _)| *holder != id);
    }

    /// Tries, for sessions whose user confirmed a host key a moment ago, to move that key into the overlay now.
    /// A key that does not show up within a few seconds is left to the final merge when the session ends.
    pub fn merge_host_keys_pending(&mut self) {
        let ids: Vec<u32> = self.host_key_confirmed.keys().copied().collect();
        for id in ids {
            let since = self.host_key_confirmed[&id];
            let done = match self.host_key_copies.get_mut(&id) {
                Some(copy) => matches!(crate::known_hosts::merge_now(copy), Ok(n) if n > 0) || since.elapsed() > Duration::from_secs(10),
                None => true,
            };
            if done {
                self.host_key_confirmed.remove(&id);
                // The key is in the overlay now (or will not come): the next open sees what there is.
                self.release_endpoints(id);
            }
        }
    }

    pub fn set_host_key_copy(&mut self, id: u32, copy: crate::known_hosts::SessionCopy) {
        self.host_key_copies.insert(id, copy);
    }

    /// Opens an SSH session whose secret prompts the helper answers from the Keychain
    /// (`reference`) and whose other prompts go to the user. The askpass environment is added
    /// here, after validation: a request cannot supply it.
    pub fn open_ssh_with_askpass(
        &mut self,
        mut spec: SpawnSpec,
        cols: u16,
        rows: u16,
        reference: &str,
        bind: crate::binding::Bind,
        expected_prompt: &str,
        helper_exe: &str,
    ) -> Result<u32, SessionError> {
        if self.askpass.is_none() {
            self.askpass = Some(
                crate::askpass::Broker::new(helper_exe)
                    .map_err(|e| SessionError::Sys { step: "askpass", errno: e.raw_os_error().unwrap_or(0) })?,
            );
        }
        let broker = self.askpass.as_mut().expect("just created");
        let (nonce, mut env) = broker.prepare();
        // OpenSSH runs LocalCommand on this machine only after the login succeeded: the trusted signal that the
        // server accepted the secret. The values are fixed here, after the caller's argv was validated (and the
        // validator refuses both options from anyone else).
        if spec.argv.first().and_then(|a| a.to_str().ok()).map(|a| a.rsplit('/').next() == Some("ssh")).unwrap_or(false) {
            if let Some(at) = spec.argv.iter().position(|a| a.as_bytes() == b"--") {
                let command = broker.connected_command();
                let extra: Vec<CString> = ["-o", "PermitLocalCommand=yes", "-o"]
                    .iter()
                    .map(|v| CString::new(*v).expect("no nul"))
                    .chain(std::iter::once(CString::new(format!("LocalCommand={command}")).map_err(|_| SessionError::Sys { step: "localcommand", errno: 0 })?))
                    .collect();
                spec.argv.splice(at..at, extra);
            }
        }
        // Test-hooks only: the askpass client (a child of ssh, with the session's small environment)
        // must open the same temporary keychain the helper was given.
        #[cfg(feature = "test-hooks")]
        for key in ["REMOTE_HUB_KEYCHAIN_PATH", "REMOTE_HUB_ASKPASS_UI_TIMEOUT_MS"] {
            if let Ok(value) = std::env::var(key) {
                env.push((key.to_string(), value));
            }
        }
        for (k, v) in env {
            if let (Ok(k), Ok(v)) = (CString::new(k), CString::new(v)) {
                spec.env.retain(|(ek, _)| *ek != k);
                spec.env.push((k, v));
            }
        }
        let id = self.open_session(spec, cols, rows, "ssh".to_string())?;
        let pid = self.child_pid(id).unwrap_or(0);
        if let Some(broker) = self.askpass.as_mut() {
            broker.register(&nonce, id, pid, reference, bind, expected_prompt);
        }
        Ok(id)
    }

    /// Descriptors of the askpass socket and its open requests (read interest).
    pub fn askpass_fds(&self) -> Vec<RawFd> {
        self.askpass.as_ref().map(|b| b.fds()).unwrap_or_default()
    }

    /// Accepts and decides askpass requests; returns what the helper must tell its client.
    pub fn askpass_service(&mut self, fetch: &mut dyn FnMut(&str) -> Result<crate::keychain::Item, String>) -> Vec<crate::askpass::BrokerEvent> {
        match self.askpass.as_mut() {
            Some(broker) => {
                broker.service(fetch);
                broker.take_events()
            }
            None => Vec::new(),
        }
    }

    pub fn askpass_answer(&mut self, session_id: u32, prompt_id: u64, answer: Option<String>) -> bool {
        if answer.as_deref().map(|a| a.trim().eq_ignore_ascii_case("yes")).unwrap_or(false) && self.host_key_copies.contains_key(&session_id) {
            self.host_key_confirmed.insert(session_id, Instant::now());
        }
        self.askpass.as_mut().map(|b| b.answer(session_id, prompt_id, answer)).unwrap_or(false)
    }

    fn askpass_forget(&mut self, id: u32) {
        self.host_key_confirmed.remove(&id);
        self.release_endpoints(id);
        if let Some(copy) = self.host_key_copies.remove(&id) {
            crate::known_hosts::merge_session(&copy);
        }
        if let Some(broker) = self.askpass.as_mut() {
            broker.session_closed(id);
        }
    }

    pub fn count(&self) -> usize {
        self.sessions.len()
    }

    pub fn fds(&self) -> Vec<(u32, RawFd)> {
        self.sessions.iter().map(|(&id, s)| (id, s.master)).collect()
    }

    pub fn wants_write(&self, id: u32) -> bool {
        self.sessions
            .get(&id)
            .map(|s| !s.pending_in.is_empty() && !s.child_exited && !s.pty_done)
            .unwrap_or(false)
    }

    /// The events a session's fd asks of one poll turn.
    pub fn poll_interest(&self, id: u32) -> libc::c_short {
        let mut events = 0;
        if self.can_read_output(id) {
            events |= libc::POLLIN;
        }
        if self.wants_write(id) {
            events |= libc::POLLOUT;
        }
        events
    }

    /// One poll turn's handling for a session, in the order the loop uses:
    /// read, hang-up, write.
    pub fn handle_poll_events(&mut self, id: u32, revents: libc::c_short) {
        if revents & libc::POLLIN != 0 {
            let _ = self.read_output(id);
        }
        if revents & (libc::POLLHUP | libc::POLLERR | libc::POLLNVAL) != 0 {
            self.mark_hup(id);
        }
        if revents & libc::POLLOUT != 0 {
            let _ = self.write_pending_input(id);
        }
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
            _argv: argv,
            _env: env,
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
        // The id is taken before anything is spawned: exhaustion must not leave
        // a child behind.
        let id = self.ids.next().ok_or(SessionError::IdsExhausted)?;
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
        // Created AFTER the descriptor list above, so the child's close loop does not
        // close the read end before it has waited on it. Both ends are close-on-exec.
        let (gate_r, gate_w) = make_start_gate()?;

        // fork-without-exec work is only sound in a single-threaded process.
        crate::threads::assert_single_threaded("pty session fork");
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
            unsafe {
                libc::close(gate_r);
                libc::close(gate_w);
            }
            return Err(SessionError::Sys { step: "fork", errno: fork_errno });
        }
        if pid == 0 {
            reset_signals_and_unblock();
            unsafe {
                // Wait until the parent has dropped ITS copy of the slave: if the
                // child could write and exit while the parent still holds the slave,
                // the parent's later drop would be the last close, and on macOS the
                // last close of a pty slave discards the output nobody has read
                // yet. read() returns at once when the parent closes the write end
                // (or dies: the kernel closes it), so this cannot wait for ever.
                libc::close(gate_w);
                let mut byte = 0u8;
                loop {
                    let n = libc::read(gate_r, &mut byte as *mut u8 as *mut libc::c_void, 1);
                    if n >= 0 || last_errno() != libc::EINTR {
                        break;
                    }
                }
                libc::close(gate_r);
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
        unsafe { libc::close(gate_r) };
        #[cfg(feature = "test-hooks")]
        if let Some(ms) = std::env::var("REMOTE_HUB_TEST_DELAY_AFTER_FORK_MS").ok().and_then(|v| v.parse::<u64>().ok()) {
            // A helper descheduled between fork and the slave drop (test only).
            std::thread::sleep(Duration::from_millis(ms));
        }
        drop(slave_owned);
        // Only now may the child run on: our slave copy is gone.
        unsafe { libc::close(gate_w) };
        let master_raw = master_owned.into_raw_fd();
        self.sessions.insert(
            id,
            Session {
                id,
                child: pid,
                master: master_raw,
                seq: 0,
                pending_out: Vec::new(),
                pending_in: Vec::new(),
                owner: "human".to_string(),
                child_exited: false,
                pty_done: false,
                credit: if kind == "echo" { u64::MAX } else { 0 },
                exit_code: None,
                signal: None,
                close_reason: None,
                child_exited_at: None,
                reap_deadline: None,
                kind,
            },
        );
        Ok(id)
    }

    pub fn child_pid(&self, id: u32) -> Option<libc::pid_t> {
        self.sessions.get(&id).map(|s| s.child)
    }

    /// A new driver: what the previous one still had waiting for the PTY is dropped (the count is returned) and only the
    /// new owner's input is accepted from now on. The caller acknowledges AFTER this returns: that is the barrier.
    pub fn set_owner(&mut self, id: u32, owner: &str) -> Result<usize, SessionError> {
        let session = self.sessions.get_mut(&id).ok_or(SessionError::Unknown)?;
        let dropped = if session.owner != owner { std::mem::take(&mut session.pending_in).len() } else { 0 };
        session.owner = owner.to_string();
        Ok(dropped)
    }

    pub fn contains(&self, id: u32) -> bool {
        self.sessions.contains_key(&id)
    }

    /// `owner` is who sent it; anyone but the current owner is refused (`StaleOwner`).
    pub fn enqueue_input_from(&mut self, id: u32, owner: &str, data: &[u8]) -> Result<(), SessionError> {
        let session = self.sessions.get(&id).ok_or(SessionError::Unknown)?;
        if session.owner != owner {
            return Err(SessionError::StaleOwner);
        }
        self.enqueue_input(id, data)
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
            session.end_input();
            session.reap_deadline = Some(Instant::now() + REAP_GRACE);
            return Err(SessionError::Sys { step: "read", errno });
        }
        if n == 0 {
            session.pty_done = true;
            session.end_input();
            session.reap_deadline = Some(Instant::now() + REAP_GRACE);
            if !session.child_exited {
                record_hup_before_reap();
            }
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
                session.end_input();
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

    /// Reap the children THIS manager owns, by pid. Never `waitpid(-1)`: that
    /// would steal exits that belong to another owner of children (the RDP
    /// engines), which then lose their exit status.
    pub fn reap(&mut self) -> Vec<u32> {
        let live: Vec<libc::pid_t> = self
            .sessions
            .values()
            .filter(|s| !s.child_exited)
            .map(|s| s.child)
            .collect();
        let mut newly = Vec::new();
        for pid in live {
            let mut status: libc::c_int = 0;
            let r = unsafe { libc::waitpid(pid, &mut status, libc::WNOHANG) };
            if r != pid {
                continue;
            }
            if let Some(id) = self.reap_one(r, status) {
                newly.push(id);
            }
        }
        newly
    }

    /// A POLLHUP/POLLERR on a session PTY that is not being read (e.g. zero
    /// credit) must still mark the PTY done, or poll would re-report the hangup
    /// forever and spin the loop.
    pub fn mark_hup(&mut self, id: u32) {
        if let Some(session) = self.sessions.get_mut(&id) {
            if !session.pty_done {
                session.pty_done = true;
                session.end_input();
                session.reap_deadline = Some(Instant::now() + REAP_GRACE);
                if !session.child_exited {
                    record_hup_before_reap();
                }
            }
        }
    }

    pub fn remove_finished(&mut self, keep: bool) -> Vec<(u32, Option<i32>, Option<i32>, String)> {
        let orphans: Vec<u32> = self
            .sessions
            .values()
            .filter(|s| s.pty_done && !s.child_exited)
            .filter(|s| s.reap_deadline.map(|d| d <= Instant::now()).unwrap_or(true))
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
                session.end_input();
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
            self.askpass_forget(*id);
        }
        ids
    }

    pub fn close(&mut self, id: u32) -> Option<(u32, Vec<Vec<u8>>, Option<i32>, Option<i32>, String)> {
        self.askpass_forget(id);
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
            // A reaped direct child may still have descendants holding the PTY
            // open. Close the master on this path too (it leaked before) and
            // reap the remaining process group without signalling the already
            // reaped direct child pid.
            if !session.pty_done {
                kill_process_group(session.child);
            }
            unsafe { libc::close(session.master) };
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
        self.exec.terminate_all();
        self.sftp.terminate_all();
        for (_, c) in self.exec_copies.drain() {
            let _ = std::fs::remove_file(&c.path);
        }
        let ids: Vec<u32> = self.sessions.keys().copied().collect();
        for id in ids {
            if let Some(session) = self.sessions.remove(&id) {
                if session.child_exited {
                    unsafe { libc::close(session.master) };
                } else {
                    kill_and_reap(session.child, session.master);
                }
            }
            if let Some(copy) = self.host_key_copies.remove(&id) {
                crate::known_hosts::merge_session(&copy);
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

#[cfg(test)]
mod hangup_tests {
    //! A real pty, no child process (a fork in this multi-threaded test binary is
    //! not allowed): the session's slave side is written to and closed, so the
    //! master is hung up with output still queued.
    use super::*;

    /// A manager holding one session on a hung-up pty: `output` is already read
    /// and waiting for outbox room (macOS drops what is unread on a pty when the
    /// slave closes, so it is queued directly), `input` is queued for the dead
    /// terminal.
    fn hung_up_session(output: &[u8], input: &[u8]) -> (SessionManager, u32) {
        let (mut master, mut slave) = (-1, -1);
        let r = unsafe {
            libc::openpty(&mut master, &mut slave, std::ptr::null_mut(), std::ptr::null_mut(), std::ptr::null_mut())
        };
        assert_eq!(r, 0, "openpty failed");
        set_nonblocking(master).unwrap();
        // Raw, so the bytes pass through unchanged.
        unsafe {
            let mut tio: libc::termios = std::mem::zeroed();
            libc::tcgetattr(slave, &mut tio);
            libc::cfmakeraw(&mut tio);
            libc::tcsetattr(slave, libc::TCSANOW, &tio);
            libc::close(slave);
        }
        let mut mgr = SessionManager::with_ids(None, crate::ids::SessionIds::new());
        let id = mgr.ids.next().unwrap();
        mgr.sessions.insert(
            id,
            Session {
                id,
                child: 0,
                master,
                seq: 0,
                pending_out: output.to_vec(),
                pending_in: input.to_vec(),
                owner: "human".to_string(),
                child_exited: false,
                pty_done: false,
                credit: u64::MAX,
                exit_code: None,
                signal: None,
                close_reason: None,
                child_exited_at: None,
                reap_deadline: None,
                kind: "echo".to_string(),
            },
        );
        (mgr, id)
    }

    /// Run the loop's per-session decision for `turns` turns with the outbox FULL
    /// (queued output is not drained). Returns the number of turns that polled.
    fn polled_turns(mgr: &mut SessionManager, id: u32, turns: usize) -> usize {
        let fd = mgr.sessions[&id].master;
        let mut polled = 0;
        for _ in 0..turns {
            let events = mgr.poll_interest(id);
            if events == 0 {
                break;
            }
            let mut pfd = libc::pollfd { fd, events, revents: 0 };
            unsafe { libc::poll(&mut pfd, 1, 0) };
            polled += 1;
            mgr.handle_poll_events(id, pfd.revents);
        }
        polled
    }

    /// K4: input queued for a terminal that hung up must not keep the fd in the
    /// poll set. The output that was still queued is delivered afterwards and the
    /// exit status is still reported.
    #[test]
    fn queued_input_for_a_hung_up_pty_does_not_spin_and_output_is_still_delivered() {
        let (mut mgr, id) = hung_up_session(b"queued-output", &[b'x'; 4096]);
        let polled = polled_turns(&mut mgr, id, 100);
        assert!(polled <= 3, "the helper polled a hung-up pty {polled} times in 100 turns");
        assert!(!mgr.wants_write(id));
        assert!(mgr.sessions[&id].pty_done, "the hang-up must have been seen");
        // The outbox now has room: the queued output comes out, then the exit.
        let (_, data) = mgr.take_pending_output_chunk(id).expect("queued output");
        assert_eq!(data, b"queued-output");
        let s = mgr.sessions.get_mut(&id).unwrap();
        s.child_exited = true;
        s.exit_code = Some(7);
        s.close_reason = Some("exited".to_string());
        let closed = mgr.remove_finished(false);
        assert_eq!(closed.len(), 1);
        assert_eq!((closed[0].0, closed[0].1, closed[0].2), (id, Some(7), None));
    }

    /// K4: once the child has exited, input queued for it is not polled for either
    /// (its pty may stay open for a while through a lingering descendant: POLLOUT
    /// would be ready at once, and nothing is written after the exit).
    #[test]
    fn input_queued_for_an_exited_child_is_not_polled_for() {
        let (mut mgr, id) = hung_up_session(b"", b"typed");
        mgr.sessions.get_mut(&id).unwrap().child_exited = true;
        assert!(!mgr.wants_write(id));
        assert_eq!(mgr.poll_interest(id) & libc::POLLOUT, 0);
    }
}
