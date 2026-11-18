//! SSH askpass through the REAL helper process and a REAL pty (stage 3b-2). The "ssh" here is
//! `/usr/bin/perl` (test-hooks allow a free-form program) running a script that starts
//! `$SSH_ASKPASS` exactly as OpenSSH does: fork + exec of the program itself, with no shell in
//! between, so the askpass process's parent is the "ssh" process; a real OpenSSH against a real sshd is covered by the TypeScript
//! integration tests. The keychain is a TEMPORARY keychain file opened by path; every test runs
//! under a 60 s abort watchdog.
#![cfg(target_os = "macos")]
mod common;

use common::*;
use remote_hub_helper::keychain::create_at;
use remote_hub_helper::protocol::{decode_response, Request, Response, FRAME_KIND_CONTROL, FRAME_KIND_STREAM};
use remote_hub_helper::binding::Bind;
use remote_hub_helper::protocol::AskpassSpec;
use remote_hub_helper::ssh_args::{AuthMethod, SshFacts};
use remote_hub_helper::secret::Secret;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::time::{Duration, Instant};

/// `ask(prompt, kind)` -> (answer, exit code): how OpenSSH runs askpass (a direct fork+exec,
/// SSH_ASKPASS_PROMPT set for non-secret prompts).
const PERL_PRELUDE: &str = r#"
use Digest::SHA qw(sha256_hex);
$| = 1;
sub ask {
  my ($prompt, $kind) = @_;
  local $ENV{SSH_ASKPASS_PROMPT} = $kind if defined $kind;
  my $pid = open(my $fh, "-|", $ENV{SSH_ASKPASS}, $prompt);
  return (undef, 255) unless defined $pid;
  my $out = <$fh>; close $fh; my $rc = $? >> 8;
  chomp $out if defined $out;
  return ($out, $rc);
}
sub digest { return substr(sha256_hex($_[0] // ""), 0, 16); }
"#;

const SECRET: &str = "S3cr3t-ASK-1";
/// First 16 hex of SHA-256("S3cr3t-ASK-1"), computed outside this test.
/// The prompt the fake ssh scripts write for the saved secret.
const EXPECTED: &str = "user@host's password: ";

/// What the fake "ssh" is going to do, and what the saved secret is bound to (S2).
fn facts() -> SshFacts {
    SshFacts { host: "host".into(), port: 22, user: Some("user".into()), identity: None, method: AuthMethod::Password }
}
fn password_bind() -> Bind {
    Bind::Endpoint { protocol: "ssh".into(), host: "host".into(), port: 22, user: Some("user".into()), domain: None, cert: None }
}
const SECRET_DIGEST: &str = "8e7c875e48e8e54c";
const REF: &str = "rh-cred:v1:local:0b8e6f4a-5c2d-4e1b-9a37-1f2e3d4c5b6a";

fn watchdog() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        std::thread::spawn(|| {
            std::thread::sleep(Duration::from_secs(60));
            eprintln!("askpass tests: watchdog expired after 60 s; aborting");
            std::process::abort();
        });
    });
}

struct Fixture {
    dir: PathBuf,
    path: PathBuf,
    h: Option<Helper>,
    facts: SshFacts,
}

impl Fixture {
    fn new(tag: &str, extra_env: &[(&str, &str)]) -> Fixture {
        Fixture::with(tag, extra_env, SECRET, password_bind(), facts())
    }

    fn new_secret(tag: &str, secret: &str) -> Fixture {
        Fixture::with(tag, &[], secret, password_bind(), facts())
    }

    /// A fixture whose saved secret, its binding and the session's facts are chosen by the test.
    fn with(tag: &str, extra_env: &[(&str, &str)], secret: &str, bind: Bind, facts: SshFacts) -> Fixture {
        watchdog();
        let dir = std::env::temp_dir().join(format!("rh-ask-{}-{tag}", std::process::id()));
        std::os::unix::fs::DirBuilderExt::mode(&mut std::fs::DirBuilder::new(), 0o700).create(&dir).unwrap();
        let path = dir.join("kc.keychain-db");
        create_at(&path, "throwaway-kc-password").expect("temporary keychain");
        let mut env: Vec<(&str, &str)> = vec![("REMOTE_HUB_KEYCHAIN_PATH", path.to_str().unwrap())];
        env.extend_from_slice(extra_env);
        let mut h = start(&env);
        h.send(&Request::CredentialSave { id: 1, reference: REF.into(), secret: Secret::new(secret), bind });
        assert!(matches!(h.read_reply(1), Response::CredentialOk { .. }));
        Fixture { dir, path, h: Some(h), facts }
    }

    fn h(&mut self) -> &mut Helper {
        self.h.as_mut().unwrap()
    }

