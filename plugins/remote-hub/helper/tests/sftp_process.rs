//! SFTP channels through the real helper process. The program is `/usr/bin/perl` or the system's own `sftp-server`
//! standing in for `ssh -s sftp` (test-hooks builds run a free-form program): what is under test is the helper's channel
//! handling — bytes both ways as stream frames, order, the end of a channel, close, several channels — not OpenSSH.
mod common;

use common::*;
use remote_hub_helper::protocol::{decode_response, encode_stream, Request, Response, FRAME_KIND_CONTROL, FRAME_KIND_STREAM};
use std::collections::HashMap;
use std::io::Write;
use std::time::Duration;

fn watchdog() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        std::thread::spawn(|| {
            std::thread::sleep(Duration::from_secs(90));
            eprintln!("sftp tests: watchdog expired; aborting");
            std::process::abort();
        });
    });
}

fn open(h: &mut Helper, id: u64, program: &str, argv: &[&str]) -> u32 {
    let mut env = HashMap::new();
    env.insert("PATH".to_string(), "/usr/bin:/bin".to_string());
    h.send(&Request::SftpOpen { id, program: program.into(), argv: argv.iter().map(|s| s.to_string()).collect(), env, askpass: None });
    match h.read_reply(id) {
        Response::SftpOpened { sftp_id, .. } => sftp_id,
        other => panic!("expected sftp.opened, got {other:?}"),
    }
}

fn perl(h: &mut Helper, id: u64, script: &str) -> u32 {
    open(h, id, "/usr/bin/perl", &["perl", "-e", script])
}

fn write(h: &mut Helper, sid: u32, data: &[u8]) {
    h.stdin.write_all(&encode_stream(sid, 0, data)).expect("write stream frame");
    h.stdin.flush().expect("flush");
}

struct End {
    exit_code: Option<i32>,
    reason: String,
    stderr: String,
}

/// Reads until `want` bytes of channel `sid` arrived (in frame order) or the channel closed.
fn read_bytes(h: &mut Helper, sid: u32, want: usize) -> (Vec<u8>, Option<End>) {
    let mut got = Vec::new();
    let mut next_seq = 0u32;
    let end = h.read_until(Duration::from_secs(60), |kind, p| {
        if kind == FRAME_KIND_STREAM && u32::from_le_bytes(p[0..4].try_into().unwrap()) == sid {
            assert_eq!(u32::from_le_bytes(p[4..8].try_into().unwrap()), next_seq, "frames arrive in order");
            next_seq += 1;
            got.extend_from_slice(&p[8..]);
            return (got.len() >= want).then_some(None);
        }
        if kind == FRAME_KIND_CONTROL {
            if let Ok(Response::SftpClosed { sftp_id, exit_code, reason, stderr, .. }) = decode_response(p) {
                if sftp_id == sid {
                    return Some(Some(End { exit_code, reason, stderr }));
                }
            }
        }
        None
    });
    (got, end)
}

fn read_end(h: &mut Helper, sid: u32) -> (Vec<u8>, End) {
    let (got, end) = read_bytes(h, sid, usize::MAX);
    (got, end.expect("the channel closed"))
}

#[test]
fn bytes_sent_to_a_channel_come_back_from_its_program_binary_and_large() {
    watchdog();
    let mut h = start(&[]);
    let sid = perl(&mut h, 1, "binmode STDIN; binmode STDOUT; $| = 1; while (sysread(STDIN, my $b, 65536)) { syswrite(STDOUT, $b); }");
    let sent: Vec<u8> = (0..=255u8).cycle().take(1_500_000).collect();
    for piece in sent.chunks(200_000) {
        write(&mut h, sid, piece);
    }
    let (got, end) = read_bytes(&mut h, sid, sent.len());
    assert!(end.is_none(), "the program is still running");
    assert_eq!(got.len(), sent.len());
    assert!(got == sent, "every byte, in order");
    h.send(&Request::SftpClose { id: 2, sftp_id: sid });
    assert!(matches!(h.read_reply(2), Response::SftpClosing { .. }));
    let (_, end) = read_end(&mut h, sid);
    assert_eq!(end.reason, "closed");
    h.send(&Request::SftpClose { id: 3, sftp_id: sid });
    assert!(matches!(h.read_reply(3), Response::Error { code, .. } if code == "unknown_sftp"));
    h.shutdown();
}

