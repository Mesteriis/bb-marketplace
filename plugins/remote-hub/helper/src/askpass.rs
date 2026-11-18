//! SSH askpass for saved credentials (stage 3b-2, hardened by repair S1-S6).
//!
//! OpenSSH, started with `SSH_ASKPASS_REQUIRE=force`, runs `$SSH_ASKPASS <prompt>`
//! for every secret prompt (password, key passphrase) and every confirmation
//! (host key). `$SSH_ASKPASS` is a symlink named `remote-hub-askpass` in a private
//! 0700 directory, pointing at THIS helper binary by its absolute path; the helper
//! sees that name as argv[0] and runs `run_client`, so no shell script and no
//! other program is involved.
//!
//! The helper (one thread, see threads.rs) owns a Unix socket in that directory
//! (mode 0600) and ALL decisions. The askpass CLIENT is a dumb relay: it checks that
//! the socket and the peer it connected to really are this helper's, forwards the
//! prompt, and prints whatever the helper answers. It never touches the Keychain.
//! The helper reads the Keychain through its bounded `--keychain-op` child.
//! A request is answered only if ALL hold:
//!   * the connecting process has our uid (getpeereid),
//!   * its PARENT is the ssh process of the session the nonce belongs to,
//!   * the nonce is the session's (in the environment ssh passes on).
//! The stored secret is released only for the ONE prompt this session expects:
//! the exact line OpenSSH writes for the user@host or key file the session was opened with
//! (computed from the session's own argv, never from a field of the request), and only
//! once. The item's binding must equal the one the session was opened with. A second such
//! prompt means the secret was refused; a Keychain that will not give it up is a failure:
//! in both cases ssh is stopped BEFORE the reply, because a failed askpass would otherwise be
//! turned by OpenSSH into an EMPTY password sent to the server.
//! Every other prompt (a yes/no question, a keyboard-interactive text, anything that merely
//! looks like a password prompt) goes to the user; his answer is returned to that one request
//! and never stored. The prompt kind the client reports is believed only for `confirm` and
//! `none`; anything else is classified here.
use crate::binding::Bind;
use crate::keychain::Item;
use crate::peer::{exe_is_this_binary, parent_pid, peer_pid, peer_uid};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::os::fd::{AsRawFd, RawFd};
use std::os::unix::fs::{symlink, DirBuilderExt, PermissionsExt};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

/// The askpass program's name: what argv[0] of the symlink is.
pub const ASKPASS_NAME: &str = "remote-hub-askpass";
pub const ENV_SOCKET: &str = "REMOTE_HUB_ASKPASS_SOCKET";
pub const ENV_NONCE: &str = "REMOTE_HUB_ASKPASS_NONCE";

/// How long a client may take to send its request.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(5);
/// How long a question put to the user stays open.
pub const UI_TIMEOUT: Duration = Duration::from_secs(120);

/// The UI timeout in force: the constant, or (test-hooks builds only) the milliseconds in
/// REMOTE_HUB_ASKPASS_UI_TIMEOUT_MS, so a test need not wait two minutes.
fn ui_timeout() -> Duration {
    #[cfg(feature = "test-hooks")]
    if let Some(ms) = std::env::var("REMOTE_HUB_ASKPASS_UI_TIMEOUT_MS").ok().and_then(|v| v.parse::<u64>().ok()) {
        return Duration::from_millis(ms);
    }
    UI_TIMEOUT
}
const MAX_REQUEST: usize = 8 * 1024;
const MAX_PROMPT: usize = 1024;

/// What a prompt with an empty SSH_ASKPASS_PROMPT is. "stored": exactly the one-line prompt this
/// session expects (`expected`, built by the server from the user, host or key path it opened ssh
/// with), so a look-alike text shown by a server never receives the secret. "confirm": a yes/no
/// question (the host key). Anything else is "secret": the user types it.
fn classify_prompt(prompt: &str, expected: &str) -> &'static str {
    let expected = expected.trim_end();
    if !expected.is_empty() && !prompt.contains('\n') && prompt.trim_end() == expected {
        return "stored";
    }
    if prompt.contains("(yes/no") {
        return "confirm";
    }
    "secret"
}

