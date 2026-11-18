//! Who drives a session, through the REAL helper process and a REAL pty (stage 4b-1, repair Z2). The "ssh" is perl (test-hooks
//! allow a free-form program) that does not read its terminal for a while, so what an agent types piles up inside the helper;
//! when the owner changes, none of it may reach the child.
#![cfg(target_os = "macos")]
mod common;

use common::*;
use remote_hub_helper::protocol::{Request, Response, FRAME_KIND_STREAM};
use std::collections::HashMap;
use std::time::{Duration, Instant};

fn watchdog() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        std::thread::spawn(|| {
            std::thread::sleep(Duration::from_secs(60));
            eprintln!("owner tests: watchdog expired after 60 s; aborting");
            std::process::abort();
        });
    });
}

const SLOW_READER: &str = r#"
$| = 1;
system("/bin/stty raw -echo");
sleep 3;
my ($a, $h, $other, $human) = (0, 0, 0, "");
my $idle = 0;
while ($idle < 6) {
  my $rin = ''; vec($rin, fileno(STDIN), 1) = 1;
  if (select(my $rout = $rin, undef, undef, 0.3)) {
    my $n = sysread(STDIN, my $buf, 65536);
    last unless $n;
    for my $c (split //, $buf) { if ($c eq 'A') { $a++ } elsif ($c =~ /[QUIET]/) { $human .= $c } else { $other++ } }
    $idle = 0;
  } else { $idle++ }
}
print "GOT A=$a HUMAN=" . length($human) . " OTHER=$other DONE\n";
"#;

fn field(text: &str, key: &str) -> usize {
    let start = text.find(&format!("{key}=")).unwrap_or_else(|| panic!("no {key} in {text:?}")) + key.len() + 1;
    text[start..].split(|c: char| !c.is_ascii_digit()).next().unwrap().parse().unwrap()
}

#[test]
fn what_a_replaced_driver_still_had_queued_never_reaches_the_child() {
    watchdog();
    let mut h = start(&[]);
    let mut env = HashMap::new();
    env.insert("PATH".to_string(), "/usr/bin:/bin".to_string());
    h.send(&Request::OpenSsh { id: 10, cols: 80, rows: 24, program: "/usr/bin/perl".into(), argv: vec!["perl".into(), "-e".into(), SLOW_READER.into()], env, cwd: None, askpass: None });
    let sid = match h.read_reply(10) {
        Response::SessionOpened { session_id, .. } => session_id,
        other => panic!("expected session.opened, got {other:?}"),
    };
    h.send(&Request::SessionCredit { id: 11, session_id: sid, bytes: 1 << 20 });
    std::thread::sleep(Duration::from_millis(800)); // the child is in raw mode and asleep
    // An agent takes the session and types far more than the terminal will take while its reader sleeps.
    h.send(&Request::SessionSetOwner { id: 20, session_id: sid, owner: "agent:A".into() });
    assert!(matches!(h.read_reply(20), Response::SessionOwnerSet { dropped: 0, .. }));
    let total = 30_000usize;
    h.send(&Request::SessionInput { id: 21, session_id: sid, data: "A".repeat(total), owner: Some("agent:A".into()) });
    assert!(matches!(h.read_reply(21), Response::SessionInputAck { .. }));
    // The human takes over: the barrier reports what was dropped.
    h.send(&Request::SessionSetOwner { id: 22, session_id: sid, owner: "human".into() });
    let dropped = match h.read_reply(22) {
        Response::SessionOwnerSet { dropped, .. } => dropped as usize,
        other => panic!("expected session.owner_set, got {other:?}"),
    };
    assert!(dropped > 0 && dropped < total, "some of it must have been waiting inside the helper: {dropped}");
    // The old driver's input is refused from now on; the human's goes through.
    h.send(&Request::SessionInput { id: 23, session_id: sid, data: "AAAA".into(), owner: Some("agent:A".into()) });
    assert!(matches!(h.read_reply(23), Response::Error { code, .. } if code == "stale_owner"));
    h.send(&Request::SessionInput { id: 24, session_id: sid, data: "QUIET".into(), owner: None });
    assert!(matches!(h.read_reply(24), Response::SessionInputAck { .. }));

    let deadline = Instant::now() + Duration::from_secs(30);
    let mut text = String::new();
    while Instant::now() < deadline && !text.contains("DONE") {
        let (kind, payload) = h.read_frame();
        if kind == FRAME_KIND_STREAM && u32::from_le_bytes(payload[0..4].try_into().unwrap()) == sid {
            text.push_str(&String::from_utf8_lossy(&payload[8..]));
        }
    }
    assert!(text.contains("DONE"), "the child did not finish: {text:?}");
    // Every byte the agent typed either reached the terminal before the takeover or was dropped at the barrier: none after.
    assert_eq!(field(&text, "A") + dropped, total, "{text}");
    assert_eq!(field(&text, "HUMAN"), 5, "{text}");
    assert_eq!(field(&text, "OTHER"), 0, "{text}");
    h.shutdown();
}
