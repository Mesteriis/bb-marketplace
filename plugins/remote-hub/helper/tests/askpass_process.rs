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
use remote_hub_helper::protocol::AskpassSpec;
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
}

impl Fixture {
    fn new(tag: &str, extra_env: &[(&str, &str)]) -> Fixture {
        watchdog();
        let dir = std::env::temp_dir().join(format!("rh-ask-{}-{tag}", std::process::id()));
        std::os::unix::fs::DirBuilderExt::mode(&mut std::fs::DirBuilder::new(), 0o700).create(&dir).unwrap();
        let path = dir.join("kc.keychain-db");
        create_at(&path, "throwaway-kc-password").expect("temporary keychain");
        let mut env: Vec<(&str, &str)> = vec![("REMOTE_HUB_KEYCHAIN_PATH", path.to_str().unwrap())];
        env.extend_from_slice(extra_env);
        let mut h = start(&env);
        h.send(&Request::CredentialSave { id: 1, reference: REF.into(), secret: Secret::new(SECRET) });
        assert!(matches!(h.read_reply(1), Response::CredentialOk { .. }));
        Fixture { dir, path, h: Some(h) }
    }

    fn h(&mut self) -> &mut Helper {
        self.h.as_mut().unwrap()
    }

    /// Opens `perl -e script` as an ssh-kind session with a saved credential (or without).
    fn open(&mut self, script: &str, askpass: bool) -> u32 {
        let id = 10;
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
            askpass: askpass.then(|| AskpassSpec { credential_ref: REF.into() }),
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
my ($p2, $r2) = ask("user\@host's password: ");
print "R1=$r1 H1=" . digest($p1) . " R2=$r2 DONE\n";
sleep 1;
"#;

#[test]
fn the_first_secret_prompt_gets_the_saved_credential_and_a_second_is_refused_with_a_rejection_event() {
    let mut f = Fixture::new("two", &[]);
    let sid = f.open(TWO_SECRET_PROMPTS, true);
    let (text, events) = f.drive(sid, Duration::from_secs(20), |t, e| t.contains("DONE") && e.iter().any(|r| matches!(r, Response::SshCredentialRejected { .. })));
    assert_eq!(field(&text, "R1"), "0", "{text}");
    assert_eq!(field(&text, "H1"), SECRET_DIGEST, "the askpass answer is not the saved secret");
    assert_eq!(field(&text, "R2"), "1", "a second attempt must be refused: {text}");
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
    let (text, _) = f.drive(sid, Duration::from_secs(20), |t, _| t.contains("DONE"));
    assert!(text.contains("R=1"), "{text}");
    assert!(started.elapsed() < Duration::from_secs(15));
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
    stream.write_all(format!("{{\"nonce\":\"{nonce}\",\"prompt\":\"pw\",\"kind\":\"\"}}\n").as_bytes()).unwrap();
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
my ($p, $r) = ask("pw: "); print "FIRST=$r DONE1\n";
sleep 6;
"#;
    let sid = f.open(script, true);
    let (text, _) = f.drive(sid, Duration::from_secs(20), |t, _| t.contains("DONE1"));
    assert_eq!(field(&text, "FIRST"), "0");
    let mut stream = UnixStream::connect(field(&text, "SOCK")).unwrap();
    stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
    stream.write_all(format!("{{\"nonce\":\"{}\",\"prompt\":\"pw\",\"kind\":\"\"}}\n", field(&text, "NONCE")).as_bytes()).unwrap();
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
fn a_locked_keychain_is_reported_as_the_keychain_not_as_a_refused_password() {
    let mut f = Fixture::new("locked", &[]);
    let status = std::process::Command::new("/usr/bin/security").arg("lock-keychain").arg(&f.path).status().unwrap();
    assert!(status.success());
    let sid = f.open(TWO_SECRET_PROMPTS, true);
    let (text, events) = f.drive(sid, Duration::from_secs(20), |t, _| t.contains("DONE"));
    assert_eq!(field(&text, "R1"), "1", "{text}");
    assert!(events.iter().any(|r| matches!(r, Response::SshCredentialFailed { code, .. } if code == "keychain_locked")), "{events:?}");
    assert!(!events.iter().any(|r| matches!(r, Response::SshCredentialRejected { .. })), "a locked Keychain must not be reported as a rejected password");
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
        askpass: Some(AskpassSpec { credential_ref: "login".into() }),
    });
    assert!(matches!(f.h().read_reply(40), Response::Error { code, .. } if code == "invalid_credential_ref"));
}