#[derive(Serialize, Deserialize)]
struct Request {
    nonce: String,
    prompt: String,
    /// SSH_ASKPASS_PROMPT as the client saw it. Only "confirm" and "none" are believed.
    #[serde(default)]
    kind: String,
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "action")]
enum Reply {
    /// Print this: the saved secret, or what the user typed for this one prompt.
    #[serde(rename = "answer")]
    Answer { text: String },
    #[serde(rename = "deny")]
    Deny,
}

/// Something the helper must tell its client (the TypeScript layer).
#[derive(Debug, PartialEq, Eq)]
pub enum BrokerEvent {
    /// A prompt for the user. `kind` is "secret" (a typed, masked answer), "confirm" or "none".
    Prompt { session_id: u32, prompt_id: u64, text: String, kind: String },
    /// A question the user did not answer in time (or whose ssh went away): it was refused, so the page may close it.
    PromptExpired { session_id: u32, prompt_id: u64 },
    /// The saved credential was used once and the server asked again: it was refused.
    CredentialRejected { session_id: u32 },
    /// The Keychain would not hand the saved credential over (keychain_locked, credential_missing, ...).
    CredentialFailed { session_id: u32, code: String },
}

struct Session {
    child_pid: i32,
    reference: String,
    bind: Bind,
    expected: String,
    burned: bool,
    rejected_sent: bool,
}

enum State {
    Reading,
    /// The question is with the user.
    Ui { prompt_id: u64, since: Instant, session_id: u32 },
}

struct Conn {
    stream: UnixStream,
    buf: Vec<u8>,
    since: Instant,
    state: State,
}

pub struct Broker {
    dir: PathBuf,
    socket_path: PathBuf,
    listener: UnixListener,
    /// Nonces handed out before their session is registered.
    pending: HashMap<String, ()>,
    by_nonce: HashMap<String, u32>,
    sessions: HashMap<u32, Session>,
    conns: Vec<Conn>,
    next_prompt: u64,
    events: Vec<BrokerEvent>,
}

fn random_hex(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    let ok = std::fs::File::open("/dev/urandom").and_then(|mut f| f.read_exact(&mut buf)).is_ok();
    if !ok {
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
        for (i, b) in buf.iter_mut().enumerate() {
            *b = (nanos >> (i % 16 * 8)) as u8 ^ (std::process::id() as u8).wrapping_add(i as u8);
        }
    }
    buf.iter().map(|b| format!("{b:02x}")).collect()
}