#[test]
fn a_program_that_ends_reports_all_of_its_output_then_its_exit_and_the_head_of_stderr() {
    watchdog();
    let mut h = start(&[]);
    let sid = perl(&mut h, 1, r#"print "last words"; print STDERR "Host key verification failed.\n"; exit 255;"#);
    let (got, end) = read_end(&mut h, sid);
    assert_eq!(got, b"last words");
    assert_eq!((end.exit_code, end.reason.as_str()), (Some(255), "exited"));
    assert_eq!(end.stderr, "Host key verification failed.\n");
    h.shutdown();
}

#[test]
fn the_systems_sftp_server_answers_an_init_packet_through_a_channel() {
    watchdog();
    let server = "/usr/libexec/sftp-server";
    if !std::path::Path::new(server).exists() {
        eprintln!("skipped: no {server} on this machine");
        return;
    }
    let mut h = start(&[]);
    let sid = open(&mut h, 1, server, &["sftp-server", "-e"]);
    // SSH_FXP_INIT, version 3
    write(&mut h, sid, &[0, 0, 0, 5, 1, 0, 0, 0, 3]);
    let (got, end) = read_bytes(&mut h, sid, 9);
    assert!(end.is_none());
    // SSH_FXP_VERSION (2), version 3, then extension pairs
    assert_eq!((got[4], &got[5..9]), (2, &[0u8, 0, 0, 3][..]));
    h.send(&Request::SftpClose { id: 2, sftp_id: sid });
    assert!(matches!(h.read_reply(2), Response::SftpClosing { .. }));
    read_end(&mut h, sid);
    h.shutdown();
}

#[test]
fn two_channels_keep_their_bytes_apart() {
    watchdog();
    let mut h = start(&[]);
    let a = perl(&mut h, 1, r#"$| = 1; while (sysread(STDIN, my $b, 4096)) { syswrite(STDOUT, "A:$b"); }"#);
    let b = perl(&mut h, 2, r#"$| = 1; while (sysread(STDIN, my $b, 4096)) { syswrite(STDOUT, "B:$b"); }"#);
    assert_ne!(a, b);
    write(&mut h, b, b"two");
    assert_eq!(read_bytes(&mut h, b, 5).0, b"B:two");
    write(&mut h, a, b"one");
    assert_eq!(read_bytes(&mut h, a, 5).0, b"A:one");
    h.shutdown();
}

#[test]
fn the_helper_going_away_takes_every_channel_with_it() {
    watchdog();
    let mut h = start(&[]);
    let sid = perl(&mut h, 1, r#"$| = 1; print "$$\n"; sleep 60;"#);
    let (got, _) = read_bytes(&mut h, sid, 2);
    let pid: u32 = String::from_utf8_lossy(&got).trim().parse().expect("the program's pid");
    assert!(pid_alive(pid));
    h.shutdown();
    assert!(wait_pid_gone(pid, Duration::from_secs(10)), "the channel's program outlived the helper");
}

#[test]
fn a_program_that_cannot_start_is_refused_and_too_many_channels_are_too() {
    watchdog();
    let mut h = start(&[]);
    h.send(&Request::SftpOpen { id: 1, program: "/nonexistent/ssh".into(), argv: vec!["ssh".into()], env: HashMap::new(), askpass: None });
    assert!(matches!(h.read_reply(1), Response::Error { code, .. } if code == "sftp_spawn_failed"));
    for id in 10..26 {
        perl(&mut h, id, "sleep 60");
    }
    h.send(&Request::SftpOpen { id: 99, program: "/usr/bin/perl".into(), argv: vec!["perl".into(), "-e".into(), "1".into()], env: HashMap::new(), askpass: None });
    assert!(matches!(h.read_reply(99), Response::Error { code, .. } if code == "too_many_channels"));
    h.shutdown();
}
