//! The stdio event loop: polls stdin, stdout, the signal pipe and every session
//! PTY, dispatches control requests, streams PTY output back as binary frames,
//! and tears every child down on stdin EOF or SIGTERM. All fds are non-blocking;
//! nothing here can block shutdown, and every buffer is bounded.

use std::collections::VecDeque;
use std::io;
use std::os::fd::RawFd;
use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};

use crate::protocol::{
    self, Request, Response, FRAME_KIND_CONTROL, FRAME_KIND_STREAM, MAX_FRAME_BODY_BYTES,
    PROTOCOL_VERSION, STREAM_HEADER_BYTES,
};
use crate::pve::manager::PveManager;
use crate::rdp::manager::{DecisionRefusal, EnqueueError, PinTarget, RdpFrame, RdpManager};
use crate::rdp::protocol::{EngineCommand, EngineEvent, UpdateHeader};
use crate::sessions::{SessionError, SessionManager, SpawnSpec, READ_CHUNK};
use std::collections::HashMap;
use std::ffi::CString;

/// Bounded stdout write buffer. The loop stops draining PTY output and stops
/// reading stdin while it is full (backpressure) instead of buffering without
/// limit.
const OUTBOX_CAP: usize = 4 * 1024 * 1024;
/// Headroom reserved so a single control response (e.g. a close's drained
/// tail) always fits without crossing OUTBOX_CAP.
const OUTBOX_RESERVE: usize = 512 * 1024;
/// Bounded ingress buffer for stdin frames not yet dispatched.
const INGRESS_CAP: usize = MAX_FRAME_BODY_BYTES + 4;
/// Outbox room required before an RDP engine fd is read: one update frame
/// (<= 1 MiB) plus slack for its relayed events.
const RDP_RESERVE: usize = 1024 * 1024 + 256 * 1024;
/// Outbox room a PVE engine read needs: a turn takes at most 16 frames of 16 KiB console bytes.
const PVE_RESERVE: usize = 512 * 1024;

static SIGNAL_WRITE_FD: AtomicI32 = AtomicI32::new(-1);
static SHUTDOWN: AtomicBool = AtomicBool::new(false);

const SIG_BYTE_SHUTDOWN: u8 = b'S';
const SIG_BYTE_CHILD: u8 = b'C';

extern "C" fn on_shutdown_signal(_sig: libc::c_int) {
    let fd = SIGNAL_WRITE_FD.load(Ordering::Relaxed);
    if fd >= 0 {
        let byte = [SIG_BYTE_SHUTDOWN];
        unsafe { libc::write(fd, byte.as_ptr() as *const libc::c_void, 1) };
    }
}

extern "C" fn on_sigchld(_sig: libc::c_int) {
    let fd = SIGNAL_WRITE_FD.load(Ordering::Relaxed);
    if fd >= 0 {
        let byte = [SIG_BYTE_CHILD];
        unsafe { libc::write(fd, byte.as_ptr() as *const libc::c_void, 1) };
    }
}

fn install_handler(sig: libc::c_int, handler: extern "C" fn(libc::c_int)) {
    unsafe {
        let mut sa: libc::sigaction = std::mem::zeroed();
        sa.sa_sigaction = handler as usize;
        libc::sigemptyset(&mut sa.sa_mask);
        sa.sa_flags = 0;
        libc::sigaction(sig, &sa, std::ptr::null_mut());
    }
}

/// Makes `fd` non-blocking. False when the flags could not be read or set: a caller that
/// relies on never blocking must not go on.
fn set_nonblocking(fd: RawFd) -> bool {
    unsafe {
        let flags = libc::fcntl(fd, libc::F_GETFL);
        flags >= 0 && libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) >= 0
    }
}

fn last_errno() -> i32 {
    std::io::Error::last_os_error().raw_os_error().unwrap_or(0)
}

fn set_cloexec(fd: RawFd) {
    unsafe {
        let flags = libc::fcntl(fd, libc::F_GETFD);
        libc::fcntl(fd, libc::F_SETFD, flags | libc::FD_CLOEXEC);
    }
}

fn make_pipe() -> (RawFd, RawFd) {
    let mut fds = [0 as RawFd; 2];
    let r = unsafe { libc::pipe(fds.as_mut_ptr()) };
    assert_eq!(r, 0, "pipe failed");
    set_nonblocking(fds[0]);
    set_nonblocking(fds[1]);
    set_cloexec(fds[0]);
    set_cloexec(fds[1]);
    (fds[0], fds[1])
}

fn platform_string() -> String {
    if cfg!(target_os = "macos") {
        format!("{}-apple-darwin", std::env::consts::ARCH)
    } else {
        format!("{}-{}", std::env::consts::ARCH, std::env::consts::OS)
    }
}

/// A 128-bit value (hex string) that differs across helper starts, so the
/// client can tell a restarted helper from the one it was talking to.
fn random_generation() -> String {
    let mut bytes = [0u8; 16];
    let fd = unsafe { libc::open(c"/dev/urandom".as_ptr(), libc::O_RDONLY) };
    if fd >= 0 {
        let mut got = 0usize;
        while got < 16 {
            let n = unsafe {
                libc::read(fd, bytes[got..].as_mut_ptr() as *mut libc::c_void, 16 - got)
            };
            if n <= 0 {
                break;
            }
            got += n as usize;
        }
        unsafe { libc::close(fd) };
        if got == 16 {
            return bytes.iter().map(|b| format!("{b:02x}")).collect();
        }
    }
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0) as u128;
    let value = nanos ^ ((std::process::id() as u128) << 64);
    format!("{value:032x}")
}

fn request_id(req: &Request) -> Option<u64> {
    match req {
        Request::Hello { .. } => None,
        Request::Ping { id }
        | Request::OpenEcho { id, .. }
        | Request::OpenSsh { id, .. }
        | Request::ExecRun { id, .. }
        | Request::ExecRead { id, .. }
        | Request::ExecCancel { id, .. }
        | Request::ExecForget { id, .. }
        | Request::SshPromptAnswer { id, .. }
        | Request::OpenRdp { id, .. }
        | Request::OpenPve { id, .. }
        | Request::PveTargets { id, .. }
        | Request::PveVncInput { id, .. }
        | Request::PveProvision { id, .. }
        | Request::CredentialSave { id, .. }
        | Request::CredentialDelete { id, .. }
        | Request::CredentialStatus { id, .. }
        | Request::KnownHostsList { id }
        | Request::KnownHostsAdd { id, .. }
        | Request::KnownHostsRemove { id, .. }
        | Request::RdpCertDecision { id, .. }
        | Request::RdpInput { id, .. }
        | Request::RdpScreenshot { id, .. }
        | Request::RdpUpdateAck { id, .. }
        | Request::RdpRefresh { id, .. }
        | Request::SessionInput { id, .. }
        | Request::SessionSetOwner { id, .. }
        | Request::SessionResize { id, .. }
        | Request::SessionCredit { id, .. }
        | Request::SessionClose { id, .. } => Some(*id),
    }
}

use crate::keychain::valid_credential_ref;

pub(crate) enum CredentialRefusal {
    BadRef,
    /// The saved credential is for somewhere else than where this request would send it.
    Mismatch,
    Keychain(String),
}

impl CredentialRefusal {
    pub(crate) fn code(&self) -> String {
        match self {
            CredentialRefusal::BadRef => "invalid_credential_ref".to_string(),
            CredentialRefusal::Mismatch => "credential_target_mismatch".to_string(),
            CredentialRefusal::Keychain(code) => code.clone(),
        }
    }

    pub(crate) fn into_response(self, id: u64) -> Response {
        let code = self.code();
        let message = match &self {
            CredentialRefusal::BadRef => "not a Remote Hub credential reference",
            CredentialRefusal::Mismatch => "this saved credential was saved for a different host, port, user or key",
            CredentialRefusal::Keychain(code) => match code.as_str() {
                "keychain_locked" => crate::keychain::KeychainError::Locked.message(),
                "keychain_denied" => crate::keychain::KeychainError::Denied.message(),
                "credential_missing" => crate::keychain::KeychainError::Missing.message(),
                "credential_unbound" => crate::keychain::KeychainError::Unbound.message(),
                _ => crate::keychain::KeychainError::Unavailable.message(),
            },
        };
        Response::Error { id: Some(id), code, message: message.to_string() }
    }
}

/// How long a keychain child may take, in total (write, read and exit). A locked keychain
/// answers at once (prompts are off).
const KEYCHAIN_CHILD_TIMEOUT_MS: u64 = 5_000;

fn keychain_child_timeout() -> std::time::Duration {
    #[cfg(feature = "test-hooks")]
    if let Some(ms) = std::env::var("REMOTE_HUB_KEYCHAIN_CHILD_TIMEOUT_MS").ok().and_then(|v| v.parse::<u64>().ok()) {
        return std::time::Duration::from_millis(ms);
    }
    std::time::Duration::from_millis(KEYCHAIN_CHILD_TIMEOUT_MS)
}

/// Waits until `fd` is readable (or hung up) or the deadline passes. A signal (SIGCHLD from any
/// other child of this helper) interrupts poll: that is not a timeout, so the wait resumes with
/// the time that is left.
fn wait_readable(fd: RawFd, deadline: std::time::Instant) -> bool {
    wait_fd(fd, libc::POLLIN | libc::POLLHUP, deadline)
}

/// Waits until `fd` can take a write (or is hung up) or the deadline passes.
fn wait_writable(fd: RawFd, deadline: std::time::Instant) -> bool {
    wait_fd(fd, libc::POLLOUT | libc::POLLHUP, deadline)
}

fn wait_fd(fd: RawFd, events: libc::c_short, deadline: std::time::Instant) -> bool {
    loop {
        let now = std::time::Instant::now();
        if now >= deadline {
            return false;
        }
        let remaining_ms = (deadline - now).as_millis().min(i32::MAX as u128) as libc::c_int;
        let mut pfd = libc::pollfd { fd, events, revents: 0 };
        let r = unsafe { libc::poll(&mut pfd, 1, remaining_ms.max(1)) };
        if r > 0 {
            return true;
        }
        if r < 0 && io::Error::last_os_error().kind() == io::ErrorKind::Interrupted {
            continue;
        }
        if r == 0 {
            // poll reported a timeout; the loop re-checks the deadline.
            continue;
        }
        return false;
    }
}

/// Kills and reaps a keychain child. Every failure path ends here, so none is left behind.
fn end_keychain_child(mut child: std::process::Child) {
    let _ = child.kill();
    let _ = child.wait();
}

