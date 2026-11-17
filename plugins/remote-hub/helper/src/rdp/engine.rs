//! The `--rdp-engine` child: one process per RDP session. It reads the Open
//! command (all parameters, including the password) from the socketpair on fd
//! 3, runs the IronRDP connection sequence (`connect.rs`), owns one RGBA8
//! framebuffer and streams state/desktop/update/screenshot events back to the
//! helper. If the helper goes away the engine ends its session and exits.
use std::os::fd::FromRawFd;
use std::os::unix::net::UnixStream;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use ironrdp_graphics::image_processing::PixelFormat;
use ironrdp_pdu::geometry::InclusiveRectangle;
use ironrdp_session::image::DecodedImage;
use ironrdp_session::{ActiveStage, ActiveStageBuilder, ActiveStageOutput};
use ironrdp_tokio::FramedWrite as _;

use super::connect::{connect_sequence, Connected, FramedRead, FramedWrite, Params, SystemTls, Timeouts, TlsUpgrader};
use super::engine_io::{read_frame, spawn_reader, Cancel, Control, Inbox, Out};
use super::framebuffer::{Framebuffer, Rect};
use super::input::Geometry;
use super::input_encode::{coalesce_moves, encode_input};
use super::mapping::map_terminate;
use super::protocol::{self, EngineCommand, EngineEvent, ENGINE_UPDATE_OVERHEAD};
use super::reasons::RdpClosedReason;

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

pub fn run_engine() -> i32 {
    let stream = unsafe { UnixStream::from_raw_fd(3) };
    match engine_main(stream) {
        Ok(code) => code,
        Err(_) => 2, // the helper is gone (its socket failed): nothing to tell it
    }
}

fn engine_main(mut stream: UnixStream) -> std::io::Result<i32> {
    // The first frame must be Open. All parameters (including the password)
    // arrive over this socketpair, never argv/env/file.
    let open = loop {
        match read_frame(&mut stream)? {
            Some(body) if body.first() == Some(&protocol::FRAME_CONTROL) => {
                if let Ok(cmd @ EngineCommand::Open { .. }) = serde_json::from_slice::<EngineCommand>(&body[1..]) {
                    break cmd;
                }
            }
            Some(_) => {}
            None => return Ok(0),
        }
    };
    let EngineCommand::Open { host, port, username, password, domain, width, height, expected_fingerprint } = open
    else {
        return Ok(1);
    };
    let params = Params { host, port, username, password, domain, width, height, expected_fingerprint };
    let out = Arc::new(Out::new(stream.try_clone()?));
    let inbox = spawn_reader(stream);
    let rt = tokio::runtime::Builder::new_multi_thread().enable_all().build()?;
    rt.block_on(run(params, Timeouts::default(), out, inbox, &SystemTls))?;
    Ok(0)
}

/// Run one session to its end. `Err` means the helper's socket failed.
pub async fn run(
    params: Params,
    timeouts: Timeouts,
    out: Arc<Out>,
    inbox: Inbox,
    tls: &dyn TlsUpgrader,
) -> std::io::Result<()> {
    let Inbox { control, decisions, cancel } = inbox;
    match connect_sequence(params, timeouts, out.clone(), decisions, cancel.clone(), tls).await {
        Ok(connected) => run_active(connected, &out, control, &cancel).await,
        Err(reason) => report_closed(&out, reason),
    }
}

/// Tell the helper why the session ended. When the helper itself went away
/// there is no one to tell.
fn report_closed(out: &Out, reason: RdpClosedReason) -> std::io::Result<()> {
    if reason == RdpClosedReason::HelperShutdown {
        return Ok(());
    }
    out.closed(reason)
}

struct Active {
    reader: FramedRead,
    writer: FramedWrite,
    stage: ActiveStage,
    image: DecodedImage,
    framebuffer: Framebuffer,
    desktop_sent: bool,
}

