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

/// The keychain test hooks (a keychain chosen by path, created on demand) exist
/// only in test-hooks builds: the production binary has no such string, so no
/// environment variable can point it at another keychain. (Not exercised by
/// running it, which would touch the real login keychain.)
#[test]
fn production_binary_has_no_keychain_test_hook() {
    let bytes = std::fs::read(env!("CARGO_BIN_EXE_remote-hub-helper")).expect("read the helper binary");
    for needle in ["REMOTE_HUB_KEYCHAIN_PATH", "REMOTE_HUB_KEYCHAIN_CREATE_PASSWORD", "REMOTE_HUB_RDP_FAKE_ENGINE"] {
        assert!(!bytes.windows(needle.len()).any(|w| w == needle.as_bytes()), "{needle} is in the production binary");
    }
}