impl Broker {
    /// Creates the private directory (0700), the askpass symlink and the socket (0600).
    pub fn new(helper_exe: &str) -> std::io::Result<Broker> {
        // The socket path must fit sun_path (104 bytes on macOS): a short base.
        let base = std::env::temp_dir();
        let base = if base.as_os_str().len() > 40 { PathBuf::from("/tmp") } else { base };
        let dir = base.join(format!("rh-ap-{}-{}", std::process::id(), random_hex(4)));
        std::fs::DirBuilder::new().mode(0o700).create(&dir)?;
        // Whatever fails after the directory exists must not leave it behind.
        let built = (|| -> std::io::Result<(PathBuf, UnixListener)> {
            let socket_path = dir.join("s");
            let listener = UnixListener::bind(&socket_path)?;
            std::fs::set_permissions(&socket_path, std::fs::Permissions::from_mode(0o600))?;
            listener.set_nonblocking(true)?;
            symlink(helper_exe, dir.join(ASKPASS_NAME))?;
            Ok((socket_path, listener))
        })();
        let (socket_path, listener) = match built {
            Ok(parts) => parts,
            Err(e) => {
                let _ = std::fs::remove_dir_all(&dir);
                return Err(e);
            }
        };
        Ok(Broker {
            dir,
            socket_path,
            listener,
            pending: HashMap::new(),
            by_nonce: HashMap::new(),
            sessions: HashMap::new(),
            conns: Vec::new(),
            next_prompt: 1,
            events: Vec::new(),
        })
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    pub fn socket_path(&self) -> &Path {
        &self.socket_path
    }

    /// The environment an ssh session needs, and its one-shot nonce. Call BEFORE spawning.
    pub fn prepare(&mut self) -> (String, Vec<(String, String)>) {
        let nonce = random_hex(24);
        self.pending.insert(nonce.clone(), ());
        let env = vec![
            ("SSH_ASKPASS".to_string(), self.dir.join(ASKPASS_NAME).to_string_lossy().to_string()),
            ("SSH_ASKPASS_REQUIRE".to_string(), "force".to_string()),
            (ENV_SOCKET.to_string(), self.socket_path.to_string_lossy().to_string()),
            (ENV_NONCE.to_string(), nonce.clone()),
        ];
        (nonce, env)
    }

    /// Binds a prepared nonce to the session that was spawned with it.
    pub fn register(&mut self, nonce: &str, session_id: u32, child_pid: i32, reference: &str, bind: Bind, expected: &str) {
        if self.pending.remove(nonce).is_some() {
            self.by_nonce.insert(nonce.to_string(), session_id);
            self.sessions.insert(session_id, Session { child_pid, reference: reference.to_string(), bind, expected: expected.to_string(), burned: false, rejected_sent: false });
        }
    }

    /// The session ended: nothing may be asked for it any more.
    pub fn session_closed(&mut self, session_id: u32) {
        self.sessions.remove(&session_id);
        self.by_nonce.retain(|_, sid| *sid != session_id);
        let mut keep = Vec::new();
        for mut conn in self.conns.drain(..) {
            if matches!(&conn.state, State::Ui { session_id: sid, .. } if *sid == session_id) {
                let _ = write_reply(&mut conn.stream, Reply::Deny);
            } else {
                keep.push(conn);
            }
        }
        self.conns = keep;
    }

    /// Descriptors the helper's poll loop should watch (all read-interest).
    pub fn fds(&self) -> Vec<RawFd> {
        let mut fds = vec![self.listener.as_raw_fd()];
        fds.extend(self.conns.iter().filter(|c| matches!(c.state, State::Reading)).map(|c| c.stream.as_raw_fd()));
        fds
    }

    pub fn take_events(&mut self) -> Vec<BrokerEvent> {
        std::mem::take(&mut self.events)
    }

    /// Accepts, reads and decides. Never blocks.
    pub fn service(&mut self, fetch: &mut dyn FnMut(&str) -> Result<Item, String>) {
        while let Ok((stream, _)) = self.listener.accept() {
            if stream.set_nonblocking(true).is_ok() {
                self.conns.push(Conn { stream, buf: Vec::new(), since: Instant::now(), state: State::Reading });
            }
        }
        let mut i = 0;
        while i < self.conns.len() {
            let done = self.service_conn(i, fetch);
            if done {
                self.conns.swap_remove(i);
            } else {
                i += 1;
            }
        }
    }

    /// True when the connection is finished and can be dropped.
    fn service_conn(&mut self, index: usize, fetch: &mut dyn FnMut(&str) -> Result<Item, String>) -> bool {
        let now = Instant::now();
        match &self.conns[index].state {
            State::Ui { since, prompt_id, session_id } => {
                let (since, prompt_id, session_id) = (*since, *prompt_id, *session_id);
                if now.duration_since(since) > ui_timeout() {
                    let conn = &mut self.conns[index];
                    let _ = write_reply(&mut conn.stream, Reply::Deny);
                    self.events.push(BrokerEvent::PromptExpired { session_id, prompt_id });
                    return true;
                }
                // The client going away cancels the question.
                let mut probe = [0u8; 1];
                let gone = matches!(self.conns[index].stream.read(&mut probe), Ok(0));
                if gone {
                    self.events.push(BrokerEvent::PromptExpired { session_id, prompt_id });
                }
                return gone;
            }
            State::Reading => {}
        }
        let mut chunk = [0u8; 2048];
        loop {
            match self.conns[index].stream.read(&mut chunk) {
                Ok(0) => return true,
                Ok(n) => {
                    self.conns[index].buf.extend_from_slice(&chunk[..n]);
                    if self.conns[index].buf.len() > MAX_REQUEST {
                        return true;
                    }
                }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => break,
                Err(_) => return true,
            }
        }
        if now.duration_since(self.conns[index].since) > REQUEST_TIMEOUT && !self.conns[index].buf.contains(&b'\n') {
            return true;
        }
        let Some(end) = self.conns[index].buf.iter().position(|b| *b == b'\n') else { return false };
        let line = self.conns[index].buf[..end].to_vec();
        let request = serde_json::from_slice::<Request>(&line).ok();
        let reply = match request {
            Some(request) => self.decide(index, request, fetch),
            None => Some(Reply::Deny),
        };
        match reply {
            Some(reply) => {
                let _ = write_reply(&mut self.conns[index].stream, reply);
                true
            }
            None => false, // handed to the user
        }
    }

    /// Stops the ssh process that is waiting on this very askpass call (see the module comment).
    fn stop_ssh(child_pid: i32) {
        // SAFETY: child_pid is the ssh child of this session; the caller has just checked that the
        // asking process's parent is exactly that pid.
        unsafe {
            libc::kill(child_pid, libc::SIGTERM);
        }
    }

    /// Some(reply) answers now; None means the question is with the user.
    fn decide(&mut self, index: usize, request: Request, fetch: &mut dyn FnMut(&str) -> Result<Item, String>) -> Option<Reply> {
        let fd = self.conns[index].stream.as_raw_fd();
        let Some(&session_id) = self.by_nonce.get(&request.nonce) else { return Some(Reply::Deny) };
        // 1. Our user.
        if peer_uid(fd) != Some(unsafe { libc::geteuid() }) {
            return Some(Reply::Deny);
        }
        // 2. A child of the ssh process this nonce was issued to.
        let Some(session) = self.sessions.get_mut(&session_id) else { return Some(Reply::Deny) };
        let child_pid = session.child_pid;
        match peer_pid(fd).and_then(parent_pid) {
            Some(parent) if parent == child_pid => {}
            _ => return Some(Reply::Deny),
        }
        let text: String = request.prompt.chars().take(MAX_PROMPT).collect();
        // The client's own idea of the kind is believed only for the two harmless ones.
        let kind = match request.kind.as_str() {
            "confirm" => "confirm",
            "none" => "none",
            _ => classify_prompt(&request.prompt, &session.expected),
        };
        if kind == "stored" {
            if session.burned {
                // Asked again after the stored secret was used: the server (or the key) refused it.
                let first = !session.rejected_sent;
                session.rejected_sent = true;
                if first {
                    self.events.push(BrokerEvent::CredentialRejected { session_id });
                }
                Self::stop_ssh(child_pid);
                return Some(Reply::Deny);
            }
            // The first (and only) use: the nonce is spent whatever happens next.
            session.burned = true;
            let reference = session.reference.clone();
            let wanted = session.bind.clone();
            match fetch(&reference) {
                Ok(item) if item.bind == wanted => return Some(Reply::Answer { text: item.secret.expose().to_string() }),
                outcome => {
                    let code = match outcome {
                        Ok(_) => "credential_target_mismatch".to_string(),
                        Err(code) => code,
                    };
                    if let Some(session) = self.sessions.get_mut(&session_id) {
                        // A refused Keychain is not "the server refused the password": no second message.
                        session.rejected_sent = true;
                    }
                    self.events.push(BrokerEvent::CredentialFailed { session_id, code: code.chars().take(64).collect() });
                    Self::stop_ssh(child_pid);
                    return Some(Reply::Deny);
                }
            }
        }
        // A confirmation (host key), an informational message or anything else: the user decides; nothing is stored.
        let prompt_id = self.next_prompt;
        self.next_prompt += 1;
        self.conns[index].state = State::Ui { prompt_id, since: Instant::now(), session_id };
        self.events.push(BrokerEvent::Prompt { session_id, prompt_id, text, kind: kind.to_string() });
        None
    }

    /// The user's answer to a prompt (None = cancelled). False when no such prompt is open.
    pub fn answer(&mut self, session_id: u32, prompt_id: u64, answer: Option<String>) -> bool {
        let Some(pos) = self.conns.iter().position(|c| matches!(&c.state, State::Ui { prompt_id: p, session_id: s, .. } if *p == prompt_id && *s == session_id)) else {
            return false;
        };
        let mut conn = self.conns.swap_remove(pos);
        let reply = match answer {
            Some(text) => Reply::Answer { text },
            None => Reply::Deny,
        };
        let _ = write_reply(&mut conn.stream, reply);
        true
    }
}

impl Drop for Broker {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

/// Writes one reply line and wipes the copies of an answer this function made.
fn write_reply(stream: &mut UnixStream, reply: Reply) -> std::io::Result<()> {
    let mut reply = reply;
    let mut text = serde_json::to_string(&reply).map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
    text.push('\n');
    let written = stream.write_all(text.as_bytes());
    wipe(&mut text);
    if let Reply::Answer { text } = &mut reply {
        wipe(text);
    }
    written
}

/// Overwrites a string's bytes (best effort: the allocator may have copies from growth).
fn wipe(text: &mut String) {
    // SAFETY: only zero bytes are written, which keep the string valid UTF-8.
    for byte in unsafe { text.as_mut_vec() }.iter_mut() {
        unsafe { std::ptr::write_volatile(byte, 0) };
    }
}

// ---- the askpass client (its own process) -------------------------------------

/// A path the client may trust as the helper's socket: a socket, ours, closed to everyone else,
/// in a directory that is a real directory, ours, closed to everyone else. (Whoever put the
/// environment variable there, a socket that is not the helper's own is not connected to.)
fn socket_path_is_private(socket: &str) -> bool {
    use std::os::unix::fs::{FileTypeExt, MetadataExt};
    let euid = unsafe { libc::geteuid() };
    let path = Path::new(socket);
    let Some(dir) = path.parent() else { return false };
    let (Ok(dir_meta), Ok(sock_meta)) = (std::fs::symlink_metadata(dir), std::fs::symlink_metadata(path)) else { return false };
    dir_meta.file_type().is_dir()
        && dir_meta.uid() == euid
        && dir_meta.mode() & 0o077 == 0
        && sock_meta.file_type().is_socket()
        && sock_meta.uid() == euid
        && sock_meta.mode() & 0o077 == 0
}

/// What `remote-hub-askpass <prompt>` does: ask the helper, print the answer, or fail.
/// Exit 0 with the answer on stdout; any other exit tells OpenSSH the prompt was cancelled.
/// The client holds no secret and reads no Keychain: it prints what the helper sends, so it first
/// makes sure it IS talking to the helper that started its ssh.
pub fn run_client(args: &[String]) -> i32 {
    let prompt = args.get(1).cloned().unwrap_or_default();
    let kind = std::env::var("SSH_ASKPASS_PROMPT").unwrap_or_default();
    let (Ok(socket), Ok(nonce)) = (std::env::var(ENV_SOCKET), std::env::var(ENV_NONCE)) else { return 1 };
    if !socket_path_is_private(&socket) {
        return 1;
    }
    let Ok(mut stream) = UnixStream::connect(&socket) else { return 1 };
    // The peer must be this very binary and the process that started our parent (ssh): the helper.
    let ppid = unsafe { libc::getppid() };
    match (peer_pid(stream.as_raw_fd()), parent_pid(ppid)) {
        (Some(peer), Some(grandparent)) if peer == grandparent && exe_is_this_binary(peer) => {}
        _ => return 1,
    }
    // A cancelled/hung helper must not hold ssh for ever: bounded by the UI timeout plus slack.
    let _ = stream.set_read_timeout(Some(UI_TIMEOUT + Duration::from_secs(10)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(5)));
    let request = Request { nonce, prompt, kind };
    let Ok(mut line) = serde_json::to_string(&request) else { return 1 };
    line.push('\n');
    if stream.write_all(line.as_bytes()).is_err() {
        return 1;
    }
    let mut reply = String::new();
    let mut byte = [0u8; 1];
    while reply.len() < MAX_REQUEST {
        match stream.read(&mut byte) {
            Ok(1) if byte[0] == b'\n' => break,
            Ok(1) => reply.push(byte[0] as char),
            _ => {
                wipe(&mut reply);
                return 1;
            }
        }
    }
    let parsed = serde_json::from_str::<Reply>(&reply);
    wipe(&mut reply);
    let answer = match parsed {
        Ok(Reply::Answer { text }) => text,
        _ => return 1,
    };
    let mut out = std::io::stdout();
    let written = out.write_all(answer.as_bytes()).and_then(|()| out.write_all(b"\n")).and_then(|()| out.flush());
    let mut answer = answer;
    wipe(&mut answer);
    if written.is_err() {
        return 1;
    }
    0
}

/// True when this process was started as the askpass program.
pub fn invoked_as_askpass(argv0: &str) -> bool {
    Path::new(argv0).file_name().map(|n| n == ASKPASS_NAME).unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_exact_expected_prompt_is_eligible_for_the_stored_secret() {
        let pw = "root@127.0.0.1's password: ";
        let key = "Enter passphrase for key '/Users/x/.ssh/id_ed25519': ";
        assert_eq!(classify_prompt(pw, pw), "stored");
        assert_eq!(classify_prompt(key, key), "stored");
        // The same SHAPE for another user, host or key is a stranger's text.
        assert_eq!(classify_prompt("admin@127.0.0.1's password: ", pw), "secret");
        assert_eq!(classify_prompt("Enter passphrase for key '/tmp/other': ", key), "secret");
        assert_eq!(classify_prompt(pw, key), "secret");
        assert_eq!(classify_prompt(key, pw), "secret");
        // No expectation means nothing is eligible.
        assert_eq!(classify_prompt(pw, ""), "secret");
        assert_eq!(classify_prompt("The authenticity of host 'h' can't be established.\nAre you sure you want to continue connecting (yes/no/[fingerprint])? ", pw), "confirm");
        assert_eq!(classify_prompt("Are you sure you want to continue connecting (yes/no)? ", pw), "confirm");
        assert_eq!(classify_prompt("Verification code: ", pw), "secret");
        // Multi-line text that ends like the expected prompt is not eligible.
        assert_eq!(classify_prompt("anything\nroot@127.0.0.1's password: ", pw), "secret");
    }

    #[test]
    fn the_askpass_name_is_recognised_by_its_last_path_component_only() {
        assert!(invoked_as_askpass("/tmp/rh-ap-1-ab/remote-hub-askpass"));
        assert!(invoked_as_askpass("remote-hub-askpass"));
        assert!(!invoked_as_askpass("/usr/bin/remote-hub-helper"));
        assert!(!invoked_as_askpass("/tmp/x/remote-hub-askpass-evil"));
    }

    #[test]
    fn the_private_directory_and_socket_have_the_documented_modes_and_are_removed() {
        let broker = Broker::new("/bin/echo").unwrap();
        let dir = broker.dir().to_path_buf();
        let mode = |p: &Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&dir), 0o700);
        assert_eq!(mode(broker.socket_path()), 0o600);
        let link = dir.join(ASKPASS_NAME);
        assert_eq!(std::fs::read_link(&link).unwrap(), PathBuf::from("/bin/echo"));
        assert!(broker.socket_path().to_string_lossy().len() < 100, "must fit sun_path");
        drop(broker);
        assert!(!dir.exists());
    }

    #[test]
    fn nonces_are_unique_random_and_single_session() {
        let mut broker = Broker::new("/bin/echo").unwrap();
        let (a, env_a) = broker.prepare();
        let (b, _) = broker.prepare();
        assert_ne!(a, b);
        assert_eq!(a.len(), 48);
        assert!(env_a.iter().any(|(k, v)| k == "SSH_ASKPASS_REQUIRE" && v == "force"));
        assert!(env_a.iter().any(|(k, v)| k == ENV_NONCE && *v == a));
        broker.register(&a, 7, 100, "rh-cred:v1:local:0b8e6f4a-5c2d-4e1b-9a37-1f2e3d4c5b6a", Bind::Key { path: "/k".into() }, "p: ");
        // Registering the same nonce again changes nothing: it is no longer pending.
        broker.register(&a, 8, 200, "x", Bind::Key { path: "/k".into() }, "p: ");
        assert_eq!(broker.by_nonce.get(&a), Some(&7));
    }
}