async fn run_active(
    connected: Connected,
    out: &Out,
    mut control: tokio::sync::mpsc::Receiver<Control>,
    cancel: &Cancel,
) -> std::io::Result<()> {
    let Connected { reader, writer, connection } = connected;
    let Ok(framebuffer) = Framebuffer::new(connection.desktop_size.width as u32, connection.desktop_size.height as u32)
    else {
        return report_closed(out, RdpClosedReason::ProtocolError);
    };
    let stage = ActiveStageBuilder {
        static_channels: connection.static_channels,
        user_channel_id: connection.user_channel_id,
        io_channel_id: connection.io_channel_id,
        message_channel_id: connection.message_channel_id,
        share_id: connection.share_id,
        compression_type: connection.compression_type,
        enable_server_pointer: connection.enable_server_pointer,
        pointer_software_rendering: connection.pointer_software_rendering,
    }
    .build();
    let image = DecodedImage::new(PixelFormat::RgbA32, framebuffer.width() as u16, framebuffer.height() as u16);
    let mut a = Active { reader, writer, stage, image, framebuffer, desktop_sent: false };

    loop {
        let outputs = tokio::select! {
            reason = cancel.wait() => return report_closed(out, reason),
            ctl = control.recv() => match ctl {
                // The helper went away: end the session and exit.
                None => return Ok(()),
                Some(Control::Input(events)) => handle_input(&mut a, out, &events)?,
                Some(Control::Screenshot) => {
                    send_screenshot(&a, out)?;
                    Vec::new()
                }
                Some(Control::Ack(_)) => Vec::new(),
            },
            frame = a.reader.read_pdu() => match frame {
                Ok((action, payload)) => match a.stage.process(&mut a.image, action, &payload, None) {
                    Ok(o) => o,
                    Err(_) => return report_closed(out, RdpClosedReason::ProtocolError),
                },
                Err(_) => return report_closed(out, RdpClosedReason::NetworkError),
            },
        };
        if let Some(reason) = handle_outputs(&mut a, out, outputs).await? {
            return report_closed(out, reason);
        }
    }
}

/// Apply stage outputs. Returns a closed reason when the session ended.
async fn handle_outputs(
    a: &mut Active,
    out: &Out,
    outputs: Vec<ActiveStageOutput>,
) -> std::io::Result<Option<RdpClosedReason>> {
    for output in outputs {
        match output {
            ActiveStageOutput::ResponseFrame(frame) => {
                if a.writer.write_all(&frame).await.is_err() {
                    return Ok(Some(RdpClosedReason::NetworkError));
                }
            }
            ActiveStageOutput::GraphicsUpdate(region) => {
                let Some(rect) = region_to_rect(&region, a.framebuffer.width(), a.framebuffer.height()) else {
                    continue;
                };
                let stride = a.image.width() as usize * 4;
                if a.framebuffer.apply_from_image(rect, a.image.data(), stride, now_ms()).is_err() {
                    return Ok(Some(RdpClosedReason::ProtocolError));
                }
                if !a.desktop_sent {
                    a.desktop_sent = true;
                    out.send(&EngineEvent::Desktop {
                        frame_id: a.framebuffer.frame_id(),
                        width: a.framebuffer.width(),
                        height: a.framebuffer.height(),
                        timestamp: a.framebuffer.last_update_ms(),
                    })?;
                }
                send_region(&a.framebuffer, out, rect)?;
            }
            ActiveStageOutput::Terminate(reason) => return Ok(Some(map_terminate(&reason))),
            _ => {}
        }
    }
    Ok(None)
}

/// The server's inclusive dirty rectangle as a framebuffer rectangle, clamped
/// to the desktop. None when it lies outside or is empty.
pub fn region_to_rect(region: &InclusiveRectangle, fb_w: u32, fb_h: u32) -> Option<Rect> {
    let (left, top) = (region.left as u32, region.top as u32);
    if region.right < region.left || region.bottom < region.top || left >= fb_w || top >= fb_h {
        return None;
    }
    let right = (region.right as u32).min(fb_w - 1);
    let bottom = (region.bottom as u32).min(fb_h - 1);
    Some(Rect { x: left, y: top, w: right - left + 1, h: bottom - top + 1 })
}

