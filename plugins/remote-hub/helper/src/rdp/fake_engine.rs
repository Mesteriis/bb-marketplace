//! Synthetic engines for the integration tests, selected only in a
//! `test-hooks` build by `REMOTE_HUB_RDP_FAKE_ENGINE=<mode>` on the helper.
//! They speak the real helper <-> engine protocol and use the real `Desk` /
//! `send_region` path, but paint a synthetic desktop instead of talking RDP.
//!
//! * `ack`   — paints 64x64 blocks and paces updates through the ack-driven
//!   pump, exactly like the real engine. Every 25th paint it reports
//!   `state = "paint=<n>"` (n = paints so far) so a test can wait for "the
//!   desktop has repainted N more times" as an event instead of sleeping.
//! * `credential` — as `ack`, and right after the first states it reports
//!   `state = "pw_sha256=<first 16 hex of SHA-256(password)>"`: the helper's resolution of
//!   a saved credential can be asserted without the password ever being printed.
//! * `cert:<fingerprint>` — as `credential`, and it presents that certificate fingerprint like the
//!   real engine does after TLS: a `Certificate` event, then `cert_changed` when the open named a
//!   different expected fingerprint (nothing else is reported before that, so no password is "used").
//! * `noise` — as `ack`, but the first full frame is incompressible pseudo-random
//!   pixels (a fixed xorshift sequence), so a PNG screenshot of it is far above
//!   one frame and exercises the chunked screenshot path.
//! * `flood-signal:<path>` — as `flood`, and it creates the file `<path>` once its
//!   writes to the helper have been BLOCKED for 3 consecutive 200 ms waits (the
//!   socket stayed full: the helper stopped reading because its bounded buffers
//!   are full). A test waits for the file instead of guessing from RSS.
//! * `flood` — ignores acks and sends a full 1920x1080-class frame every
//!   millisecond: a hostile / buggy engine, to prove the HELPER stays bounded.
use std::os::fd::FromRawFd;
use std::os::unix::net::UnixStream;
use std::sync::Arc;
use std::time::Duration;

use super::engine::{send_region, Desk};
use super::engine_io::{read_frame, spawn_reader, Control, Inbox, Out};
use super::framebuffer::{Framebuffer, Rect};
use super::protocol::{self, EngineCommand};
use super::reasons::RdpClosedReason;

pub fn run_fake_engine(mode: &str) -> i32 {
    let mut stream = unsafe { UnixStream::from_raw_fd(3) };
    let (width, height, password_digest, expected, pin_first_use) = loop {
        match read_frame(&mut stream) {
            Ok(Some(body)) if body.first() == Some(&protocol::FRAME_CONTROL) => {
                if let Ok(EngineCommand::Open { width, height, password, expected_fingerprint, pin_first_use, .. }) = serde_json::from_slice(&body[1..]) {
                    use sha2::{Digest, Sha256};
                    let digest = Sha256::digest(password.expose().as_bytes());
                    let hex: String = digest.iter().take(8).map(|b| format!("{b:02x}")).collect();
                    break (width, height, hex, expected_fingerprint, pin_first_use);
                }
            }
            Ok(Some(_)) => {}
            _ => return 0,
        }
    };
    let Ok(out) = stream.try_clone().map(|s| Arc::new(Out::new(s))) else { return 2 };
    let inbox = spawn_reader(stream);
    let Ok(rt) = tokio::runtime::Builder::new_multi_thread().enable_all().build() else { return 2 };
    let signal = mode.strip_prefix("flood-signal:").map(std::path::PathBuf::from);
    let flood = mode == "flood" || signal.is_some();
    let noise = mode == "noise";
    // `cert:<fp>` presents one certificate; `cert-by-height:<a>,<b>` presents <a> for an even desktop height
    // and <b> for an odd one, so one helper can show two sessions two different certificates.
    let cert = mode.strip_prefix("cert:").map(str::to_string).or_else(|| {
        let (a, b) = mode.strip_prefix("cert-by-height:")?.split_once(',')?;
        Some((if height % 2 == 0 { a } else { b }).to_string())
    });
    if let Some(presented) = &cert {
        let _ = out.send(&protocol::EngineEvent::Certificate { fingerprint: presented.clone(), validated: false });
        if let Some(expected) = &expected {
            if !super::cert::fingerprint_matches(presented, expected) {
                return if out.closed(RdpClosedReason::CertChanged).is_ok() { 0 } else { 2 };
            }
        }
        if pin_first_use {
            // Like the real engine: nothing is authenticated (no password digest is reported) until the
            // helper's pin-or-compare answer says "allow".
            let _ = out.send(&protocol::EngineEvent::PinRequest { fingerprint: presented.clone() });
            let verdict = loop {
                match inbox.decisions.recv_timeout(Duration::from_secs(15)) {
                    Ok(super::engine_io::Decision::Pin { verdict }) => break verdict,
                    Ok(_) => {}
                    Err(_) => break "failed".to_string(),
                }
            };
            if verdict != "allow" {
                let reason = if verdict == "changed" { RdpClosedReason::CertChanged } else { RdpClosedReason::CertRejected };
                return if out.closed(reason).is_ok() { 0 } else { 2 };
            }
        }
    }
    let report = (mode == "credential" || cert.is_some()).then_some(password_digest);
    match rt.block_on(run(flood, noise, signal, report, width, height, out, inbox)) {
        Ok(()) => 0,
        Err(_) => 2,
    }
}