/// Runs one Keychain operation in a `--keychain-op` child (the helper itself must stay
/// single-threaded; see keychain.rs). The secret goes over the child's stdin pipe. One deadline
/// covers writing, reading and the child's exit; the child is killed and reaped on every
/// failure, and its exit status must be success.
pub(crate) fn keychain_child(
    current_exe: &str,
    op: &str,
    reference: &str,
    secret: Option<&crate::secret::Secret>,
    bind: Option<&crate::binding::Bind>,
) -> Result<crate::keychain::OpReply, CredentialRefusal> {
    use std::io::{Read, Write};
    use std::os::fd::AsRawFd;
    use std::process::{Command, Stdio};
    if !valid_credential_ref(reference) {
        return Err(CredentialRefusal::BadRef);
    }
    let unavailable = || CredentialRefusal::Keychain("keychain_unavailable".to_string());
    // Never a PATH lookup: the child is this very binary, by an absolute path.
    if !std::path::Path::new(current_exe).is_absolute() {
        return Err(unavailable());
    }
    let request = crate::keychain::OpRequest { op: op.to_string(), reference: reference.to_string(), secret: secret.cloned(), bind: bind.cloned() };
    let text = serde_json::to_string(&request).map_err(|_| unavailable())?;
    let deadline = std::time::Instant::now() + keychain_child_timeout();
    let mut child = Command::new(current_exe)
        .arg("--keychain-op")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| unavailable())?;
    let (Some(mut stdin), Some(mut stdout)) = (child.stdin.take(), child.stdout.take()) else {
        end_keychain_child(child);
        return Err(unavailable());
    };
    // Neither pipe may block the helper: both are non-blocking and waited on with the deadline.
    if !set_nonblocking(stdin.as_raw_fd()) || !set_nonblocking(stdout.as_raw_fd()) {
        end_keychain_child(child);
        return Err(unavailable());
    }
    // The request goes in under the same deadline: a partial write continues where it stopped, a full
    // pipe waits for room, and a child that never reads is killed when the time is up.
    let bytes = text.as_bytes();
    let mut written = 0;
    while written < bytes.len() {
        match stdin.write(&bytes[written..]) {
            Ok(0) => {
                end_keychain_child(child);
                return Err(unavailable());
            }
            Ok(n) => written += n,
            Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
            Err(e) if e.kind() == io::ErrorKind::WouldBlock => {
                if !wait_writable(stdin.as_raw_fd(), deadline) {
                    end_keychain_child(child);
                    return Err(unavailable());
                }
            }
            Err(_) => {
                end_keychain_child(child);
                return Err(unavailable());
            }
        }
    }
    drop(stdin); // EOF: the child reads one request
    let mut body: Vec<u8> = Vec::new();
    let mut chunk = [0u8; 4096];
    loop {
        if !wait_readable(stdout.as_raw_fd(), deadline) {
            end_keychain_child(child);
            return Err(unavailable());
        }
        match stdout.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => {
                body.extend_from_slice(&chunk[..n]);
                if body.len() > 64 * 1024 {
                    end_keychain_child(child);
                    return Err(unavailable());
                }
            }
            Err(e) if e.kind() == io::ErrorKind::WouldBlock || e.kind() == io::ErrorKind::Interrupted => continue,
            Err(_) => {
                end_keychain_child(child);
                return Err(unavailable());
            }
        }
    }
    // EOF on stdout: the child is exiting. Its status is part of the answer.
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                if !status.success() {
                    return Err(unavailable());
                }
                break;
            }
            Ok(None) if std::time::Instant::now() < deadline => std::thread::sleep(std::time::Duration::from_millis(2)),
            _ => {
                end_keychain_child(child);
                return Err(unavailable());
            }
        }
    }
    serde_json::from_slice::<crate::keychain::OpReply>(&body).map_err(|_| unavailable())
}

pub(crate) fn keychain_ok(reply: crate::keychain::OpReply) -> Result<crate::keychain::OpReply, CredentialRefusal> {
    match reply.error {
        Some(code) => Err(CredentialRefusal::Keychain(code)),
        None => Ok(reply),
    }
}

/// The saved secret and what it is for.
pub(crate) fn resolve_item(current_exe: &str, reference: &str) -> Result<crate::keychain::Item, CredentialRefusal> {
    let reply = keychain_ok(keychain_child(current_exe, "get", reference, None, None)?)?;
    match (reply.secret, reply.bind) {
        (Some(secret), Some(bind)) => Ok(crate::keychain::Item { bind, secret }),
        _ => Err(CredentialRefusal::Keychain("keychain_unavailable".to_string())),
    }
}

/// The saved password for an RDP endpoint: handed over only when it was saved for exactly this
/// host, port, user and domain. The check is the helper's own; the page's is an extra.
fn resolve_rdp_credential(
    current_exe: &str,
    reference: &str,
    host: &str,
    port: u16,
    user: &str,
    domain: Option<&str>,
) -> Result<(crate::secret::Secret, Option<String>), CredentialRefusal> {
    let item = resolve_item(current_exe, reference)?;
    if item.bind.is_rdp_endpoint(host, port, user, domain) {
        let pin = item.bind.pin().map(str::to_string);
        Ok((item.secret, pin))
    } else {
        Err(CredentialRefusal::Mismatch)
    }
}

/// What an askpass session is going to do, from its own argv; with test-hooks a free-form program
/// (a fake ssh) may state it instead.
fn askpass_session_facts(program: &str, argv: &[String], spec: &protocol::AskpassSpec) -> Result<crate::ssh_args::SshFacts, String> {
    if program == "/usr/bin/ssh" {
        return crate::ssh_args::askpass_facts(argv);
    }
    #[cfg(feature = "test-hooks")]
    if let Some(facts) = &spec.test_facts {
        return Ok(facts.clone());
    }
    let _ = spec;
    Err(crate::ssh_args::ssh_option_rejected())
}

/// The binding a saved secret must carry to be used by a session that does `facts`.
fn required_bind(facts: &crate::ssh_args::SshFacts) -> crate::binding::Bind {
    use crate::ssh_args::AuthMethod;
    match facts.method {
        AuthMethod::Password => crate::binding::Bind::Endpoint {
            protocol: "ssh".to_string(),
            host: facts.host.clone(),
            port: facts.port,
            user: facts.user.clone(),
            domain: None,
            cert: None,
        },
        AuthMethod::PublicKey => crate::binding::Bind::Key { path: facts.identity.clone().unwrap_or_default() },
    }
}

fn known_hosts_error(id: u64, error: crate::known_hosts::KnownHostsError) -> Response {
    let (code, message) = match error {
        crate::known_hosts::KnownHostsError::Unsafe => ("known_hosts_refused", "the known hosts file or the lines are not acceptable"),
        crate::known_hosts::KnownHostsError::Io => ("known_hosts_unavailable", "the known hosts file could not be read or written"),
    };
    Response::Error { id: Some(id), code: code.to_string(), message: message.to_string() }
}

/// Validate and build a SpawnSpec from a client-provided session.open_ssh.
fn build_spawn_spec(
    program: String,
    argv: Vec<String>,
    env: HashMap<String, String>,
    cwd: Option<String>,
) -> Result<SpawnSpec, String> {
    if !program.starts_with('/') {
        return Err("program must be an absolute path".to_string());
    }
    let program = CString::new(program).map_err(|_| "program has a NUL byte".to_string())?;
    let mut argv_c = Vec::with_capacity(argv.len());
    for a in &argv {
        argv_c.push(CString::new(a.as_str()).map_err(|_| "argv has a NUL byte".to_string())?);
    }
    let mut env_c = Vec::with_capacity(env.len());
    for (k, v) in &env {
        env_c.push((
            CString::new(k.as_str()).map_err(|_| "env key has a NUL byte".to_string())?,
            CString::new(v.as_str()).map_err(|_| "env value has a NUL byte".to_string())?,
        ));
    }
    let cwd = match cwd {
        Some(c) => Some(CString::new(c).map_err(|_| "cwd has a NUL byte".to_string())?),
        None => None,
    };
    Ok(SpawnSpec {
        program,
        argv: argv_c,
        env: env_c,
        cwd,
        allow_fds: Vec::new(),
    })
}

