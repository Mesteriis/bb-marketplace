//! Production-mode (no test-hooks) helper tests. This file only compiles when
//! test-hooks is off, so it exercises the same validation the release binary
//! (npm run build:helper) enforces.
#![cfg(not(feature = "test-hooks"))]

use std::collections::HashMap;
use std::io::{Read, Write};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};

use remote_hub_helper::protocol::{
    decode_response, encode_request, Request, Response, FRAME_KIND_CONTROL, PROTOCOL_VERSION,
};

fn start() -> (Child, ChildStdin, ChildStdout) {
    let mut child = Command::new(env!("CARGO_BIN_EXE_remote-hub-helper"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .expect("spawn helper");
    let stdin = child.stdin.take().expect("helper stdin");
    let stdout = child.stdout.take().expect("helper stdout");
    (child, stdin, stdout)
}

fn send_req(stdin: &mut ChildStdin, req: &Request) {
    stdin.write_all(&encode_request(req)).expect("write request");
    stdin.flush().expect("flush request");
}

fn read_frame(stdout: &mut ChildStdout) -> (u8, Vec<u8>) {
    let mut header = [0u8; 4];
    stdout.read_exact(&mut header).expect("read header");
    let len = u32::from_le_bytes(header) as usize;
    let mut body = vec![0u8; len];
    stdout.read_exact(&mut body).expect("read body");
    (body[0], body[1..].to_vec())
}

fn read_response(stdout: &mut ChildStdout) -> Response {
    loop {
        let (kind, payload) = read_frame(stdout);
        if kind == FRAME_KIND_CONTROL {
            return decode_response(&payload).expect("decode response");
        }
    }
}

#[test]
fn production_rejects_freeform_open_ssh() {
    let (mut child, mut stdin, mut stdout) = start();
    send_req(&mut stdin, &Request::Hello {
        protocol: PROTOCOL_VERSION,
    });
    match read_response(&mut stdout) {
        Response::HelloAck { .. } => {}
        other => panic!("expected hello_ack, got {other:?}"),
    }

    let cases: Vec<(&str, Vec<&str>)> = vec![
        ("/bin/sh", vec!["sh", "-tt", "--", "example.com"]),
        ("/usr/bin/ssh", vec!["ssh", "-tt", "-oProxyCommand=evil", "--", "example.com"]),
        ("/usr/bin/ssh", vec!["ssh", "-tt", "-o", "StrictHostKeyChecking=no", "--", "example.com"]),
        ("/usr/bin/ssh", vec!["ssh", "-tt", "-A", "--", "example.com"]),
        ("/usr/bin/ssh", vec!["ssh", "-tt", "-L", "8080:localhost:80", "--", "example.com"]),
    ];
    for (program, argv) in cases {
        send_req(&mut stdin, &Request::OpenSsh {
            id: 1,
            cols: 80,
            rows: 24,
            program: program.to_string(),
            argv: argv.iter().map(|s| s.to_string()).collect(),
            env: HashMap::new(),
            cwd: None,
            askpass: None,
        });
        match read_response(&mut stdout) {
            Response::Error { code, .. } => assert_eq!(code, "ssh_option_rejected"),
            other => panic!("expected ssh_option_rejected, got {other:?}"),
        }
    }

    drop(stdin);
    let _ = child.kill();
    let _ = child.wait();
}

#[test]
fn production_rejects_freeform_and_misshapen_exec_runs_and_needs_a_saved_credential() {
    let (mut child, mut stdin, mut stdout) = start();
    send_req(&mut stdin, &Request::Hello { protocol: PROTOCOL_VERSION });
    match read_response(&mut stdout) {
        Response::HelloAck { .. } => {}
        other => panic!("expected hello_ack, got {other:?}"),
    }
    let long = "x".repeat(9000);
    let cases: Vec<(&str, Vec<String>, &str)> = vec![
        // not ssh at all
        ("/bin/sh", ["sh", "-T", "--", "h", "id"].map(String::from).to_vec(), "ssh_option_rejected"),
        // a pty shape, an option ssh must not get, a missing or empty command, an over-long one, two command words
        ("/usr/bin/ssh", ["ssh", "-tt", "--", "h", "id"].map(String::from).to_vec(), "ssh_option_rejected"),
        ("/usr/bin/ssh", ["ssh", "-T", "-oProxyCommand=evil", "--", "h", "id"].map(String::from).to_vec(), "ssh_option_rejected"),
        ("/usr/bin/ssh", ["ssh", "-T", "--", "h"].map(String::from).to_vec(), "ssh_option_rejected"),
        ("/usr/bin/ssh", ["ssh", "-T", "--", "h", ""].map(String::from).to_vec(), "ssh_option_rejected"),
        ("/usr/bin/ssh", vec!["ssh".to_string(), "-T".to_string(), "--".to_string(), "h".to_string(), long], "ssh_option_rejected"),
        ("/usr/bin/ssh", ["ssh", "-T", "--", "h", "ls", "-la"].map(String::from).to_vec(), "ssh_option_rejected"),
        // a well-formed run still needs a saved credential: no question can be answered
        ("/usr/bin/ssh", ["ssh", "-T", "-F", "none", "-l", "u", "-p", "22", "-o", "PreferredAuthentications=password", "-o", "NumberOfPasswordPrompts=2", "--", "example.com", "id"].map(String::from).to_vec(), "needs_saved_credential"),
    ];
    for (i, (program, argv, code)) in cases.into_iter().enumerate() {
        send_req(&mut stdin, &Request::ExecRun { id: 1 + i as u64, program: program.to_string(), argv, env: HashMap::new(), askpass: None, timeout_ms: 5_000, max_bytes: 4096 });
        match read_response(&mut stdout) {
            Response::Error { code: got, .. } => assert_eq!(got, code, "case {i}"),
            other => panic!("case {i}: expected {code}, got {other:?}"),
        }
    }
    drop(stdin);
    let _ = child.kill();
    let _ = child.wait();
}

/// The keychain test hooks (a keychain chosen by path, created on demand) exist
/// only in test-hooks builds: the production binary has no such string, so no
/// environment variable can point it at another keychain. (Not exercised by
/// running it, which would touch the real login keychain.)
#[test]
fn production_binary_has_no_keychain_test_hook() {
    let bytes = std::fs::read(env!("CARGO_BIN_EXE_remote-hub-helper")).expect("read the helper binary");
    for needle in ["REMOTE_HUB_KEYCHAIN_PATH", "REMOTE_HUB_KEYCHAIN_CREATE_PASSWORD", "REMOTE_HUB_RDP_FAKE_ENGINE", "REMOTE_HUB_TEST_ANY_PARENT", "REMOTE_HUB_ASKPASS_UI_TIMEOUT_MS", "save_raw", "testFacts"] {
        assert!(!bytes.windows(needle.len()).any(|w| w == needle.as_bytes()), "{needle} is in the production binary");
    }
}