    /// Opens `perl -e script` as an ssh-kind session with a saved credential (or without).
    fn open(&mut self, script: &str, askpass: bool) -> u32 {
        let id = 10;
        let facts = self.facts.clone();
        let mut env = HashMap::new();
        env.insert("PATH".to_string(), "/usr/bin:/bin".to_string());
        self.h().send(&Request::OpenSsh {
            id,
            cols: 200,
            rows: 24,
            program: "/usr/bin/perl".into(),
            argv: vec!["perl".into(), "-e".into(), format!("{PERL_PRELUDE}\n{script}")],
            env,
            cwd: None,
            askpass: askpass.then(|| AskpassSpec { credential_ref: REF.into(), test_facts: Some(facts) }),
        });
        let sid = match self.h().read_reply(id) {
            Response::SessionOpened { session_id, .. } => session_id,
            other => panic!("expected session.opened, got {other:?}"),
        };
        self.h().send(&Request::SessionCredit { id: 11, session_id: sid, bytes: 1 << 20 });
        sid
    }

    /// Reads until `done(text, events)` or the limit; returns what was seen.
    fn drive(&mut self, sid: u32, limit: Duration, mut done: impl FnMut(&str, &[Response]) -> bool) -> (String, Vec<Response>) {
        let deadline = Instant::now() + limit;
        let mut text = String::new();
        let mut events = Vec::new();
        while Instant::now() < deadline {
            let (kind, payload) = self.h().read_frame();
            if kind == FRAME_KIND_STREAM && u32::from_le_bytes(payload[0..4].try_into().unwrap()) == sid {
                text.push_str(&String::from_utf8_lossy(&payload[8..]));
            } else if kind == FRAME_KIND_CONTROL {
                if let Ok(r) = decode_response(&payload) {
                    events.push(r);
                }
            }
            if done(&text, &events) {
                return (text, events);
            }
        }
        panic!("timed out; saw: {text:?} {events:?}");
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        if let Some(h) = self.h.take() {
            h.shutdown();
        }
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn field(text: &str, key: &str) -> String {
    let start = text.find(&format!("{key}=")).unwrap_or_else(|| panic!("no {key} in {text:?}")) + key.len() + 1;
    text[start..].split(|c: char| c.is_whitespace()).next().unwrap_or("").to_string()
}

const TWO_SECRET_PROMPTS: &str = r#"
my ($p1, $r1) = ask("user\@host's password: ");
print "R1=$r1 H1=" . digest($p1) . " DONE1\n";
my ($p2, $r2) = ask("user\@host's password: ");
print "R2=$r2 DONE2\n";
sleep 5;
"#;

#[test]
fn the_first_secret_prompt_gets_the_saved_credential_and_a_second_stops_ssh_before_it_can_send_an_empty_password() {
    let mut f = Fixture::new("two", &[]);
    let sid = f.open(TWO_SECRET_PROMPTS, true);
    let (text, events) = f.drive(sid, Duration::from_secs(20), |t, e| {
        t.contains("DONE1") && e.iter().any(|r| matches!(r, Response::SshCredentialRejected { .. })) && e.iter().any(|r| matches!(r, Response::SessionClosed { .. }))
    });
    assert_eq!(field(&text, "R1"), "0", "{text}");
    assert_eq!(field(&text, "H1"), SECRET_DIGEST, "the askpass answer is not the saved secret");
    // The second prompt is never answered, not even with a failure that OpenSSH would turn into an empty password.
    assert!(!text.contains("DONE2"), "ssh must be stopped before it continues past the second prompt: {text}");
    assert_eq!(events.iter().filter(|r| matches!(r, Response::SshCredentialRejected { session_id } if *session_id == sid)).count(), 1);
    assert!(!text.contains(SECRET), "the secret appeared on the terminal");
    assert!(!f.h().stderr_text().contains(SECRET));
}

#[test]
fn a_confirmation_goes_to_the_user_and_the_answer_is_returned_once_and_never_stored() {
    let mut f = Fixture::new("confirm", &[]);
    let script = r#"my ($a, $r) = ask("Are you sure you want to continue connecting (yes/no/[fingerprint])? ", "confirm"); print "A=[" . ($a // "") . "] R=$r DONE\n"; sleep 1;"#;
    let sid = f.open(script, true);
    let (_t, events) = f.drive(sid, Duration::from_secs(20), |_, e| e.iter().any(|r| matches!(r, Response::SshPrompt { .. })));
    let Some(Response::SshPrompt { session_id, prompt_id, text, kind }) = events.into_iter().find(|r| matches!(r, Response::SshPrompt { .. })) else { unreachable!() };
    assert_eq!((session_id, kind.as_str()), (sid, "confirm"));
    assert!(text.contains("Are you sure"));
    f.h().send(&Request::SshPromptAnswer { id: 30, session_id: sid, prompt_id, answer: Some("yes".into()) });
    let (text, _) = f.drive(sid, Duration::from_secs(20), |t, _| t.contains("DONE"));
    assert!(text.contains("A=[yes] R=0"), "{text}");
    // The prompt is gone: answering it again is refused.
    f.h().send(&Request::SshPromptAnswer { id: 31, session_id: sid, prompt_id, answer: Some("yes".into()) });
    assert!(matches!(f.h().read_reply(31), Response::Error { code, .. } if code == "no_pending_prompt"));
}

#[test]
fn a_cancelled_prompt_makes_askpass_fail() {
    let mut f = Fixture::new("cancel", &[]);
    let script = r#"my ($a, $r) = ask("Continue?", "confirm"); print "A=[" . ($a // "") . "] R=$r DONE\n"; sleep 1;"#;
    let sid = f.open(script, true);
    let (_t, events) = f.drive(sid, Duration::from_secs(20), |_, e| e.iter().any(|r| matches!(r, Response::SshPrompt { .. })));
    let Some(Response::SshPrompt { prompt_id, .. }) = events.into_iter().find(|r| matches!(r, Response::SshPrompt { .. })) else { unreachable!() };
    f.h().send(&Request::SshPromptAnswer { id: 30, session_id: sid, prompt_id, answer: None });
    let (text, _) = f.drive(sid, Duration::from_secs(20), |t, _| t.contains("DONE"));
    assert!(text.contains("A=[] R=1"), "{text}");
}

#[test]
fn an_unanswered_prompt_times_out_and_askpass_fails() {
    let mut f = Fixture::new("timeout", &[("REMOTE_HUB_ASKPASS_UI_TIMEOUT_MS", "1500")]);
    let script = r#"my ($a, $r) = ask("Continue?", "confirm"); print "A=[" . ($a // "") . "] R=$r DONE\n"; sleep 1;"#;
    let started = Instant::now();
    let sid = f.open(script, true);
    let (text, events) = f.drive(sid, Duration::from_secs(20), |t, e| t.contains("DONE") && e.iter().any(|r| matches!(r, Response::SshPromptExpired { .. })));
    assert!(text.contains("R=1"), "{text}");
    assert!(started.elapsed() < Duration::from_secs(15));
    // The page is told, so it can close the dialog.
    let prompt = events.iter().find_map(|r| match r { Response::SshPrompt { prompt_id, .. } => Some(*prompt_id), _ => None });
    assert!(events.iter().any(|r| matches!(r, Response::SshPromptExpired { session_id, prompt_id } if *session_id == sid && Some(*prompt_id) == prompt)), "{events:?}");
}

#[test]
fn a_wrong_nonce_and_a_process_that_is_not_the_ssh_child_are_both_refused() {
    let mut f = Fixture::new("peer", &[]);
    let script = r#"
print "SOCK=$ENV{REMOTE_HUB_ASKPASS_SOCKET} NONCE=$ENV{REMOTE_HUB_ASKPASS_NONCE} ASKPASS=$ENV{SSH_ASKPASS} REQ=$ENV{SSH_ASKPASS_REQUIRE}\n";
{ local $ENV{REMOTE_HUB_ASKPASS_NONCE} = "wrong"; my ($o, $r) = ask("p"); print "WRONG=$r\n"; }
sleep 6;
"#;
    let sid = f.open(script, true);
    let (text, _) = f.drive(sid, Duration::from_secs(20), |t, _| t.contains("WRONG="));
    assert_eq!(field(&text, "WRONG"), "1", "{text}");
    assert_eq!(field(&text, "REQ"), "force");
    let socket = field(&text, "SOCK");
    let nonce = field(&text, "NONCE");
    let askpass = field(&text, "ASKPASS");

    // The socket is 0600 in a 0700 directory; the askpass program is a symlink to the helper by absolute path.
    let mode = |p: &str| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode(&socket), 0o600);
    assert_eq!(mode(std::path::Path::new(&socket).parent().unwrap().to_str().unwrap()), 0o700);
    let target = std::fs::read_link(&askpass).unwrap();
    assert!(target.is_absolute(), "the askpass target must be an absolute path: {target:?}");
    assert!(target.file_name().unwrap().to_string_lossy().starts_with("remote-hub-helper"));
    assert_eq!(std::path::Path::new(&askpass).file_name().unwrap(), "remote-hub-askpass");

    // This test process holds the right nonce and the right uid, but is not the ssh child.
    let mut stream = UnixStream::connect(&socket).unwrap();
    stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
    stream.write_all(format!("{{\"nonce\":\"{nonce}\",\"prompt\":\"user@host's password: \",\"kind\":\"\"}}\n").as_bytes()).unwrap();
    let mut reply = String::new();
    let _ = stream.read_to_string(&mut reply);
    assert!(reply.contains("deny"), "an outsider with the nonce must be denied, got {reply:?}");
    assert!(!reply.contains("stored"));
}

#[test]
fn the_nonce_is_burned_by_the_first_secret_so_an_outsider_replay_after_it_also_fails() {
    let mut f = Fixture::new("replay", &[]);
    let script = r#"
print "SOCK=$ENV{REMOTE_HUB_ASKPASS_SOCKET} NONCE=$ENV{REMOTE_HUB_ASKPASS_NONCE}\n";
my ($p, $r) = ask("user\@host's password: "); print "FIRST=$r DONE1\n";
sleep 6;
"#;
    let sid = f.open(script, true);
    let (text, _) = f.drive(sid, Duration::from_secs(20), |t, _| t.contains("DONE1"));
    assert_eq!(field(&text, "FIRST"), "0");
    let mut stream = UnixStream::connect(field(&text, "SOCK")).unwrap();
    stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
    stream.write_all(format!("{{\"nonce\":\"{}\",\"prompt\":\"user@host's password: \",\"kind\":\"\"}}\n", field(&text, "NONCE")).as_bytes()).unwrap();
    let mut reply = String::new();
    let _ = stream.read_to_string(&mut reply);
    assert!(!reply.contains("stored"), "a burned nonce must not release the credential again: {reply:?}");
}

#[test]
fn a_session_without_a_saved_credential_has_no_askpass_at_all() {
    let mut f = Fixture::new("none", &[]);
    let sid = f.open(r#"print "ASK=[" . ($ENV{SSH_ASKPASS} // "unset") . "] SOCK=[" . ($ENV{REMOTE_HUB_ASKPASS_SOCKET} // "unset") . "] DONE\n"; sleep 1;"#, false);
    let (text, _) = f.drive(sid, Duration::from_secs(20), |t, _| t.contains("DONE"));
    assert!(text.contains("ASK=[unset] SOCK=[unset]"), "{text}");
}

#[test]
fn a_keychain_that_locks_after_the_open_stops_ssh_before_any_empty_password_and_is_reported_as_the_keychain() {
    let mut f = Fixture::new("locked", &[]);
    // The session asks only after a pause, so the Keychain can be locked between the open and the prompt.
    let script = r#"
sleep 2;
my ($p, $r) = ask("user\@host's password: ");
print "R1=$r DONE1\n";
sleep 5;
"#;
    let sid = f.open(script, true);
    let status = std::process::Command::new("/usr/bin/security").arg("lock-keychain").arg(&f.path).status().unwrap();
    assert!(status.success());
    let (text, events) = f.drive(sid, Duration::from_secs(20), |_, e| e.iter().any(|r| matches!(r, Response::SessionClosed { .. })));
    assert!(events.iter().any(|r| matches!(r, Response::SshCredentialFailed { code, .. } if code == "keychain_locked")), "{events:?}");
    assert!(!events.iter().any(|r| matches!(r, Response::SshCredentialRejected { .. })), "a locked Keychain must not be reported as a rejected password");
    // ssh was stopped BEFORE askpass answered: it never got to go on (OpenSSH would send an empty password).
    assert!(!text.contains("DONE1"), "ssh went on after a failed askpass: {text}");
}

#[test]
fn a_locked_keychain_refuses_the_open_itself_with_its_code() {
    let mut f = Fixture::new("lockedopen", &[]);
    let status = std::process::Command::new("/usr/bin/security").arg("lock-keychain").arg(&f.path).status().unwrap();
    assert!(status.success());
    f.h().send(&Request::OpenSsh {
        id: 60,
        cols: 80,
        rows: 24,
        program: "/usr/bin/perl".into(),
        argv: vec!["perl".into(), "-e".into(), "1".into()],
        env: HashMap::new(),
        cwd: None,
        askpass: Some(AskpassSpec { credential_ref: REF.into(), test_facts: Some(facts()) }),
    });
    assert!(matches!(f.h().read_reply(60), Response::Error { code, .. } if code == "keychain_locked"));
}

#[test]
fn a_reference_that_is_not_ours_is_refused_at_open() {
    let mut f = Fixture::new("badref", &[]);
    f.h().send(&Request::OpenSsh {
        id: 40,
        cols: 80,
        rows: 24,
        program: "/usr/bin/perl".into(),
        argv: vec!["perl".into(), "-e".into(), "1".into()],
        env: HashMap::new(),
        cwd: None,
        askpass: Some(AskpassSpec { credential_ref: "login".into(), test_facts: Some(facts()) }),
    });
    assert!(matches!(f.h().read_reply(40), Response::Error { code, .. } if code == "invalid_credential_ref"));
}

#[test]
fn a_host_key_question_with_an_empty_prompt_kind_goes_to_the_user_and_the_saved_secret_is_not_spent() {
    // OpenSSH 10 leaves SSH_ASKPASS_PROMPT empty for the host-key question; it is NOT a password prompt.
    let mut f = Fixture::new("hostkey", &[]);
    let script = r#"
my ($a, $r) = ask("The authenticity of host 'h' can't be established.\nED25519 key fingerprint is: SHA256:x\nAre you sure you want to continue connecting (yes/no/[fingerprint])? ");
print "A=[" . ($a // "") . "] R=$r DONE1\n";
my ($p, $r2) = ask("user\@host's password: ");
print "H=" . digest($p) . " R=$r2 DONE2\n";
sleep 1;
"#;
    let sid = f.open(script, true);
    let (_, events) = f.drive(sid, Duration::from_secs(20), |_, ev| ev.iter().any(|r| matches!(r, Response::SshPrompt { .. })));
    let Some(Response::SshPrompt { prompt_id, kind, text, .. }) = events.into_iter().find(|r| matches!(r, Response::SshPrompt { .. })) else { unreachable!() };
    assert_eq!(kind, "confirm");
    assert!(text.contains("continue connecting"));
    f.h().send(&Request::SshPromptAnswer { id: 40, session_id: sid, prompt_id, answer: Some("yes".into()) });
    let (text, _) = f.drive(sid, Duration::from_secs(20), |t, _| t.contains("DONE2"));
    assert_eq!(field(&text, "A"), "[yes]");
    assert_eq!(field(&text, "R"), "0");
    // The password prompt after it still gets the saved secret: the question did not burn the nonce.
    assert_eq!(field(&text, "H"), SECRET_DIGEST, "{text}");
}

#[test]
fn an_ambiguous_secret_prompt_is_asked_of_the_user_and_never_answered_from_the_keychain() {
    let mut f = Fixture::new("ambiguous", &[]);
    let script = r#"
my ($a, $r) = ask("Verification code: ");
print "A=[" . ($a // "") . "] R=$r DONE\n";
sleep 1;
"#;
    let sid = f.open(script, true);
    let (_, events) = f.drive(sid, Duration::from_secs(20), |_, ev| ev.iter().any(|r| matches!(r, Response::SshPrompt { .. })));
    let Some(Response::SshPrompt { prompt_id, kind, .. }) = events.into_iter().find(|r| matches!(r, Response::SshPrompt { .. })) else { unreachable!() };
    assert_eq!(kind, "secret");
    f.h().send(&Request::SshPromptAnswer { id: 41, session_id: sid, prompt_id, answer: Some("123456".into()) });
    let (text, _) = f.drive(sid, Duration::from_secs(20), |t, _| t.contains("DONE"));
    assert_eq!(field(&text, "A"), "[123456]");
    assert!(!text.contains(SECRET_DIGEST));
}

#[test]
fn look_alike_password_and_passphrase_prompts_from_a_server_never_receive_the_saved_secret() {
    // Keyboard-interactive text is chosen by the server. Both shapes, for another user and another key,
    // arrive with an empty prompt kind: neither is the prompt this session expects.
    let mut f = Fixture::new("lookalike", &[]);
    let script = r#"
my ($a, $r) = ask("Enter passphrase for key '/tmp/not-my-key': ");
print "A=[" . ($a // "") . "] R=$r DONE1\n";
my ($b, $r2) = ask("admin\@host's password: ");
print "B=[" . ($b // "") . "] R=$r2 DONE2\n";
my ($c, $r3) = ask("user\@host's password: ");
print "H=" . digest($c) . " R=$r3 DONE3\n";
sleep 1;
"#;
    let sid = f.open(script, true);
    let mut seen = String::new();
    for (n, answer) in [(51u64, "typed-one"), (52, "typed-two")] {
        let (part, events) = f.drive(sid, Duration::from_secs(20), |_, ev| ev.iter().any(|r| matches!(r, Response::SshPrompt { .. })));
        let Some(Response::SshPrompt { prompt_id, kind, .. }) = events.into_iter().filter(|r| matches!(r, Response::SshPrompt { .. })).last() else { unreachable!() };
        seen.push_str(&part);
        assert_eq!(kind, "secret", "a look-alike must be asked of the user");
        f.h().send(&Request::SshPromptAnswer { id: n, session_id: sid, prompt_id, answer: Some(answer.into()) });
    }
    let (rest, _) = f.drive(sid, Duration::from_secs(20), |t, _| t.contains("DONE3"));
    let text = format!("{seen}{rest}");
    assert_eq!(field(&text, "A"), "[typed-one]");
    assert_eq!(field(&text, "B"), "[typed-two]");
    // The nonce was not spent on the strangers: the REAL expected prompt still gets the saved secret.
    assert_eq!(field(&text, "H"), SECRET_DIGEST, "{text}");
}

/// Opens a REAL-shaped ssh session (program /usr/bin/ssh); every case here is refused before anything is spawned.
fn open_real_shaped(f: &mut Fixture, id: u64, argv: &[&str]) -> Response {
    f.h().send(&Request::OpenSsh {
        id,
        cols: 80,
        rows: 24,
        program: "/usr/bin/ssh".into(),
        argv: argv.iter().map(|s| s.to_string()).collect(),
        env: HashMap::new(),
        cwd: None,
        askpass: Some(AskpassSpec { credential_ref: REF.into(), test_facts: None }),
    });
    f.h().read_reply(id)
}

fn error_code(r: Response) -> String {
    match r {
        Response::Error { code, .. } => code,
        other => panic!("expected an error, got {other:?}"),
    }
}

/// S4: a session with a saved secret is refused unless its argv carries everything that decides where the secret goes.
#[test]
fn an_askpass_session_without_the_fixed_method_user_or_key_and_no_config_is_refused() {
    let mut f = Fixture::new("s4", &[]);
    let ok = ["ssh", "-tt", "-l", "user", "-F", "none", "-o", "PreferredAuthentications=password", "-o", "NumberOfPasswordPrompts=2", "--", "host"];
    let drop_pair = |pair: [&str; 2]| -> Vec<&str> {
        let mut v = ok.to_vec();
        let pos = v.windows(2).position(|w| w == pair).unwrap();
        v.drain(pos..pos + 2);
        v
    };
    let mut id = 100;
    for pair in [["-l", "user"], ["-F", "none"], ["-o", "PreferredAuthentications=password"], ["-o", "NumberOfPasswordPrompts=2"]] {
        id += 1;
        assert_eq!(error_code(open_real_shaped(&mut f, id, &drop_pair(pair))), "ssh_option_rejected", "without {pair:?}");
    }
    // An option that would let keyboard-interactive back in is refused by the validator itself.
    id += 1;
    let mut v = ok.to_vec();
    v.splice(10..10, ["-o", "PreferredAuthentications=keyboard-interactive"]);
    assert_eq!(error_code(open_real_shaped(&mut f, id, &v)), "ssh_option_rejected");
    // A key session needs -i + IdentitiesOnly + IdentityAgent=none.
    let key = ["ssh", "-tt", "-F", "none", "-o", "PreferredAuthentications=publickey", "-o", "NumberOfPasswordPrompts=2", "--", "host"];
    id += 1;
    assert_eq!(error_code(open_real_shaped(&mut f, id, &key)), "ssh_option_rejected");
}

/// S2: the binding stored with the secret must equal what the session's own argv says it will do.
#[test]
fn a_saved_password_is_refused_for_a_session_that_goes_elsewhere() {
    let mut f = Fixture::new("s2", &[]); // saved for ssh user@host:22
    let base = |user: &str, port: &str, host: &str| -> Vec<String> {
        ["ssh", "-tt", "-l", user, "-p", port, "-F", "none", "-o", "PreferredAuthentications=password", "-o", "NumberOfPasswordPrompts=2", "--", host].iter().map(|s| s.to_string()).collect()
    };
    let mut id = 200;
    for (what, argv) in [
        ("user", base("other", "22", "host")),
        ("port", base("user", "2222", "host")),
        ("host", base("user", "22", "elsewhere.example.test")),
        (
            "kind: a key session for a password item",
            ["ssh", "-tt", "-F", "none", "-i", "/k/id", "-o", "IdentitiesOnly=yes", "-o", "IdentityAgent=none", "-o", "PreferredAuthentications=publickey", "-o", "NumberOfPasswordPrompts=2", "--", "host"].iter().map(|s| s.to_string()).collect(),
        ),
    ] {
        id += 1;
        let refs: Vec<&str> = argv.iter().map(String::as_str).collect();
        assert_eq!(error_code(open_real_shaped(&mut f, id, &refs)), "credential_target_mismatch", "{what}");
    }
}

/// S2 (key): a passphrase item is for one key file; another path, or a password session, is refused.
#[test]
fn a_saved_passphrase_is_refused_for_another_key_file_or_a_password_session() {
    let mut f = Fixture::new("s2key", &[]);
    f.h().send(&Request::CredentialSave { id: 300, reference: REF.into(), secret: Secret::new(SECRET), bind: Bind::Key { path: "/k/id".into() } });
    assert!(matches!(f.h().read_reply(300), Response::CredentialOk { .. }));
    let key = |path: &str| -> Vec<String> {
        ["ssh", "-tt", "-F", "none", "-i", path, "-o", "IdentitiesOnly=yes", "-o", "IdentityAgent=none", "-o", "PreferredAuthentications=publickey", "-o", "NumberOfPasswordPrompts=2", "--", "host"].iter().map(|s| s.to_string()).collect()
    };
    assert_eq!(error_code(open_real_shaped(&mut f, 301, &key("/k/other").iter().map(String::as_str).collect::<Vec<_>>())), "credential_target_mismatch");
    let pw: Vec<String> = ["ssh", "-tt", "-l", "user", "-F", "none", "-o", "PreferredAuthentications=password", "-o", "NumberOfPasswordPrompts=2", "--", "host"].iter().map(|s| s.to_string()).collect();
    assert_eq!(error_code(open_real_shaped(&mut f, 302, &pw.iter().map(String::as_str).collect::<Vec<_>>())), "credential_target_mismatch");
}

/// S3: the askpass client believes only the helper that started its ssh.
#[test]
fn the_askpass_client_refuses_a_socket_that_is_not_the_helpers() {
    use std::io::Read;
    use std::os::unix::fs::{symlink, DirBuilderExt, PermissionsExt};
    use std::os::unix::net::UnixListener;
    let dir = std::env::temp_dir().join(format!("rh-ask-{}-imposter", std::process::id()));
    std::fs::DirBuilder::new().mode(0o700).create(&dir).unwrap();
    let link = dir.join("remote-hub-askpass");
    symlink(env!("CARGO_BIN_EXE_remote-hub-helper"), &link).unwrap();
    let run = |socket: &std::path::Path| {
        std::process::Command::new(&link)
            .arg("password: ")
            .env("REMOTE_HUB_ASKPASS_SOCKET", socket)
            .env("REMOTE_HUB_ASKPASS_NONCE", "n")
            .stdout(std::process::Stdio::piped())
            .output()
            .unwrap()
    };
    // 1. A private socket of ours that is NOT the helper: the client connects, sees the peer is not its
    //    grandparent, and sends nothing.
    let socket = dir.join("s");
    let listener = UnixListener::bind(&socket).unwrap();
    std::fs::set_permissions(&socket, std::fs::Permissions::from_mode(0o600)).unwrap();
    listener.set_nonblocking(false).unwrap();
    let accept = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        // macOS answers EINVAL to SO_RCVTIMEO once the peer (the client, which refuses and exits at once)
        // has already gone: the timeout is a safety net only, so a refusal to set it is not an error.
        let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
        let mut got = Vec::new();
        let _ = stream.read_to_end(&mut got);
        got
    });
    let out = run(&socket);
    assert_eq!(out.status.code(), Some(1));
    assert!(out.stdout.is_empty());
    assert!(accept.join().unwrap().is_empty(), "the imposter must receive nothing, not even the nonce");
    // 2. A socket open to everyone is not trusted at all: the client does not even connect.
    let open = dir.join("open");
    let l2 = UnixListener::bind(&open).unwrap();
    std::fs::set_permissions(&open, std::fs::Permissions::from_mode(0o666)).unwrap();
    l2.set_nonblocking(true).unwrap();
    assert_eq!(run(&open).status.code(), Some(1));
    assert!(l2.accept().is_err(), "the client must not connect to a world-writable socket");
    let _ = std::fs::remove_dir_all(&dir);
}

/// T2: a secret with non-ASCII characters reaches the program ssh would read it from byte for byte
/// (a reply read one byte at a time and turned into chars would make "é" into "Ã©").
#[test]
fn a_non_ascii_password_and_passphrase_arrive_byte_for_byte() {
    // SHA-256 of the UTF-8 bytes, first 16 hex, computed outside this test.
    let (pw, pw_digest) = ("pässwörd-é€-ASK-1", "00f298c5129e85b3");
    let mut f = Fixture::new_secret("utf8pw", pw);
    let sid = f.open(r#"my ($p, $r) = ask("user\@host's password: "); print "H=" . digest($p) . " R=$r DONE\n"; sleep 1;"#, true);
    let (text, _) = f.drive(sid, Duration::from_secs(20), |t, _| t.contains("DONE"));
    assert_eq!(field(&text, "H"), pw_digest, "the password was altered on its way: {text}");
    drop(f);

    let (phrase, phrase_digest) = ("Pässphräse-ü€-ASK-2", "b6cc2b2a505c0f64");
    let key_facts = SshFacts { host: "host".into(), port: 22, user: None, identity: Some("/k/id".into()), method: AuthMethod::PublicKey };
    let mut f = Fixture::with("utf8key", &[], phrase, Bind::Key { path: "/k/id".into() }, key_facts);
    let sid = f.open(r#"my ($p, $r) = ask("Enter passphrase for key '/k/id': "); print "H=" . digest($p) . " R=$r DONE\n"; sleep 1;"#, true);
    let (text, _) = f.drive(sid, Duration::from_secs(20), |t, _| t.contains("DONE"));
    assert_eq!(field(&text, "H"), phrase_digest, "the passphrase was altered on its way: {text}");
}

/// T3: a session with a saved secret takes no caller-chosen host-key file, no URI destination, and
/// (for a password) no key.
#[test]
fn a_saved_secret_session_refuses_a_caller_chosen_known_hosts_file_a_uri_destination_and_a_key_for_a_password() {
    let mut f = Fixture::new("t3", &[]);
    let pw = |extra: &[&str], host: &str| -> Vec<String> {
        let mut v: Vec<String> = ["ssh", "-tt", "-l", "user", "-F", "none"].iter().map(|s| s.to_string()).collect();
        v.extend(extra.iter().map(|s| s.to_string()));
        v.extend(["-o", "PreferredAuthentications=password", "-o", "NumberOfPasswordPrompts=2", "--", host].iter().map(|s| s.to_string()));
        v
    };
    let as_refs = |v: &Vec<String>| v.iter().map(String::as_str).map(str::to_string).collect::<Vec<_>>();
    let _ = as_refs;
    let mut id = 400;
    for (what, argv) in [
        ("UserKnownHostsFile", pw(&["-o", "UserKnownHostsFile=/tmp/kh"], "host")),
        ("a key for a password session", pw(&["-i", "/k/id", "-o", "IdentitiesOnly=yes"], "host")),
        ("a URI destination", pw(&[], "ssh://user@host")),
        ("a destination with a path", pw(&[], "host/path")),
    ] {
        id += 1;
        let refs: Vec<&str> = argv.iter().map(String::as_str).collect();
        assert_eq!(error_code(open_real_shaped(&mut f, id, &refs)), "ssh_option_rejected", "{what}");
    }
}

/// T1: OpenSSH lowercases the host it prints in the prompt, so the binding, the argv and the expected
/// prompt use the lower-case form: a mixed-case name still gets the saved password.
#[test]
fn a_mixed_case_host_is_bound_and_prompted_in_lower_case() {
    let mixed = SshFacts { host: "box.example.test".into(), port: 22, user: Some("User".into()), identity: None, method: AuthMethod::Password };
    // The binding was saved from "Box.Example.TEST" (the helper stores the lower-case form).
    let bind = Bind::Endpoint { protocol: "ssh".into(), host: "Box.Example.TEST".into(), port: 22, user: Some("User".into()), domain: None, cert: None };
    let mut f = Fixture::with("t1", &[], SECRET, bind, mixed);
    let sid = f.open(r#"my ($p, $r) = ask("User\@box.example.test's password: "); print "H=" . digest($p) . " R=$r DONE\n"; sleep 1;"#, true);
    let (text, _) = f.drive(sid, Duration::from_secs(20), |t, _| t.contains("DONE"));
    assert_eq!(field(&text, "H"), SECRET_DIGEST, "{text}");
}

/// Y3: while one session is deciding a server's first host key, a second saved-secret open to the same host:port is
/// refused (it would copy an overlay that does not have the key yet and could be shown a DIFFERENT key as unknown).
#[test]
fn a_second_open_to_a_server_whose_first_host_key_is_being_decided_is_refused_until_the_first_ends() {
    let kh_dir = std::env::temp_dir().join(format!("rh-ask-kh-{}", std::process::id()));
    std::os::unix::fs::DirBuilderExt::mode(&mut std::fs::DirBuilder::new(), 0o700).create(&kh_dir).unwrap();
    let kh = kh_dir.join("known_hosts");
    let mut f = Fixture::new("y3", &[("REMOTE_HUB_KNOWN_HOSTS_PATH", kh.to_str().unwrap())]);
    let try_open = |f: &mut Fixture, id: u64| {
        let facts = f.facts.clone();
        let mut env = HashMap::new();
        env.insert("PATH".to_string(), "/usr/bin:/bin".to_string());
        f.h().send(&Request::OpenSsh {
            id,
            cols: 80,
            rows: 24,
            program: "/usr/bin/perl".into(),
            argv: vec!["perl".into(), "-e".into(), "sleep 60;".into()],
            env,
            cwd: None,
            askpass: Some(AskpassSpec { credential_ref: REF.into(), test_facts: Some(facts) }),
        });
        f.h().read_reply(id)
    };
    let first = try_open(&mut f, 20);
    let Response::SessionOpened { session_id: first_id, .. } = first else { panic!("first open: {first:?}") };
    // Same host and port: refused with its own code, and nothing was started.
    assert_eq!(error_code(try_open(&mut f, 21)), "host_key_confirmation_pending");
    // When the first session ends the hold ends with it.
    f.h().send(&Request::SessionClose { id: 24, session_id: first_id });
    let _ = f.h().read_reply(24);
    assert!(matches!(try_open(&mut f, 25), Response::SessionOpened { .. }));
    let _ = std::fs::remove_dir_all(&kh_dir);
}

/// Y3: a server whose key the overlay already holds is not serialised: any number of sessions may open.
#[test]
fn a_server_with_a_key_in_the_overlay_is_not_held() {
    let kh_dir = std::env::temp_dir().join(format!("rh-ask-kh2-{}", std::process::id()));
    std::os::unix::fs::DirBuilderExt::mode(&mut std::fs::DirBuilder::new(), 0o700).create(&kh_dir).unwrap();
    let kh = kh_dir.join("known_hosts");
    std::fs::write(&kh, "host ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n").unwrap();
    std::fs::set_permissions(&kh, std::os::unix::fs::PermissionsExt::from_mode(0o600)).unwrap();
    let mut f = Fixture::new("y3b", &[("REMOTE_HUB_KNOWN_HOSTS_PATH", kh.to_str().unwrap())]);
    for id in [30u64, 31, 32] {
        let facts = f.facts.clone();
        let mut env = HashMap::new();
        env.insert("PATH".to_string(), "/usr/bin:/bin".to_string());
        f.h().send(&Request::OpenSsh {
            id,
            cols: 80,
            rows: 24,
            program: "/usr/bin/perl".into(),
            argv: vec!["perl".into(), "-e".into(), "sleep 60;".into()],
            env,
            cwd: None,
            askpass: Some(AskpassSpec { credential_ref: REF.into(), test_facts: Some(facts) }),
        });
        assert!(matches!(f.h().read_reply(id), Response::SessionOpened { .. }), "open {id}");
    }
    let _ = std::fs::remove_dir_all(&kh_dir);
}