/// Runs one control request. Returns encoded frames to queue, or a fatal
/// (code, message) that stops the helper.
fn handle(
    manager: &mut SessionManager,
    rdp: &mut RdpManager,
    pve: &mut PveManager,
    current_exe: &str,
    handshaken: &mut bool,
    generation: &str,
    req: Request,
) -> Result<Vec<u8>, (String, String)> {
    if !*handshaken && !matches!(req, Request::Hello { .. }) {
        return Ok(protocol::encode_response(&Response::Error {
            id: request_id(&req),
            code: "handshake_required".to_string(),
            message: "send hello before any other request".to_string(),
        }));
    }
    match req {
        Request::Hello { protocol } => {
            if protocol != PROTOCOL_VERSION {
                return Err((
                    "version_mismatch".to_string(),
                    format!(
                        "unsupported protocol version {protocol}; this helper speaks {PROTOCOL_VERSION}"
                    ),
                ));
            }
            *handshaken = true;
            Ok(protocol::encode_response(&Response::HelloAck {
                protocol: PROTOCOL_VERSION,
                helper_version: env!("CARGO_PKG_VERSION").to_string(),
                platform: platform_string(),
                pid: std::process::id(),
                generation: generation.to_string(),
            }))
        }
        Request::Ping { id } => Ok(protocol::encode_response(&Response::Pong { id })),
        Request::ExecRun { id, program, argv, env, askpass, timeout_ms, max_bytes } => {
            let real = program == "/usr/bin/ssh";
            // The shape: `ssh -T <the same options as a session> -- host <ONE command word>`. In a build with test-hooks a
            // free-form program (a fake ssh) is run as given.
            let plain = if real {
                match crate::ssh_args::split_exec_argv(&argv).and_then(|(plain, _)| crate::ssh_args::validate_ssh_spawn(&program, &plain, &env).map(|()| plain)) {
                    Ok(plain) => plain,
                    Err(_) => return Ok(rdp_error(id, "ssh_option_rejected", "exec.run carries a disallowed program, option or command".to_string())),
                }
            } else if cfg!(feature = "test-hooks") {
                argv.clone()
            } else {
                return Ok(rdp_error(id, "ssh_option_rejected", "exec.run carries a disallowed program, option or command".to_string()));
            };
            if real && askpass.is_none() {
                return Ok(rdp_error(id, "needs_saved_credential", "a remote command needs a saved credential: no question can be answered".to_string()));
            }
            if !(1_000..=600_000).contains(&timeout_ms) || !(1_024..=4 * 1024 * 1024).contains(&max_bytes) {
                return Ok(rdp_error(id, "exec_limits_rejected", "timeout or output bound out of range".to_string()));
            }
            let mut argv = argv;
            let mut askpass_plan: Option<(String, crate::binding::Bind, String)> = None;
            if let Some(spec) = &askpass {
                if !valid_credential_ref(&spec.credential_ref) {
                    return Ok(rdp_error(id, "invalid_credential_ref", "not a Remote Hub credential reference".to_string()));
                }
                let Ok(facts) = askpass_session_facts(&program, &plain, spec) else {
                    return Ok(rdp_error(id, "ssh_option_rejected", "a run with a saved secret needs -F none, one fixed method and its user or key".to_string()));
                };
                let bound = match keychain_child(current_exe, "bind", &spec.credential_ref, None, None).and_then(keychain_ok) {
                    Ok(reply) => reply.bind,
                    Err(refusal) => return Ok(protocol::encode_response(&refusal.into_response(id))),
                };
                let required = required_bind(&facts);
                if bound.as_ref() != Some(&required) {
                    return Ok(protocol::encode_response(&CredentialRefusal::Mismatch.into_response(id)));
                }
                askpass_plan = Some((spec.credential_ref.clone(), required, facts.expected_prompt()));
            }
            // Host keys: only a key the owner already confirmed counts. An unknown host is never decided by a run.
            let mut copy: Option<crate::known_hosts::SessionCopy> = None;
            if (real || crate::known_hosts::test_overlay_configured()) && !plain.iter().any(|a| a.starts_with("UserKnownHostsFile=")) {
                let lines = crate::known_hosts::read_lines().unwrap_or_default();
                let facts = crate::ssh_args::askpass_facts(&plain);
                let known = match &facts {
                    Ok(f) => crate::known_hosts::knows_endpoint(&lines, &f.host, f.port),
                    Err(_) => false,
                };
                if real && !known {
                    return Ok(rdp_error(id, "host_key_unknown", "this server's host key has not been confirmed by the owner yet".to_string()));
                }
                if real {
                    match crate::known_hosts::session_copy().and_then(|c| crate::known_hosts::ssh_known_hosts_option(&c.path).map(|o| (c, o))) {
                        Ok((c, option)) => {
                            let at = argv.len().saturating_sub(3); // before the "--" that precedes the host and the command
                            argv.splice(at..at, exec_known_hosts_options(&option));
                            copy = Some(c);
                        }
                        Err(e) => return Ok(protocol::encode_response(&known_hosts_error(id, e))),
                    }
                }
            }
            let spec = crate::exec::ExecSpec { program, argv, env: env.into_iter().collect(), timeout: std::time::Duration::from_millis(timeout_ms), max_bytes };
            match manager.exec_start(spec, askpass_plan, current_exe, copy) {
                Ok(exec_id) => Ok(protocol::encode_response(&Response::ExecStarted { id, exec_id })),
                Err(crate::exec::ExecError::TooMany) => Ok(rdp_error(id, "too_many_runs", "too many remote commands are running".to_string())),
                Err(crate::exec::ExecError::Spawn(_)) => Ok(rdp_error(id, "exec_spawn_failed", "the command could not be started".to_string())),
            }
        }
        Request::ExecRead { id, exec_id, stdout_from, stderr_from, max } => Ok(match manager.exec.read(exec_id, stdout_from, stderr_from, max.min(1 << 20)) {
            Some(snap) => exec_state(id, exec_id, snap),
            None => rdp_error(id, "unknown_exec", format!("no run {exec_id}")),
        }),
        Request::ExecCancel { id, exec_id } => Ok(if manager.exec.cancel(exec_id) {
            match manager.exec.read(exec_id, u64::MAX, u64::MAX, 0) {
                Some(snap) => exec_state(id, exec_id, snap),
                None => rdp_error(id, "unknown_exec", format!("no run {exec_id}")),
            }
        } else if manager.exec.contains(exec_id) {
            match manager.exec.read(exec_id, u64::MAX, u64::MAX, 0) {
                Some(snap) => exec_state(id, exec_id, snap),
                None => rdp_error(id, "unknown_exec", format!("no run {exec_id}")),
            }
        } else {
            rdp_error(id, "unknown_exec", format!("no run {exec_id}"))
        }),
        Request::ExecForget { id, exec_id } => Ok(if manager.exec.forget(exec_id) { protocol::encode_response(&Response::ExecForgotten { id }) } else { rdp_error(id, "unknown_exec", format!("no finished run {exec_id}")) }),
        Request::OpenEcho { id, cols, rows } => match manager.open_echo(cols, rows) {
            Ok(session_id) => {
                let pid = manager.child_pid(session_id).unwrap_or(0);
                Ok(protocol::encode_response(&Response::SessionOpened {
                    id,
                    session_id,
                    cols,
                    rows,
                    pid: pid as u32,
                    kind: "echo".to_string(),
                }))
            }
            Err(e) => Ok(protocol::encode_response(&Response::Error {
                id: Some(id),
                code: "session_open_failed".to_string(),
                message: e.to_string(),
            })),
        },
        Request::OpenSsh {
            id,
            cols,
            rows,
            program,
            mut argv,
            env,
            cwd,
            askpass,
        } => {
            // Production only: the ssh kind may only run the strict OpenSSH
            // shape built by src/core/ssh-args.ts. Free-form programs remain
            // reachable with test-hooks (the feature gate compiles this check
            // away), where the Rust tests exercise them.
            #[cfg(not(feature = "test-hooks"))]
            if cwd.is_some()
                || crate::ssh_args::validate_ssh_spawn(&program, &argv, &env).is_err()
            {
                return Ok(protocol::encode_response(&Response::Error {
                    id: Some(id),
                    code: "ssh_option_rejected".to_string(),
                    message: "session.open_ssh carries a disallowed program, option, cwd or env".to_string(),
                }));
            }
            // A session that may use a saved secret: its argv must say where the secret goes and how
            // (S4), and the secret must be bound to exactly that (S2). Both are the helper's own checks.
            let mut askpass_plan: Option<(crate::binding::Bind, String)> = None;
            let mut host_key_copy: Option<crate::known_hosts::SessionCopy> = None;
            let mut first_use_endpoint: Option<String> = None;
            if let Some(spec) = &askpass {
                if !valid_credential_ref(&spec.credential_ref) {
                    return Ok(protocol::encode_response(&Response::Error {
                        id: Some(id),
                        code: "invalid_credential_ref".to_string(),
                        message: "not a Remote Hub credential reference".to_string(),
                    }));
                }
                let Ok(facts) = askpass_session_facts(&program, &argv, spec) else {
                    return Ok(protocol::encode_response(&Response::Error {
                        id: Some(id),
                        code: "ssh_option_rejected".to_string(),
                        message: "a session with a saved secret needs -F none, one fixed method and its user or key".to_string(),
                    }));
                };
                let bound = match keychain_child(current_exe, "bind", &spec.credential_ref, None, None).and_then(keychain_ok) {
                    Ok(reply) => reply.bind,
                    Err(refusal) => return Ok(protocol::encode_response(&refusal.into_response(id))),
                };
                let required = required_bind(&facts);
                if bound.as_ref() != Some(&required) {
                    return Ok(protocol::encode_response(&CredentialRefusal::Mismatch.into_response(id)));
                }
                askpass_plan = Some((required, facts.expected_prompt()));
                // Host keys come from the helper's overlay and nowhere else: ssh gets a PRIVATE COPY of it (so it
                // is never a second writer; the helper merges what the user confirmed when the session ends),
                // named as ONE quoted file, with every trust option stated: no global known_hosts, the question
                // asked for an unknown key, a refusal for a changed one, no host-key updates or DNS trust.
                // First use of a host:port (no key in the overlay yet): one session at a time decides it.
                // (A caller that names its own UserKnownHostsFile decides keys itself; there is nothing to serialise.)
                if (program == "/usr/bin/ssh" || crate::known_hosts::test_overlay_configured()) && !argv.iter().any(|a| a.starts_with("UserKnownHostsFile=")) {
                    let lines = crate::known_hosts::read_lines().unwrap_or_default();
                    if !crate::known_hosts::knows_endpoint(&lines, &facts.host, facts.port) {
                        let endpoint = format!("{}:{}", facts.host.to_ascii_lowercase(), facts.port);
                        if manager.endpoint_pending(&endpoint) {
                            return Ok(protocol::encode_response(&Response::Error {
                                id: Some(id),
                                code: "host_key_confirmation_pending".to_string(),
                                message: "another session to this server is waiting for a host key decision; try again when it is done".to_string(),
                            }));
                        }
                        first_use_endpoint = Some(endpoint);
                    }
                }
                if program == "/usr/bin/ssh" && !argv.iter().any(|a| a.starts_with("UserKnownHostsFile=")) {
                    let opened = crate::known_hosts::session_copy().and_then(|copy| crate::known_hosts::ssh_known_hosts_option(&copy.path).map(|option| (copy, option)));
                    match opened {
                        Ok((copy, option)) => {
                            let at = argv.len().saturating_sub(2); // before the "--" that precedes the destination
                            let mut options = Vec::new();
                            for o in [
                                option.as_str(),
                                "GlobalKnownHostsFile=none",
                                "StrictHostKeyChecking=ask",
                                "UpdateHostKeys=no",
                                "CheckHostIP=no",
                                "HashKnownHosts=no",
                                "VerifyHostKeyDNS=no",
                            ] {
                                options.push("-o".to_string());
                                options.push(o.to_string());
                            }
                            argv.splice(at..at, options);
                            host_key_copy = Some(copy);
                        }
                        Err(e) => return Ok(protocol::encode_response(&known_hosts_error(id, e))),
                    }
                }
            }
            let spec = build_spawn_spec(program, argv, env, cwd);
            match spec {
                Ok(spec) => match match &askpass {
                    Some(a) => {
                        let (bind, expected) = askpass_plan.take().expect("planned above");
                        manager.open_ssh_with_askpass(spec, cols, rows, &a.credential_ref, bind, &expected, current_exe)
                    }
                    None => manager.open_ssh(spec, cols, rows),
                } {
                    Ok(session_id) => {
                        if let Some(copy) = host_key_copy.take() {
                            manager.set_host_key_copy(session_id, copy);
                        }
                        if let Some(endpoint) = first_use_endpoint.take() {
                            manager.hold_endpoint(session_id, endpoint);
                        }
                        let pid = manager.child_pid(session_id).unwrap_or(0);
                        Ok(protocol::encode_response(&Response::SessionOpened {
                            id,
                            session_id,
                            cols,
                            rows,
                            pid: pid as u32,
                            kind: "ssh".to_string(),
                        }))
                    }
                    Err(e) => {
                        if let Some(copy) = host_key_copy.take() {
                            let _ = std::fs::remove_file(&copy.path);
                        }
                        Ok(protocol::encode_response(&Response::Error {
                        id: Some(id),
                        code: "session_open_failed".to_string(),
                        message: e.to_string(),
                    }))
                    }
                },
                Err(msg) => {
                    if let Some(copy) = host_key_copy.take() {
                        let _ = std::fs::remove_file(&copy.path);
                    }
                    Ok(protocol::encode_response(&Response::Error {
                    id: Some(id),
                    code: "spawn_spec_invalid".to_string(),
                    message: msg,
                }))
                }
            }
        }
        Request::SessionSetOwner { id, session_id, owner } => {
            if pve.contains(session_id) {
                // A console has one writer at a time only in the sense of the control lease above it.
                return Ok(protocol::encode_response(&Response::SessionOwnerSet { id, session_id, dropped: 0, released: 0 }));
            }
            if manager.contains(session_id) {
                return Ok(match manager.set_owner(session_id, &owner) {
                    Ok(dropped) => protocol::encode_response(&Response::SessionOwnerSet { id, session_id, dropped: dropped as u64, released: 0 }),
                    Err(_) => rdp_error(id, "session_not_found", format!("no session {session_id}")),
                });
            }
            Ok(match rdp.set_owner(session_id, &owner, id) {
                Ok(crate::rdp::manager::OwnerHandoff::Done { dropped }) => protocol::encode_response(&Response::SessionOwnerSet { id, session_id, dropped, released: 0 }),
                // The engine answers when it has released what it applied; the reply is sent then (the barrier).
                Ok(crate::rdp::manager::OwnerHandoff::Waiting) => Vec::new(),
                Err(e) => rdp_enqueue_error(id, session_id, e),
            })
        }
        Request::SessionInput { id, session_id, data, .. } if pve.contains(session_id) => Ok(match pve.enqueue_input(session_id, data.as_bytes()) {
            Ok(()) => protocol::encode_response(&Response::SessionInputAck { id, session_id }),
            Err(e) => crate::pve::glue::enqueue_error(id, session_id, e),
        }),
        Request::SessionResize { id, session_id, cols, rows } if pve.contains(session_id) => Ok(match pve.resize(session_id, cols, rows) {
            Ok(()) => protocol::encode_response(&Response::SessionResized { id, session_id, cols, rows }),
            Err(e) => crate::pve::glue::enqueue_error(id, session_id, e),
        }),
        // Console bytes are bounded by the outbox room, not by per-session credit: the grant is acknowledged and unused.
        Request::SessionCredit { id, session_id, .. } if pve.contains(session_id) => Ok(protocol::encode_response(&Response::SessionCreditAck { id, session_id })),
        Request::SessionInput {
            id,
            session_id,
            data,
            owner,
        } => match manager.enqueue_input_from(session_id, owner.as_deref().unwrap_or("human"), data.as_bytes()) {
            Ok(()) => Ok(protocol::encode_response(&Response::SessionInputAck { id, session_id })),
            Err(SessionError::InputOverflow) => Ok(protocol::encode_response(&Response::Error {
                id: Some(id),
                code: "input_overflow".to_string(),
                message: "session input exceeds the bounded pending-input window".to_string(),
            })),
            Err(SessionError::StaleOwner) => Ok(protocol::encode_response(&Response::Error {
                id: Some(id),
                code: "stale_owner".to_string(),
                message: "the input is from someone who no longer drives this session".to_string(),
            })),
            Err(_) => Ok(protocol::encode_response(&Response::Error {
                id: Some(id),
                code: "session_not_found".to_string(),
                message: format!("no echo session {session_id}"),
            })),
        },
        Request::SessionResize {
            id,
            session_id,
            cols,
            rows,
        } => match manager.resize(session_id, cols, rows) {
            Ok((applied_cols, applied_rows)) => Ok(protocol::encode_response(&Response::SessionResized {
                id,
                session_id,
                cols: applied_cols,
                rows: applied_rows,
            })),
            Err(_) => Ok(protocol::encode_response(&Response::Error {
                id: Some(id),
                code: "session_not_found".to_string(),
                message: format!("no echo session {session_id}"),
            })),
        },
        Request::SessionCredit {
            id,
            session_id,
            bytes,
        } => {
            if manager.add_credit(session_id, bytes) {
                Ok(protocol::encode_response(&Response::SessionCreditAck { id, session_id }))
            } else {
                Ok(protocol::encode_response(&Response::Error {
                    id: Some(id),
                    code: "session_not_found".to_string(),
                    message: format!("no echo session {session_id}"),
                }))
            }
        }
        Request::SessionClose { id, session_id } => {
            // Ids come from one shared allocator, so an id belongs to exactly
            // one manager.
            if pve.contains(session_id) {
                // The engine closes the console politely; `session.closed` answers this request once it has.
                return Ok(match pve.request_close(session_id, id) {
                    Ok(()) => Vec::new(),
                    Err(e) => crate::pve::glue::enqueue_error(id, session_id, e),
                });
            }
            if rdp.contains(session_id) {
                let pending = rdp.take_pending_screenshots(session_id);
                let reason = rdp.close(session_id).unwrap_or_else(|| "killed_by_close".to_string());
                let mut frames = session_closed_errors(&pending);
                frames.extend(protocol::encode_response(&Response::SessionClosed {
                    id: Some(id),
                    session_id,
                    exit_code: None,
                    signal: None,
                    reason,
                }));
                return Ok(frames);
            }
            handle_pty_close(manager, id, session_id)
        }
        Request::OpenPve { id, connect, target, cols, rows, keepalive_secs } => {
            Ok(crate::pve::glue::open_terminal(pve, current_exe, id, &connect, target, cols, rows, keepalive_secs))
        }
        Request::PveVncInput { id, session_id, data } if pve.is_vnc(session_id) => Ok(crate::pve::glue::vnc_input(pve, id, session_id, &data)),
        Request::PveVncInput { id, session_id, .. } => Ok(crate::pve::glue::enqueue_error(id, session_id, crate::pve::manager::EnqueueError::UnknownSession)),
        Request::PveTargets { id, connect } => Ok(crate::pve::glue::open_targets(pve, current_exe, id, &connect)),
        Request::PveProvision { id, connect, dry_run, acl_path, user_id, replace_role, plan_digest, save } => {
            Ok(crate::pve::glue::open_provision(pve, current_exe, id, &connect, crate::pve::glue::ProvisionRequest { dry_run, acl_path, user_id, replace_role, plan_digest, save }))
        }
        Request::OpenRdp { id, width, height, .. } if !rdp_geometry_ok(width, height) => Ok(rdp_error(
            id,
            "rdp_invalid_geometry",
            format!("the desktop size must be 1..={RDP_MAX_WIDTH} x 1..={RDP_MAX_HEIGHT}"),
        )),
        Request::OpenRdp {
            id,
            host,
            port,
            username,
            password,
            credential_ref,
            domain,
            width,
            height,
            expected_fingerprint,
            options,
        } => {
            let options = options.unwrap_or_default();
            if let Err(why) = options.validate() {
                return Ok(rdp_error(id, "rdp_invalid_options", why.to_string()));
            }
            // The secret comes from exactly one place: the request (use once) or the Keychain.
            // A saved password also brings the certificate it is pinned to (stage 3c-2, T4). With a pin, the
            // engine compares the presented certificate before CredSSP sends anything, so a different
            // certificate never receives the saved password; the pin replaces whatever the caller expects.
            // Without a pin yet (first use) the caller's expectation is not enough: the engine asks the helper
            // to pin-or-compare the certificate it was shown, atomically, and waits for the answer before it
            // authenticates (see `relay_rdp_frames`); a different pin or a failed write ends the session.
            let mut pin_target: Option<PinTarget> = None;
            let mut pin_first_use = false;
            let mut expected_fingerprint = expected_fingerprint;
            let password = match (password, credential_ref) {
                (Some(password), None) => password,
                (None, Some(reference)) => match resolve_rdp_credential(current_exe, &reference, &host, port, &username, domain.as_deref()) {
                    Ok((password, Some(pin))) => {
                        expected_fingerprint = Some(pin);
                        password
                    }
                    Ok((password, None)) => {
                        expected_fingerprint = None;
                        pin_first_use = true;
                        pin_target = Some(PinTarget { reference, host: host.clone(), port, user: username.clone(), domain: domain.clone() });
                        password
                    }
                    Err(refusal) => return Ok(protocol::encode_response(&refusal.into_response(id))),
                },
                _ => {
                    return Ok(protocol::encode_response(&Response::Error {
                        id: Some(id),
                        code: "invalid_credential_source".to_string(),
                        message: "give exactly one of password and credentialRef".to_string(),
                    }))
                }
            };
            match rdp.open(current_exe, host, port, username, password, domain, width, height, expected_fingerprint, pin_first_use, options) {
            Ok((session_id, pid)) => { if let Some(target) = pin_target { rdp.set_pin_target(session_id, target); } Ok(protocol::encode_response(&Response::SessionOpened {
                id,
                session_id,
                cols: 0,
                rows: 0,
                pid: pid as u32,
                kind: "rdp".to_string(),
            })) },
            Err(message) => Ok(protocol::encode_response(&Response::Error {
                id: Some(id),
                code: "rdp_open_failed".to_string(),
                message,
            })),
        }
        }
        Request::CredentialSave { id, reference, secret, bind } => Ok(protocol::encode_response(
            &keychain_child(current_exe, "save", &reference, Some(&secret), Some(&bind))
                .and_then(keychain_ok)
                .map_or_else(|r| r.into_response(id), |_| Response::CredentialOk { id }),
        )),
        Request::CredentialDelete { id, reference } => Ok(protocol::encode_response(
            &keychain_child(current_exe, "delete", &reference, None, None)
                .and_then(keychain_ok)
                .map_or_else(|r| r.into_response(id), |_| Response::CredentialOk { id }),
        )),
        Request::CredentialStatus { id, reference } => Ok(protocol::encode_response(
            &keychain_child(current_exe, "status", &reference, None, None)
                .and_then(keychain_ok)
                .map_or_else(|r| r.into_response(id), |reply| Response::CredentialStatus { id, present: reply.present.unwrap_or(false) }),
        )),
        Request::KnownHostsList { id } => Ok(protocol::encode_response(&match crate::known_hosts::read_lines() {
            Ok(lines) => Response::KnownHostsLines { id, lines },
            Err(e) => known_hosts_error(id, e),
        })),
        Request::KnownHostsAdd { id, lines } => Ok(protocol::encode_response(&match crate::known_hosts::add_lines(&lines) {
            Ok(count) => Response::KnownHostsDone { id, count: count as u32 },
            Err(e) => known_hosts_error(id, e),
        })),
        Request::KnownHostsRemove { id, host } => Ok(protocol::encode_response(&match crate::known_hosts::remove_host(&host) {
            Ok(count) => Response::KnownHostsDone { id, count: count as u32 },
            Err(e) => known_hosts_error(id, e),
        })),
        Request::SshPromptAnswer { id, session_id, prompt_id, answer } => {
            if manager.askpass_answer(session_id, prompt_id, answer) {
                Ok(protocol::encode_response(&Response::SshPromptAck { id }))
            } else {
                Ok(protocol::encode_response(&Response::Error {
                    id: Some(id),
                    code: "no_pending_prompt".to_string(),
                    message: "there is no such open prompt".to_string(),
                }))
            }
        }
        Request::RdpCertDecision { id, session_id, fingerprint, accept } => {
            if let Err(refusal) = rdp.check_decision(session_id, &fingerprint) {
                let (code, message) = match refusal {
                    DecisionRefusal::UnknownSession => ("session_not_found", format!("no rdp session {session_id}")),
                    DecisionRefusal::NoPendingPrompt => {
                        ("no_pending_prompt", "no certificate prompt is pending for this session".to_string())
                    }
                    DecisionRefusal::FingerprintMismatch => (
                        "fingerprint_mismatch",
                        "the decision names a different fingerprint than the pending prompt".to_string(),
                    ),
                };
                return Ok(protocol::encode_response(&Response::Error {
                    id: Some(id),
                    code: code.to_string(),
                    message,
                }));
            }
            rdp_command(rdp, id, session_id, &EngineCommand::CertDecision { fingerprint, accept })
        }
        Request::RdpInput { id, session_id, events, owner } => {
            if let Some(refusal) = rdp_not_ready(rdp, id, session_id) {
                return Ok(refusal);
            }
            Ok(match rdp.enqueue_input(session_id, owner.as_deref().unwrap_or("human"), events) {
                Ok(()) => protocol::encode_response(&Response::RdpAck { id, session_id }),
                Err(e) => rdp_enqueue_error(id, session_id, e),
            })
        }
        Request::RdpUpdateAck { id, session_id, frame_id } => {
            if let Some(refusal) = rdp_not_ready(rdp, id, session_id) {
                return Ok(refusal);
            }
            rdp_command(rdp, id, session_id, &EngineCommand::Ack { frame_id })
        }
        Request::RdpRefresh { id, session_id } => {
            if let Some(refusal) = rdp_not_ready(rdp, id, session_id) {
                return Ok(refusal);
            }
            rdp_command(rdp, id, session_id, &EngineCommand::Refresh)
        }
        Request::RdpScreenshot { id, session_id } => {
            if !rdp.contains(session_id) {
                return Ok(rdp_error(id, "session_not_found", format!("no rdp session {session_id}")));
            }
            if !rdp.is_ready(session_id) {
                return Ok(rdp_error(id, "not_ready", "the desktop is not ready yet".to_string()));
            }
            match rdp.enqueue_command(session_id, &EngineCommand::Screenshot) {
                Ok(()) => {
                    rdp.push_screenshot(session_id, id);
                    // The screenshot response arrives asynchronously from the engine.
                    Ok(Vec::new())
                }
                Err(e) => Ok(rdp_enqueue_error(id, session_id, e)),
            }
        }
    }
}

