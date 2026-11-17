//! Synthetic engines for the integration tests, selected only in a
//! `test-hooks` build by `REMOTE_HUB_RDP_FAKE_ENGINE=<mode>` on the helper.
//! They speak the real helper <-> engine protocol and use the real `Desk` /
//! `send_region` path, but paint a synthetic desktop instead of talking RDP.
//!
//! * `ack`   — paints 64x64 blocks and paces updates through the ack-driven
//!   pump, exactly like the real engine. Every 25th paint it reports
//!   `state = "paint=<n>"` (n = paints so far) so a test can wait for "the
//!   desktop has repainted N more times" as an event instead of sleeping.
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
    let (width, height) = loop {
        match read_frame(&mut stream) {
            Ok(Some(body)) if body.first() == Some(&protocol::FRAME_CONTROL) => {
                if let Ok(EngineCommand::Open { width, height, .. }) = serde_json::from_slice(&body[1..]) {
                    break (width, height);
                }
            }
            Ok(Some(_)) => {}
            _ => return 0,
        }
    };
    let Ok(out) = stream.try_clone().map(|s| Arc::new(Out::new(s))) else { return 2 };
    let inbox = spawn_reader(stream);
    let Ok(rt) = tokio::runtime::Builder::new_multi_thread().enable_all().build() else { return 2 };
    match rt.block_on(run(mode == "flood", width, height, out, inbox)) {
        Ok(()) => 0,
        Err(_) => 2,
    }
}

async fn run(flood: bool, width: u32, height: u32, out: Arc<Out>, inbox: Inbox) -> std::io::Result<()> {
    let Inbox { mut control, cancel, .. } = inbox;
    for state in ["connecting", "tls", "authenticating"] {
        out.state(state)?;
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
                Some(Control::Input(_)) => {}
            },
            _ = tokio::time::sleep(Duration::from_millis(1)) => {
                tick = tick.wrapping_add(1);
                let shade = (tick % 251) as u8;
                if !flood && tick % 25 == 0 {
                    out.state(&format!("paint={tick}"))?;
                }
                let rect = if flood || tick == 1 {
                    for px in pixels.chunks_exact_mut(4) {
                        px.copy_from_slice(&[shade, shade ^ 0x55, 7, 255]);
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