/// True when the helper's socket (fd 3) has stayed unwritable for 200 ms.
fn socket_blocked_for_200ms() -> bool {
    let mut pfd = libc::pollfd { fd: 3, events: libc::POLLOUT, revents: 0 };
    let r = unsafe { libc::poll(&mut pfd, 1, 200) };
    r == 0
}

async fn run(
    flood: bool,
    noise: bool,
    signal: Option<std::path::PathBuf>,
    report_password: Option<String>,
    width: u32,
    height: u32,
    out: Arc<Out>,
    inbox: Inbox,
) -> std::io::Result<()> {
    if let Some(path) = signal {
        // A watchdog beside the flooding writer: the writer blocks INSIDE a write
        // when the helper stops reading, so only another thread can see it. The
        // socket (fd 3) has to stay unwritable for 3 consecutive 200 ms waits.
        std::thread::spawn(move || {
            let mut blocked_waits = 0u32;
            loop {
                if socket_blocked_for_200ms() {
                    blocked_waits += 1;
                    if blocked_waits == 3 {
                        let _ = std::fs::File::create(&path);
                    }
                } else {
                    blocked_waits = 0;
                    std::thread::sleep(Duration::from_millis(20));
                }
            }
        });
    }
    let Inbox { mut control, cancel, .. } = inbox;
    for state in ["connecting", "tls", "authenticating"] {
        out.state(state)?;
    }
    if let Some(digest) = report_password {
        out.state(&format!("pw_sha256={digest}"))?;
    }
    let Ok(fb) = Framebuffer::new(width, height) else { return out.closed(RdpClosedReason::ProtocolError) };
    let mut desk = Desk::new(fb);
    let mut pixels = vec![0u8; width as usize * height as usize * 4];
    let blocks = [(0, 0), (64, 0), (0, 64), (64, 64)];
    let mut tick: u32 = 0;
    loop {
        tokio::select! {
            reason = cancel.wait() => {
                return if reason == RdpClosedReason::HelperShutdown { Ok(()) } else { out.closed(reason) };
            }
            ctl = control.recv() => match ctl {
                None => return Ok(()),
                Some(Control::Ack(frame_id)) => desk.ack(&out, frame_id)?,
                Some(Control::Screenshot) => desk.screenshot(&out)?,
                Some(Control::Refresh) => desk.refresh(&out)?,
                Some(Control::Input(_)) => {}
            },
            _ = tokio::time::sleep(Duration::from_millis(1)) => {
                tick = tick.wrapping_add(1);
                let shade = (tick % 251) as u8;
                if !flood && tick % 25 == 0 {
                    out.state(&format!("paint={tick}"))?;
                }
                let rect = if flood || tick == 1 {
                    if noise {
                        let mut state: u32 = 0x9E37_79B9;
                        for px in pixels.chunks_exact_mut(4) {
                            state ^= state << 13;
                            state ^= state >> 17;
                            state ^= state << 5;
                            px.copy_from_slice(&[state as u8, (state >> 8) as u8, (state >> 16) as u8, 255]);
                        }
                    } else {
                        for px in pixels.chunks_exact_mut(4) {
                            px.copy_from_slice(&[shade, shade ^ 0x55, 7, 255]);
                        }
                    }
                    Rect { x: 0, y: 0, w: width, h: height }
                } else {
                    let (bx, by) = blocks[(tick as usize) % blocks.len()];
                    let (bw, bh) = (64.min(width), 64.min(height));
                    let mut block = vec![0u8; bw as usize * bh as usize * 4];
                    for px in block.chunks_exact_mut(4) {
                        px.copy_from_slice(&[shade, shade ^ 0x55, 7, 255]);
                    }
                    let rect = Rect { x: bx.min(width - bw), y: by.min(height - bh), w: bw, h: bh };
                    desk.fb.apply(rect.x, rect.y, rect.w, rect.h, &block, 0).ok();
                    desk.dirty(&out, rect)?;
                    continue;
                };
                if desk.fb.apply(rect.x, rect.y, rect.w, rect.h, &pixels, 0).is_err() {
                    return out.closed(RdpClosedReason::ProtocolError);
                }
                if flood && desk.desktop_sent {
                    // A buggy engine: no pacing at all.
                    send_region(&desk.fb, &out, rect)?;
                } else {
                    desk.dirty(&out, rect)?;
                }
            }
        }
    }
}