/// Input and acknowledgements mean something only once a desktop exists. An
/// unknown session keeps its own error; a known one that is not ready is told so.
fn rdp_not_ready(rdp: &RdpManager, id: u64, session_id: u32) -> Option<Vec<u8>> {
    if rdp.contains(session_id) && !rdp.is_ready(session_id) {
        return Some(rdp_error(id, "not_ready", "the desktop is not ready yet".to_string()));
    }
    None
}

/// Largest desktop a session may ask for (the framebuffer's own limit).
const RDP_MAX_WIDTH: u32 = 3840;
const RDP_MAX_HEIGHT: u32 = 2160;

fn rdp_geometry_ok(width: u32, height: u32) -> bool {
    (1..=RDP_MAX_WIDTH).contains(&width) && (1..=RDP_MAX_HEIGHT).contains(&height)
}

/// Every screenshot request still waiting when its session ends is answered
/// with `session_closed`, oldest first.
fn session_closed_errors(pending: &[u64]) -> Vec<u8> {
    let mut frames = Vec::new();
    for req in pending {
        frames.extend(rdp_error(*req, "session_closed", "the rdp session ended before the screenshot".to_string()));
    }
    frames
}

/// ssh options for a remote command's host-key handling: only the owner's confirmed keys (a private copy of the overlay),
/// a refusal for an unknown or changed key, no updates, no DNS trust. Never a question: nobody is there to answer it.
fn exec_known_hosts_options(known_hosts_option: &str) -> Vec<String> {
    let mut options = Vec::new();
    for o in [known_hosts_option, "GlobalKnownHostsFile=none", "StrictHostKeyChecking=yes", "UpdateHostKeys=no", "CheckHostIP=no", "HashKnownHosts=no", "VerifyHostKeyDNS=no", "BatchMode=no"] {
        options.push("-o".to_string());
        options.push(o.to_string());
    }
    options
}