/// Send the dirty region, split into update frames of at most 1 MiB on the
/// wire with every header counted.
fn send_region(fb: &Framebuffer, out: &Out, rect: Rect) -> std::io::Result<()> {
    let rows_per_chunk = protocol::rows_per_chunk(rect.w, ENGINE_UPDATE_OVERHEAD) as u32;
    let mut y = rect.y;
    let mut remaining = rect.h;
    let mut pixels = Vec::new();
    while remaining > 0 {
        let chunk_h = remaining.min(rows_per_chunk);
        let sub = fb.copy_region(rect.x, y, rect.w, chunk_h, &mut pixels);
        out.send_frame(&protocol::encode_update(
            0,
            fb.frame_id(),
            fb.width(),
            fb.height(),
            sub.x,
            sub.y,
            sub.w,
            sub.h,
            &pixels,
        ))?;
        y += chunk_h;
        remaining -= chunk_h;
    }
    Ok(())
}

fn send_screenshot(a: &Active, out: &Out) -> std::io::Result<()> {
    if !a.desktop_sent {
        return out.send(&EngineEvent::ScreenshotError { code: "not_ready".to_string() });
    }
    let fb = &a.framebuffer;
    let mut png = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut png, fb.width(), fb.height());
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let encoded = encoder.write_header().and_then(|mut w| w.write_image_data(fb.pixels()));
        if encoded.is_err() {
            return out.send(&EngineEvent::ScreenshotError { code: "encode_failed".to_string() });
        }
    }
    out.send(&EngineEvent::Screenshot {
        frame_id: fb.frame_id(),
        width: fb.width(),
        height: fb.height(),
        timestamp: fb.last_update_ms(),
        png: base64_encode(&png),
    })
}

fn base64_encode(data: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(TABLE[(n >> 18) as usize & 63] as char);
        out.push(TABLE[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { TABLE[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { TABLE[n as usize & 63] as char } else { '=' });
    }
    out
}

/// Validate, encode and send one input batch. Rejected events are reported
/// (with their index and a stable code); the rest are applied.
fn handle_input(a: &mut Active, out: &Out, events: &[protocol::InputEvent]) -> std::io::Result<Vec<ActiveStageOutput>> {
    let fb = Geometry { width: a.framebuffer.width(), height: a.framebuffer.height() };
    let encoded = encode_input(events, fb);
    if !encoded.rejected.is_empty() {
        out.send(&EngineEvent::InputRejected { applied: encoded.applied, rejected: encoded.rejected })?;
    }
    let fast = coalesce_moves(encoded.events);
    if fast.is_empty() {
        return Ok(Vec::new());
    }
    match a.stage.process_fastpath_input(&mut a.image, &fast) {
        Ok(outputs) => Ok(outputs),
        Err(_) => {
            out.send(&EngineEvent::Error {
                code: "input_failed".to_string(),
                message: "the input could not be encoded".to_string(),
            })?;
            Ok(Vec::new())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dirty_regions_convert_to_clamped_rectangles() {
        let r = |l, t, rr, b| InclusiveRectangle { left: l, top: t, right: rr, bottom: b };
        assert_eq!(region_to_rect(&r(0, 0, 0, 0), 10, 10), Some(Rect { x: 0, y: 0, w: 1, h: 1 }));
        assert_eq!(region_to_rect(&r(2, 3, 5, 7), 10, 10), Some(Rect { x: 2, y: 3, w: 4, h: 5 }));
        // clamped to the desktop
        assert_eq!(region_to_rect(&r(8, 8, 20, 20), 10, 10), Some(Rect { x: 8, y: 8, w: 2, h: 2 }));
        // outside or inverted
        assert_eq!(region_to_rect(&r(10, 0, 12, 1), 10, 10), None);
        assert_eq!(region_to_rect(&r(5, 5, 4, 6), 10, 10), None);
    }

    #[test]
    fn base64_matches_rfc_vectors() {
        assert_eq!(base64_encode(b""), "");
        assert_eq!(base64_encode(b"f"), "Zg==");
        assert_eq!(base64_encode(b"fo"), "Zm8=");
        assert_eq!(base64_encode(b"foo"), "Zm9v");
        assert_eq!(base64_encode(b"foobar"), "Zm9vYmFy");
    }
}