/// The answer to exec.read / exec.cancel: state, exit, both streams as base64 slices.
fn exec_state(id: u64, exec_id: u32, snap: crate::exec::Snapshot) -> Vec<u8> {
    let chunk = |c: crate::exec::Chunk| protocol::ExecChunk { start: c.start, end: c.end, data: crate::exec::base64(&c.data), total: c.total, truncated: c.truncated };
    protocol::encode_response(&Response::ExecState {
        id,
        exec_id,
        running: snap.running,
        exit_code: snap.exit_code,
        signal: snap.signal,
        reason: snap.reason,
        refused: snap.refused,
        elapsed_ms: snap.elapsed_ms,
        stdout: chunk(snap.stdout),
        stderr: chunk(snap.stderr),
    })
}

fn rdp_error(id: u64, code: &str, message: String) -> Vec<u8> {
    protocol::encode_response(&Response::Error { id: Some(id), code: code.to_string(), message })
}

fn rdp_enqueue_error(id: u64, session_id: u32, e: EnqueueError) -> Vec<u8> {
    match e {
        EnqueueError::UnknownSession => rdp_error(id, "session_not_found", format!("no rdp session {session_id}")),
        EnqueueError::Dead => rdp_error(id, "session_closed", "the rdp engine has ended".to_string()),
        EnqueueError::StaleOwner => rdp_error(id, "stale_owner", "the input is from someone who no longer drives this session".to_string()),
        EnqueueError::Full => {
            rdp_error(id, "rdp_input_overflow", "too much pending input for this session; retry".to_string())
        }
        EnqueueError::TooManyScreenshots => {
            rdp_error(id, "screenshot_busy", "too many screenshot requests are outstanding; retry".to_string())
        }
    }
}

/// Queue one command for an engine and answer with `rdp.ack` or the error.
fn rdp_command(
    rdp: &mut RdpManager,
    id: u64,
    session_id: u32,
    cmd: &EngineCommand,
) -> Result<Vec<u8>, (String, String)> {
    match rdp.enqueue_command(session_id, cmd) {
        Ok(()) => Ok(protocol::encode_response(&Response::RdpAck { id, session_id })),
        Err(e) => Ok(rdp_enqueue_error(id, session_id, e)),
    }
}

fn handle_pty_close(manager: &mut SessionManager, id: u64, session_id: u32) -> Result<Vec<u8>, (String, String)> {
    match manager.close(session_id) {
        Some((base_seq, chunks, exit_code, signal, reason)) => {
            let mut out = Vec::new();
            for (i, chunk) in chunks.iter().enumerate() {
                out.extend_from_slice(&protocol::encode_stream(
                    session_id,
                    base_seq.wrapping_add(i as u32),
                    chunk,
                ));
            }
            out.extend_from_slice(&protocol::encode_response(&Response::SessionClosed {
                id: Some(id),
                session_id,
                exit_code,
                signal,
                reason,
            }));
            Ok(out)
        }
        None => Ok(protocol::encode_response(&Response::Error {
            id: Some(id),
            code: "session_not_found".to_string(),
            message: format!("no echo session {session_id}"),
        })),
    }
}

fn relay_rdp_frames(rdp: &mut RdpManager, outbox: &mut VecDeque<u8>, current_exe: &str, rid: u32, frames: Vec<RdpFrame>) {
    for frame in frames {
        match frame {
            RdpFrame::Event(EngineEvent::State { state }) => {
                outbox.extend(protocol::encode_response(&Response::RdpState { session_id: rid, state }));
            }
            RdpFrame::Event(EngineEvent::CertPrompt { host, port, fingerprint, subject, issuer, not_before, not_after, reason, detail, first_use }) => {
                outbox.extend(protocol::encode_response(&Response::RdpCertPrompt {
                    session_id: rid,
                    host,
                    port,
                    fingerprint,
                    subject,
                    issuer,
                    not_before,
                    not_after,
                    reason,
                    detail,
                    first_use,
                }));
            }
            RdpFrame::Event(EngineEvent::PinRequest { fingerprint }) => {
                // One keychain-child call per request, and this loop is single-threaded: of two first uses,
                // the first request writes the pin and the second compares against it. Nothing but
                // "allow" lets the engine authenticate.
                let verdict = match rdp.take_pin_target(rid) {
                    None => "failed",
                    Some(target) => {
                        let bind = crate::binding::Bind::Endpoint {
                            protocol: "rdp".to_string(),
                            host: target.host,
                            port: target.port,
                            user: Some(target.user),
                            domain: target.domain,
                            cert: Some(fingerprint),
                        };
                        match keychain_child(current_exe, "pin", &target.reference, None, Some(&bind)).and_then(keychain_ok) {
                            Ok(reply) => match reply.pin.as_deref() {
                                Some("written") | Some("match") => "allow",
                                Some("mismatch") => "changed",
                                _ => "failed",
                            },
                            Err(_) => "failed",
                        }
                    }
                };
                rdp.answer_pin(rid, verdict);
            }
            RdpFrame::Event(EngineEvent::Certificate { fingerprint, validated }) => {
                outbox.extend(protocol::encode_response(&Response::RdpCertificate {
                    session_id: rid,
                    fingerprint,
                    validated,
                }));
            }
            RdpFrame::Event(EngineEvent::Desktop { frame_id, width, height, timestamp }) => {
                outbox.extend(protocol::encode_response(&Response::RdpDesktop {
                    session_id: rid,
                    frame_id,
                    width,
                    height,
                    timestamp,
                }));
            }
            RdpFrame::Event(EngineEvent::Screenshot { frame_id, width, height, timestamp, png }) => {
                // Answers are FIFO per session: the engine answers each
                // screenshot request exactly once, in order.
                // An answer nobody asked for is dropped: there is no request id 0.
                let Some(req_id) = rdp.pop_screenshot(rid) else { continue };
                outbox.extend(protocol::encode_response(&Response::RdpScreenshot {
                    id: req_id,
                    session_id: rid,
                    frame_id,
                    width,
                    height,
                    timestamp,
                    png,
                    chunks: None,
                }));
            }
            RdpFrame::Event(EngineEvent::ScreenshotError { code }) => {
                let Some(req_id) = rdp.pop_screenshot(rid) else { continue };
                outbox.extend(protocol::encode_response(&Response::Error {
                    id: Some(req_id),
                    code,
                    message: "the screenshot request was refused".to_string(),
                }));
            }
            RdpFrame::Event(EngineEvent::InputRejected { applied, rejected }) => {
                outbox.extend(protocol::encode_response(&Response::RdpInputRejected {
                    session_id: rid,
                    applied,
                    rejected,
                }));
            }
            RdpFrame::Event(EngineEvent::Error { code, message }) => {
                outbox.extend(protocol::encode_response(&Response::Error { id: None, code, message }));
            }
            RdpFrame::Event(EngineEvent::ScreenshotStart { .. } | EngineEvent::ScreenshotChunk { .. }) => {
                // The manager turns these into RdpFrame::ScreenshotStart/Chunk.
            }
            RdpFrame::OwnerSet { request, dropped, released } => {
                outbox.extend(protocol::encode_response(&Response::SessionOwnerSet { id: request, session_id: rid, dropped, released: released as u64 }));
            }
            RdpFrame::Event(EngineEvent::OwnerSet { .. }) => {
                // The manager turns this into RdpFrame::OwnerSet.
            }
            RdpFrame::Event(EngineEvent::Stats { updates, pixels, last_update_ms, discarded, recoveries, recovery_skipped, ignored_outputs, bytes_in }) => {
                // Counts only. Carried as one `rdp.state` line so a reader of session_list sees them without a new message type.
                let state = format!("stats updates={updates} pixels={pixels} last_ms={last_update_ms} discarded={discarded} recoveries={recoveries} skipped={recovery_skipped} ignored={ignored_outputs} bytes={bytes_in} avg={}", if updates == 0 { 0 } else { bytes_in / updates });
                outbox.extend(protocol::encode_response(&Response::RdpState { session_id: rid, state }));
            }
            RdpFrame::Event(EngineEvent::Closed { .. }) => {
                // Reported once via RdpManager::take_all_closed().
            }
            RdpFrame::ScreenshotStart { id, frame_id, width, height, timestamp, chunks } => {
                // No request id: nobody asked, drop it (its chunks are dropped too).
                if let Some(id) = id {
                    outbox.extend(protocol::encode_response(&Response::RdpScreenshot {
                        id,
                        session_id: rid,
                        frame_id,
                        width,
                        height,
                        timestamp,
                        png: String::new(),
                        chunks: Some(chunks),
                    }));
                }
            }
            RdpFrame::ScreenshotChunk { id, index, count, data } => {
                outbox.extend(protocol::encode_response(&Response::RdpScreenshotChunk {
                    id,
                    session_id: rid,
                    index,
                    count,
                    data,
                }));
            }
            RdpFrame::Update { header, rgba } => relay_rdp_update(outbox, rid, header, &rgba),
        }
    }
}

/// Forward one engine band as one helper stream frame: {frameId, fbWidth,
/// fbHeight, x, y, w, h, chunks} + RGBA rows. The engine already split the
/// update into bands that fit one client frame (1 MiB with every header
/// counted) and states how many there are, so the view acks after the last;
/// the stream `seq` is the band's index inside the update.
/// The manager validated that `rgba` is exactly `w * h * 4` bytes inside the
/// framebuffer and that the band fits one frame.
fn relay_rdp_update(outbox: &mut VecDeque<u8>, rid: u32, header: UpdateHeader, rgba: &[u8]) {
    let mut payload = Vec::with_capacity(36 + rgba.len());
    payload.extend_from_slice(&header.frame_id.to_le_bytes());
    payload.extend_from_slice(&header.fb_width.to_le_bytes());
    payload.extend_from_slice(&header.fb_height.to_le_bytes());
    payload.extend_from_slice(&header.x.to_le_bytes());
    payload.extend_from_slice(&header.y.to_le_bytes());
    payload.extend_from_slice(&header.w.to_le_bytes());
    payload.extend_from_slice(&header.h.to_le_bytes());
    payload.extend_from_slice(&header.chunks.to_le_bytes());
    payload.extend_from_slice(rgba);
    outbox.extend(protocol::encode_stream(rid, header.band, &payload));
}

/// A stdin frame error: fatal means the stream is out of step and the helper
/// must shut down; invalid means the frame was well-framed but unparseable, so
/// the stream is still in step and the helper keeps running.
enum FrameError {
    Fatal(String),
    Invalid(String),
}

/// A parsed inbound frame (control request or binary stream input).
enum IncomingFrame {
    Control(Request),
    Stream { session_id: u32, data: Vec<u8> },
}

/// Incremental reader over the helper's stdin (non-blocking): buffers whatever
/// read(2) returns, bounded by INGRESS_CAP, and yields full control frames.
struct FrameReader {
    buf: Vec<u8>,
    eof: bool,
    read_total: u64,
}

impl FrameReader {
    fn new() -> Self {
        FrameReader {
            buf: Vec::new(),
            eof: false,
            read_total: 0,
        }
    }

    fn fill(&mut self, fd: RawFd) -> Result<(), String> {
        if self.buf.len() >= INGRESS_CAP {
            return Ok(()); // ingress is full: stop reading until it drains
        }
        let mut chunk = [0u8; 8192];
        loop {
            let room = INGRESS_CAP - self.buf.len();
            if room == 0 {
                return Ok(());
            }
            let want = room.min(chunk.len());
            let n = unsafe {
                libc::read(fd, chunk.as_mut_ptr() as *mut libc::c_void, want as libc::size_t)
            };
            if n < 0 {
                let err = io::Error::last_os_error();
                if err.kind() == io::ErrorKind::Interrupted {
                    continue;
                }
                if err.kind() == io::ErrorKind::WouldBlock {
                    return Ok(());
                }
                return Err(format!("stdin read: {err}"));
            }
            if n == 0 {
                self.eof = true;
                return Ok(());
            }
            self.buf.extend_from_slice(&chunk[..n as usize]);
            self.read_total += n as u64;
        }
    }

    #[cfg(feature = "test-hooks")]
    fn read_total(&self) -> u64 {
        self.read_total
    }

    fn is_full(&self) -> bool {
        self.buf.len() >= INGRESS_CAP
    }

    fn mark_eof(&mut self) {
        self.eof = true;
    }

    fn try_take(&mut self) -> Result<Option<IncomingFrame>, FrameError> {
        if self.buf.len() < 4 {
            return Ok(None);
        }
        let body_len = u32::from_le_bytes([self.buf[0], self.buf[1], self.buf[2], self.buf[3]]) as usize;
        if body_len > MAX_FRAME_BODY_BYTES {
            return Err(FrameError::Fatal(format!(
                "frame body length {body_len} exceeds the {MAX_FRAME_BODY_BYTES} byte limit"
            )));
        }
        if body_len < 1 {
            return Err(FrameError::Fatal("frame body length 0 is invalid".to_string()));
        }
        if self.buf.len() < 4 + body_len {
            return Ok(None);
        }
        let frame: Vec<u8> = self.buf.drain(..4 + body_len).collect();
        match frame[4] {
            FRAME_KIND_CONTROL => match serde_json::from_slice(&frame[5..]) {
                Ok(req) => Ok(Some(IncomingFrame::Control(req))),
                Err(e) => Err(FrameError::Invalid(format!("invalid control frame: {e}"))),
            },
            FRAME_KIND_STREAM => {
                if frame.len() < 5 + STREAM_HEADER_BYTES {
                    return Err(FrameError::Invalid("stream frame shorter than its header".to_string()));
                }
                let session_id = u32::from_le_bytes(frame[5..9].try_into().unwrap());
                let data = frame[5 + STREAM_HEADER_BYTES..].to_vec();
                Ok(Some(IncomingFrame::Stream { session_id, data }))
            }
            other => Err(FrameError::Fatal(format!("unexpected frame kind {other}"))),
        }
    }
}

fn pollfd(fd: RawFd, events: libc::c_short) -> libc::pollfd {
    libc::pollfd {
        fd,
        events,
        revents: 0,
    }
}

/// Best-effort non-blocking flush of the outbox to stdout. Returns true when
/// stdout failed fatally (EPIPE or any error other than EAGAIN/EINTR), meaning
/// the client is gone and the helper must tear everything down.
fn flush_stdout(outbox: &mut VecDeque<u8>) -> bool {
    while !outbox.is_empty() {
        let (a, b) = outbox.as_slices();
        let n = if !a.is_empty() {
            unsafe { libc::write(1, a.as_ptr() as *const libc::c_void, a.len()) }
        } else {
            unsafe { libc::write(1, b.as_ptr() as *const libc::c_void, b.len()) }
        };
        if n < 0 {
            let errno = last_errno();
            if errno == libc::EINTR {
                continue;
            }
            if errno == libc::EAGAIN {
                return false;
            }
            return true; // EPIPE or another non-transient error
        }
        outbox.drain(..n as usize);
    }
    false
}

/// Owns the SessionManager and reaps every child on ANY exit path, including a
/// panic (Drop runs during unwinding).
struct CleanupGuard {
    manager: SessionManager,
    rdp: RdpManager,
    pve: PveManager,
}

impl Drop for CleanupGuard {
    fn drop(&mut self) {
        self.manager.terminate_all();
        self.rdp.terminate_all();
        self.pve.terminate_all();
    }
}

#[derive(Clone, Copy)]
enum PollRole {
    Stdin,
    Signal,
    Stdout,
    Session(u32),
    Rdp(u32),
    Pve(u32),
    Askpass,
}

pub fn run(echo_argv: Option<Vec<String>>) -> i32 {
    unsafe { libc::signal(libc::SIGPIPE, libc::SIG_IGN) };
    // Session copies of the known_hosts overlay left by a helper that died.
    crate::known_hosts::cleanup_stale_copies();
    set_nonblocking(0);
    set_nonblocking(1);

    #[cfg(feature = "test-hooks")]
    if let Ok(v) = std::env::var("REMOTE_HUB_NOFILE") {
        if let Ok(n) = v.parse::<u64>() {
            let lim = libc::rlimit {
                rlim_cur: n,
                rlim_max: n,
            };
            unsafe { libc::setrlimit(libc::RLIMIT_NOFILE, &lim) };
        }
    }

    let (signal_rfd, signal_wfd) = make_pipe();
    SIGNAL_WRITE_FD.store(signal_wfd, Ordering::SeqCst);
    install_handler(libc::SIGTERM, on_shutdown_signal);
    install_handler(libc::SIGINT, on_shutdown_signal);
    install_handler(libc::SIGHUP, on_shutdown_signal);
    install_handler(libc::SIGCHLD, on_sigchld);

    let generation = random_generation();
    #[cfg(feature = "test-hooks")]
    let keep_finished = std::env::var("REMOTE_HUB_KEEP_FINISHED").is_ok();
    #[cfg(not(feature = "test-hooks"))]
    let keep_finished = false;
    let current_exe = std::env::current_exe()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|_| "remote-hub-helper".to_string());
    // One id allocator for every session kind, so a sessionId on the wire
    // names exactly one session.
    let ids = crate::ids::SessionIds::new();
    let mut guard = CleanupGuard {
        manager: SessionManager::with_ids(echo_argv, ids.clone()),
        rdp: RdpManager::with_ids(ids.clone()),
        pve: PveManager::with_ids(ids),
    };
    let mut reader = FrameReader::new();
    let mut outbox: VecDeque<u8> = VecDeque::new();
    let mut handshaken = false;
    let mut last_total = usize::MAX;
    let mut stalled = 0u32;
    #[cfg(feature = "test-hooks")]
    let mut reported_stdin_blocked = false;

    loop {
        if SHUTDOWN.load(Ordering::Relaxed) {
            break;
        }

        if flush_stdout(&mut outbox) {
            // The client is gone (stdout closed): tear down every child.
            SHUTDOWN.store(true, Ordering::SeqCst);
            break;
        }

        let session_fds = guard.manager.fds();
        let mut fds: Vec<libc::pollfd> = Vec::with_capacity(3 + session_fds.len());
        let mut roles: Vec<PollRole> = Vec::with_capacity(3 + session_fds.len());
        // Keep reading stdin until EOF, but only while the outbox has room so
        // a control-frame flood cannot grow memory without limit. Once EOF is
        // seen, stdin is dropped from the poll set entirely so a lingering
        // POLLHUP cannot make poll return at once.
        let want_stdin = !reader.eof && outbox.len() + OUTBOX_RESERVE <= OUTBOX_CAP;
        #[cfg(feature = "test-hooks")]
        if !want_stdin && !reported_stdin_blocked && !reader.eof {
            reported_stdin_blocked = true;
            eprintln!("helper-stdin-blocked bytes={}", reader.read_total());
        }
        let mut stdin_idx: Option<usize> = None;
        if !reader.eof {
            stdin_idx = Some(fds.len());
            roles.push(PollRole::Stdin);
            fds.push(pollfd(0, if want_stdin { libc::POLLIN } else { 0 }));
        }
        roles.push(PollRole::Signal);
        fds.push(pollfd(signal_rfd, libc::POLLIN));
        if !outbox.is_empty() {
            roles.push(PollRole::Stdout);
            fds.push(pollfd(1, libc::POLLOUT));
        }
        for (sid, mfd) in &session_fds {
            let events = guard.manager.poll_interest(*sid);
            roles.push(PollRole::Session(*sid));
            fds.push(pollfd(*mfd, events));
        }
        // Engine fds are read only while the outbox has room for a whole update
        // frame; otherwise the engine is held back by its full socket (and a
        // hung-up fd is left out so it cannot spin the loop).
        let rdp_room = outbox.len() + RDP_RESERVE <= OUTBOX_CAP;
        let mut rdp_buffered = false;
        for (rid, rfd) in guard.rdp.fds() {
            let events = guard.rdp.poll_interest(rid, rdp_room);
            if rdp_room && guard.rdp.has_buffered_frame(rid) {
                rdp_buffered = true;
            }
            if events == 0 {
                continue;
            }
            roles.push(PollRole::Rdp(rid));
            fds.push(pollfd(rfd, events));
        }

        // PVE engines: read only while the outbox has room for a whole data frame.
        let pve_room = outbox.len() + PVE_RESERVE <= OUTBOX_CAP;
        let mut pve_buffered = false;
        for (pid_, pfd) in guard.pve.fds() {
            let events = guard.pve.poll_interest(pid_, pve_room);
            if pve_room && guard.pve.has_buffered_frame(pid_) {
                pve_buffered = true;
            }
            if events == 0 {
                continue;
            }
            roles.push(PollRole::Pve(pid_));
            fds.push(pollfd(pfd, events));
        }

        // The askpass socket and its open requests (stage 3b-2).
        for afd in guard.manager.askpass_fds() {
            roles.push(PollRole::Askpass);
            fds.push(pollfd(afd, libc::POLLIN));
        }

        // Buffered engine frames are work that poll cannot signal.
        let poll_timeout = if rdp_buffered || pve_buffered { 0 } else if guard.manager.exec.running() > 0 { 20 } else { 50 };
        let r = unsafe { libc::poll(fds.as_mut_ptr(), fds.len() as libc::nfds_t, poll_timeout) };
        if r < 0 {
            let err = io::Error::last_os_error();
            if err.kind() == io::ErrorKind::Interrupted {
                continue;
            }
            break;
        }

        for (i, role) in roles.iter().enumerate() {
            let revents = fds[i].revents;
            match role {
                PollRole::Signal => {
                    if revents & (libc::POLLIN | libc::POLLHUP | libc::POLLERR) != 0 {
                        let mut sink = [0u8; 64];
                        let mut saw_shutdown = false;
                        loop {
                            let n = unsafe {
                                libc::read(signal_rfd, sink.as_mut_ptr() as *mut libc::c_void, sink.len())
                            };
                            if n > 0 {
                                for &b in &sink[..n as usize] {
                                    if b == SIG_BYTE_SHUTDOWN {
                                        saw_shutdown = true;
                                    }
                                }
                                continue;
                            }
                            break;
                        }
                        if saw_shutdown {
                            SHUTDOWN.store(true, Ordering::SeqCst);
                        }
                    }
                }
                PollRole::Stdout => {
                    if flush_stdout(&mut outbox) {
                        SHUTDOWN.store(true, Ordering::SeqCst);
                    }
                }
                PollRole::Session(sid) => {
                    guard.manager.handle_poll_events(*sid, revents);
                }
                PollRole::Rdp(rid) => {
                    guard.rdp.handle_poll_events(*rid, revents);
                    let readable = revents & (libc::POLLIN | libc::POLLHUP | libc::POLLERR | libc::POLLNVAL) != 0
                        || guard.rdp.has_buffered_frame(*rid);
                    if readable && outbox.len() + RDP_RESERVE <= OUTBOX_CAP {
                        let budget = OUTBOX_CAP.saturating_sub(outbox.len());
                        let frames = guard.rdp.process_readable(*rid, budget);
                        relay_rdp_frames(&mut guard.rdp, &mut outbox, &current_exe, *rid, frames);
                    }
                }
                PollRole::Pve(pid_) => {
                    guard.pve.handle_poll_events(*pid_, revents);
                    let readable = revents & (libc::POLLIN | libc::POLLHUP | libc::POLLERR | libc::POLLNVAL) != 0
                        || guard.pve.has_buffered_frame(*pid_);
                    if readable && outbox.len() + PVE_RESERVE <= OUTBOX_CAP {
                        let budget = OUTBOX_CAP.saturating_sub(outbox.len());
                        let frames = guard.pve.process_readable(*pid_, budget);
                        crate::pve::glue::relay_frames(&mut guard.pve, &mut outbox, &current_exe, *pid_, frames);
                    }
                }
                PollRole::Stdin | PollRole::Askpass => {}
            }
        }

        // Askpass requests are decided every turn (the socket is also in the poll set, so
        // a request wakes the loop at once); what the client must hear is queued.
        for event in guard.manager.askpass_service(&mut |reference| resolve_item(&current_exe, reference).map_err(|r| r.code())) {
            // An exec run has no page to show a question to: what ssh asked or refused is noted on the run, no more.
            let exec_note = match &event {
                crate::askpass::BrokerEvent::PromptRefused { session_id, kind } => Some((*session_id, kind.clone())),
                crate::askpass::BrokerEvent::CredentialRejected { session_id } => Some((*session_id, "credential_rejected".to_string())),
                crate::askpass::BrokerEvent::CredentialFailed { session_id, .. } => Some((*session_id, "credential_unavailable".to_string())),
                _ => None,
            };
            let exec_id = match &event {
                crate::askpass::BrokerEvent::Prompt { session_id, .. }
                | crate::askpass::BrokerEvent::PromptExpired { session_id, .. }
                | crate::askpass::BrokerEvent::CredentialUsed { session_id }
                | crate::askpass::BrokerEvent::Connected { session_id }
                | crate::askpass::BrokerEvent::CredentialRejected { session_id }
                | crate::askpass::BrokerEvent::CredentialFailed { session_id, .. }
                | crate::askpass::BrokerEvent::PromptRefused { session_id, .. } => Some(*session_id),
            };
            if let Some(eid) = exec_id.filter(|eid| guard.manager.exec.contains(*eid)) {
                if let Some((_, kind)) = exec_note {
                    guard.manager.exec.note_refusal(eid, kind);
                }
                continue;
            }
            outbox.extend(protocol::encode_response(&match event {
                crate::askpass::BrokerEvent::PromptRefused { .. } => continue,
                crate::askpass::BrokerEvent::Prompt { session_id, prompt_id, text, kind } => {
                    Response::SshPrompt { session_id, prompt_id, text, kind }
                }
                crate::askpass::BrokerEvent::CredentialUsed { session_id } => Response::SshCredentialUsed { session_id },
                crate::askpass::BrokerEvent::Connected { session_id } => Response::SshConnected { session_id },
                crate::askpass::BrokerEvent::CredentialRejected { session_id } => Response::SshCredentialRejected { session_id },
                crate::askpass::BrokerEvent::PromptExpired { session_id, prompt_id } => Response::SshPromptExpired { session_id, prompt_id },
                crate::askpass::BrokerEvent::CredentialFailed { session_id, code } => Response::SshCredentialFailed { session_id, code },
            }));
        }

        // Remote commands: read what they wrote, enforce their limits, report the ones that ended.
        for f in guard.manager.exec_pump() {
            let refused = guard.manager.exec.refused(f.id);
            outbox.extend(protocol::encode_response(&Response::ExecFinished { exec_id: f.id, exit_code: f.exit_code, signal: f.signal, reason: f.reason, refused }));
        }

        guard.manager.merge_host_keys_pending();

        // Reap children that exited on their own (never shuts down the helper).
        guard.manager.reap();
        guard.rdp.reap();
        for closed in guard.rdp.take_all_closed() {
            outbox.extend(session_closed_errors(&closed.pending_screenshots));
            outbox.extend(protocol::encode_response(&Response::SessionClosed {
                id: None,
                session_id: closed.session_id,
                exit_code: closed.exit.code,
                signal: closed.exit.signal,
                reason: closed.reason,
            }));
        }

        guard.pve.reap();
        for closed in guard.pve.take_all_closed() {
            outbox.extend(crate::pve::glue::closed_frames(&closed));
        }

        // Drain pending output into the bounded outbox in READ_CHUNK frames so
        // per-session sequence numbers stay consecutive.
        let snapshot = guard.manager.fds();
        loop {
            let mut progressed = false;
            for (sid, _) in &snapshot {
                let pending = guard.manager.pending_output_len(*sid);
                let room = OUTBOX_CAP.saturating_sub(outbox.len());
                if pending > 0 && room >= pending.min(READ_CHUNK) {
                    if let Some((seq, data)) = guard.manager.take_pending_output_chunk(*sid) {
                        outbox.extend(protocol::encode_stream(*sid, seq, &data));
                        progressed = true;
                    }
                }
            }
            if !progressed {
                break;
            }
        }

        // Finished sessions (child reaped, PTY done, output drained): notify.
        for (session_id, exit_code, signal, reason) in guard.manager.remove_finished(keep_finished) {
            outbox.extend(protocol::encode_response(&Response::SessionClosed {
                id: None,
                session_id,
                exit_code,
                signal,
                reason,
            }));
        }

        // stdin: read more (POLLIN while we want input, or a hangup that still
        // has buffered data even when the outbox is full), then drain frames.
        if let Some(idx) = stdin_idx {
            let revents = fds[idx].revents;
            let hung_up = revents & (libc::POLLHUP | libc::POLLERR) != 0;
            // Defensive on darwin (poll does not report POLLHUP while stdin events
            // are 0): these hang-up branches are not covered by a test here.
            let read_now = (want_stdin && revents & libc::POLLIN != 0) || hung_up;
            if !reader.eof && read_now {
                // The peer hung up but the ingress is still full: no more bytes
                // can be read, so treat it as EOF.
                if hung_up && reader.is_full() {
                    reader.mark_eof();
                }
                if let Err(e) = reader.fill(0) {
                    outbox.extend(protocol::encode_response(&Response::Error {
                        id: None,
                        code: "read_failed".to_string(),
                        message: e,
                    }));
                    SHUTDOWN.store(true, Ordering::SeqCst);
                }

            }
        }
        while outbox.len() + OUTBOX_RESERVE <= OUTBOX_CAP {
            match reader.try_take() {
                Ok(Some(IncomingFrame::Control(req))) => {
                    match handle(&mut guard.manager, &mut guard.rdp, &mut guard.pve, &current_exe, &mut handshaken, &generation, req) {
                        Ok(frames) => outbox.extend(frames),
                        Err((code, message)) => {
                            outbox.extend(protocol::encode_response(&Response::Error {
                                id: None,
                                code,
                                message,
                            }));
                            SHUTDOWN.store(true, Ordering::SeqCst);
                            break;
                        }
                    }
                }
                Ok(Some(IncomingFrame::Stream { session_id, data })) => {
                    // Binary terminal input; overflow is dropped (backpressure). Ids come from one allocator, so an id belongs
                    // to the PTY manager or to the PVE manager (a Proxmox terminal), never both.
                    if guard.pve.contains(session_id) {
                        // A graphical console takes raw RFB only through `pve.vnc_input`.
                        if !guard.pve.is_vnc(session_id) {
                            let _ = guard.pve.enqueue_input(session_id, &data);
                        }
                    } else {
                        let _ = guard.manager.enqueue_input_from(session_id, "human", &data);
                    }
                }
                Ok(None) => break,
                Err(FrameError::Invalid(message)) => {
                    // Well-framed but unparseable body: answer and keep running.
                    outbox.extend(protocol::encode_response(&Response::Error {
                        id: None,
                        code: "invalid_frame".to_string(),
                        message,
                    }));
                }
                Err(FrameError::Fatal(message)) => {
                    outbox.extend(protocol::encode_response(&Response::Error {
                        id: None,
                        code: "invalid_frame".to_string(),
                        message,
                    }));
                    SHUTDOWN.store(true, Ordering::SeqCst);
                    break;
                }
            }
        }

        // EOF with everything consumed (requests dispatched and outbox flushed):
        // done. Otherwise keep flushing; a client that no longer drains stdout
        // is bounded by the stall counter.
        if reader.eof {
            let total = reader.buf.len() + outbox.len();
            if total == 0 {
                break;
            }
            if total < last_total {
                stalled = 0;
            } else {
                stalled += 1;
            }
            last_total = total;
            if stalled > 200 {
                break;
            }
        }
    }

    flush_stdout(&mut outbox);
    SIGNAL_WRITE_FD.store(-1, Ordering::SeqCst);
    unsafe {
        libc::close(signal_rfd);
        libc::close(signal_wfd);
    }
    // guard drops here: terminate_all on every path.
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A keychain operation never resolves the helper by PATH: without an absolute path the
    /// operation fails closed (no process is started at all).
    #[test]
    fn a_remote_command_never_asks_about_a_host_key_it_refuses_an_unknown_or_changed_one() {
        let options = exec_known_hosts_options("UserKnownHostsFile=\"/p/known\"");
        let pairs: Vec<&str> = options.chunks(2).map(|c| c[1].as_str()).collect();
        assert!(options.chunks(2).all(|c| c[0] == "-o"));
        assert!(pairs.contains(&"StrictHostKeyChecking=yes"), "{pairs:?}");
        assert!(!pairs.iter().any(|o| o.starts_with("StrictHostKeyChecking=") && *o != "StrictHostKeyChecking=yes"));
        for needed in ["GlobalKnownHostsFile=none", "UpdateHostKeys=no", "CheckHostIP=no", "VerifyHostKeyDNS=no", "UserKnownHostsFile=\"/p/known\""] {
            assert!(pairs.contains(&needed), "{needed} missing: {pairs:?}");
        }
    }

    #[test]
    fn a_keychain_child_needs_an_absolute_executable_path() {
        let reference = "rh-cred:v1:local:0b8e6f4a-5c2d-4e1b-9a37-1f2e3d4c5b6a";
        for exe in ["remote-hub-helper", "", "./remote-hub-helper", "bin/remote-hub-helper"] {
            match keychain_child(exe, "status", reference, None, None) {
                Err(CredentialRefusal::Keychain(code)) => assert_eq!(code, "keychain_unavailable", "{exe:?}"),
                _ => panic!("{exe:?} must be refused"),
            }
        }
    }
    use crate::rdp::protocol::EngineEvent;

    #[test]
    fn desktop_geometry_is_limited_to_1_3840_by_1_2160() {
        for (w, h, ok) in [
            (1, 1, true),
            (3840, 2160, true),
            (800, 600, true),
            (0, 600, false),
            (800, 0, false),
            (3841, 600, false),
            (800, 2161, false),
            // 65536 truncates to 0 as a u16: it must be refused, not wrapped.
            (65_536, 600, false),
            (800, 65_537, false),
        ] {
            assert_eq!(rdp_geometry_ok(w, h), ok, "{w}x{h}");
        }
    }

    /// Decode the (id, code-or-"png") of every response in `outbox`.
    fn answers(outbox: &VecDeque<u8>) -> Vec<(Option<u64>, String)> {
        let bytes: Vec<u8> = outbox.iter().copied().collect();
        let mut at = 0;
        let mut out = Vec::new();
        while at < bytes.len() {
            let len = u32::from_le_bytes(bytes[at..at + 4].try_into().unwrap()) as usize;
            match protocol::decode_response(&bytes[at + 5..at + 4 + len]).unwrap() {
                Response::RdpScreenshot { id, .. } => out.push((Some(id), "png".to_string())),
                Response::Error { id, code, .. } => out.push((id, code)),
                Response::SessionClosed { id, reason, .. } => out.push((id, format!("closed:{reason}"))),
                other => panic!("unexpected {other:?}"),
            }
            at += 4 + len;
        }
        out
    }

    fn shot() -> RdpFrame {
        RdpFrame::Event(EngineEvent::Screenshot { frame_id: 1, width: 1, height: 1, timestamp: 0, png: "AAAA".to_string() })
    }

    #[test]
    fn screenshot_answers_go_to_requests_in_the_order_they_were_made() {
        let mut rdp = RdpManager::new();
        let (a, b) = unsafe {
            let mut fds = [0i32; 2];
            assert_eq!(libc::socketpair(libc::AF_UNIX, libc::SOCK_STREAM, 0, fds.as_mut_ptr()), 0);
            (fds[0], fds[1])
        };
        let sid = rdp.adopt(None, a);
        rdp.push_screenshot(sid, 41);
        rdp.push_screenshot(sid, 42);
        let mut outbox = VecDeque::new();
        relay_rdp_frames(&mut rdp, &mut outbox, "/nonexistent/helper", sid, vec![shot(), shot()]);
        assert_eq!(answers(&outbox), vec![(Some(41), "png".to_string()), (Some(42), "png".to_string())]);
        unsafe { libc::close(b) };
    }

    #[test]
    fn a_screenshot_nobody_asked_for_is_dropped() {
        let mut rdp = RdpManager::new();
        let (a, b) = unsafe {
            let mut fds = [0i32; 2];
            assert_eq!(libc::socketpair(libc::AF_UNIX, libc::SOCK_STREAM, 0, fds.as_mut_ptr()), 0);
            (fds[0], fds[1])
        };
        let sid = rdp.adopt(None, a);
        let mut outbox = VecDeque::new();
        relay_rdp_frames(&mut rdp, &mut outbox, "/nonexistent/helper", sid, vec![shot()]);
        assert!(outbox.is_empty(), "a response with no request id 0 was sent: {:?}", answers(&outbox));
        unsafe { libc::close(b) };
    }

    #[test]
    fn pending_screenshots_are_answered_with_session_closed_oldest_first() {
        let frames: VecDeque<u8> = session_closed_errors(&[7, 9]).into_iter().collect();
        assert_eq!(
            answers(&frames),
            vec![(Some(7), "session_closed".to_string()), (Some(9), "session_closed".to_string())]
        );
    }

    /// Closing a session answers its unanswered screenshot requests with
    /// `session_closed` BEFORE the close itself, oldest first.
    #[test]
    fn closing_a_session_answers_its_pending_screenshots() {
        use std::io::Write as _;
        let mut manager = SessionManager::new(None);
        let mut rdp = RdpManager::new();
        let mut fds = [0i32; 2];
        assert_eq!(unsafe { libc::socketpair(libc::AF_UNIX, libc::SOCK_STREAM, 0, fds.as_mut_ptr()) }, 0);
        let sid = rdp.adopt(None, fds[0]);
        // The engine announces its desktop, which makes the session ready.
        let mut peer = unsafe { <std::os::unix::net::UnixStream as std::os::fd::FromRawFd>::from_raw_fd(fds[1]) };
        peer.write_all(&crate::rdp::protocol::encode_control(&EngineEvent::Desktop {
            frame_id: 1,
            width: 8,
            height: 8,
            timestamp: 0,
        }))
        .unwrap();
        while !rdp.is_ready(sid) {
            let _ = rdp.process_readable(sid, usize::MAX);
        }
        let mut shake = true;
        for id in [61u64, 62] {
            let frames =
                handle(&mut manager, &mut rdp, &mut PveManager::new(), "/nonexistent", &mut shake, "g", Request::RdpScreenshot { id, session_id: sid }).unwrap();
            assert!(frames.is_empty(), "an accepted screenshot has no immediate answer");
        }
        let frames = handle(&mut manager, &mut rdp, &mut PveManager::new(), "/nonexistent", &mut shake, "g", Request::SessionClose { id: 70, session_id: sid }).unwrap();
        let outbox: VecDeque<u8> = frames.into_iter().collect();
        assert_eq!(
            answers(&outbox),
            vec![
                (Some(61), "session_closed".to_string()),
                (Some(62), "session_closed".to_string()),
                (Some(70), "closed:killed_by_close".to_string()),
            ]
        );
    }

    /// A session with a ready desktop, for the screenshot tests.
    fn ready_session(rdp: &mut RdpManager) -> (u32, std::os::unix::net::UnixStream) {
        use std::io::Write as _;
        let mut fds = [0i32; 2];
        assert_eq!(unsafe { libc::socketpair(libc::AF_UNIX, libc::SOCK_STREAM, 0, fds.as_mut_ptr()) }, 0);
        let sid = rdp.adopt(None, fds[0]);
        let mut peer = unsafe { <std::os::unix::net::UnixStream as std::os::fd::FromRawFd>::from_raw_fd(fds[1]) };
        peer.write_all(&crate::rdp::protocol::encode_control(&EngineEvent::Desktop {
            frame_id: 1,
            width: 8,
            height: 8,
            timestamp: 0,
        }))
        .unwrap();
        while !rdp.is_ready(sid) {
            let _ = rdp.process_readable(sid, usize::MAX);
        }
        (sid, peer)
    }

    /// J5: at most 4 screenshot requests are outstanding; the fifth is refused
    /// with `screenshot_busy`, and an answer makes room for a new one.
    #[test]
    fn the_fifth_outstanding_screenshot_is_busy_until_one_is_answered() {
        let mut manager = SessionManager::new(None);
        let mut rdp = RdpManager::new();
        let (sid, _peer) = ready_session(&mut rdp);
        let mut shake = true;
        let mut ask = |rdp: &mut RdpManager, id: u64| {
            handle(&mut manager, rdp, &mut PveManager::new(), "/nonexistent", &mut shake, "g", Request::RdpScreenshot { id, session_id: sid }).unwrap()
        };
        for id in 1..=4u64 {
            assert!(ask(&mut rdp, id).is_empty(), "request {id} must be accepted");
        }
        let refused: VecDeque<u8> = ask(&mut rdp, 5).into_iter().collect();
        assert_eq!(answers(&refused), vec![(Some(5), "screenshot_busy".to_string())]);
        // The engine answers the oldest request; a new one fits again.
        let mut outbox = VecDeque::new();
        relay_rdp_frames(&mut rdp, &mut outbox, "/nonexistent/helper", sid, vec![shot()]);
        assert_eq!(answers(&outbox), vec![(Some(1), "png".to_string())]);
        assert!(ask(&mut rdp, 6).is_empty());
    }
}
