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

use super::connect::{
    connect_sequence, Clock, Connected, FramedRead, FramedWrite, Params, SystemClock, SystemTls, Timeouts, TlsUpgrader,
};
use super::engine_io::{read_frame, spawn_reader, Cancel, Control, Inbox, Out};
use super::framebuffer::{Framebuffer, Rect};
use super::input::Geometry;
use super::input_encode::{coalesce_moves, encode_input};
use super::mapping::map_terminate;
use super::pump::UpdatePump;
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
    rt.block_on(run(params, Timeouts::default(), out, inbox, Arc::new(SystemClock::new()), &SystemTls))?;
    Ok(0)
}

/// Run one session to its end. `Err` means the helper's socket failed.
pub async fn run(
    params: Params,
    timeouts: Timeouts,
    out: Arc<Out>,
    inbox: Inbox,
    clock: Arc<dyn Clock>,
    tls: &dyn TlsUpgrader,
) -> std::io::Result<()> {
    let Inbox { control, decisions, cancel } = inbox;
    match connect_sequence(params, timeouts, out.clone(), decisions, cancel.clone(), clock, tls).await {
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

/// The framebuffer with its ack-driven update pacing: at most one update is in
/// flight; later dirty regions coalesce until the consumer acks (see `pump`).
pub struct Desk {
    pub fb: Framebuffer,
    pump: UpdatePump,
    pub desktop_sent: bool,
}

impl Desk {
    pub fn new(fb: Framebuffer) -> Self {
        Desk { fb, pump: UpdatePump::new(), desktop_sent: false }
    }

    /// `rect` of the framebuffer changed (already applied). Announces the
    /// desktop the first time, then sends the region unless an update is in
    /// flight, in which case it is coalesced.
    pub fn dirty(&mut self, out: &Out, rect: Rect) -> std::io::Result<()> {
        if !self.desktop_sent {
            self.desktop_sent = true;
            out.send(&EngineEvent::Desktop {
                frame_id: self.fb.frame_id(),
                width: self.fb.width(),
                height: self.fb.height(),
                timestamp: self.fb.last_update_ms(),
            })?;
        }
        if let Some(region) = self.pump.on_dirty(rect) {
            self.send(out, region)?;
        }
        Ok(())
    }

    /// The consumer acked `frame_id`: send the coalesced pending region, if any.
    pub fn ack(&mut self, out: &Out, frame_id: u64) -> std::io::Result<()> {
        if let Some(region) = self.pump.on_ack(frame_id) {
            self.send(out, region)?;
        }
        Ok(())
    }

    fn send(&mut self, out: &Out, rect: Rect) -> std::io::Result<()> {
        send_region(&self.fb, out, rect)?;
        self.pump.sent(self.fb.frame_id());
        Ok(())
    }

    pub fn screenshot(&self, out: &Out) -> std::io::Result<()> {
        send_screenshot(self, out)
    }
}

struct Active {
    reader: FramedRead,
    writer: FramedWrite,
    stage: ActiveStage,
    image: DecodedImage,
    desk: Desk,
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
    let mut a = Active { reader, writer, stage, image, desk: Desk::new(framebuffer) };

    let mut held: Option<Control> = None;
    loop {
        let outputs = if let Some(c) = held.take() {
            handle_control(&mut a, out, c, &mut control, &mut held)?
        } else {
            tokio::select! {
                reason = cancel.wait() => return report_closed(out, reason),
                ctl = control.recv() => match ctl {
                    // The helper went away: end the session and exit.
                    None => return Ok(()),
                    Some(c) => handle_control(&mut a, out, c, &mut control, &mut held)?,
                },
                frame = a.reader.read_pdu() => match frame {
                    Ok((action, payload)) => match a.stage.process(&mut a.image, action, &payload, None) {
                        Ok(o) => o,
                        Err(_) => return report_closed(out, RdpClosedReason::ProtocolError),
                    },
                    Err(_) => return report_closed(out, RdpClosedReason::NetworkError),
                },
            }
        };
        if let Some(reason) = handle_outputs(&mut a, out, outputs).await? {
            return report_closed(out, reason);
        }
    }
}

/// One helper command. Queued input batches are merged first (see
/// `drain_input`); the first non-input command found while draining is put
/// back in `held` so ordering is kept.
fn handle_control(
    a: &mut Active,
    out: &Out,
    ctl: Control,
    control: &mut tokio::sync::mpsc::Receiver<Control>,
    held: &mut Option<Control>,
) -> std::io::Result<Vec<ActiveStageOutput>> {
    match ctl {
        Control::Input(events) => {
            let (batches, next) = drain_input(events, control);
            *held = next;
            handle_inputs(a, out, &batches)
        }
        Control::Screenshot => {
            a.desk.screenshot(out)?;
            Ok(Vec::new())
        }
        Control::Ack(frame_id) => {
            a.desk.ack(out, frame_id)?;
            Ok(Vec::new())
        }
    }
}

/// Collect every input batch already queued behind `first`, stopping at the
/// first other command (returned so the caller can handle it next).
pub fn drain_input(
    first: Vec<protocol::InputEvent>,
    control: &mut tokio::sync::mpsc::Receiver<Control>,
) -> (Vec<Vec<protocol::InputEvent>>, Option<Control>) {
    let mut batches = vec![first];
    loop {
        match control.try_recv() {
            Ok(Control::Input(more)) => batches.push(more),
            Ok(other) => return (batches, Some(other)),
            Err(_) => return (batches, None),
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
                let Some(rect) = region_to_rect(&region, a.desk.fb.width(), a.desk.fb.height()) else {
                    continue;
                };
                let stride = a.image.width() as usize * 4;
                if a.desk.fb.apply_from_image(rect, a.image.data(), stride, now_ms()).is_err() {
                    return Ok(Some(RdpClosedReason::ProtocolError));
                }
                a.desk.dirty(out, rect)?;
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
pub(crate) fn send_region(fb: &Framebuffer, out: &Out, rect: Rect) -> std::io::Result<()> {
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

fn send_screenshot(desk: &Desk, out: &Out) -> std::io::Result<()> {
    if !desk.desktop_sent {
        return out.send(&EngineEvent::ScreenshotError { code: "not_ready".to_string() });
    }
    let fb = &desk.fb;
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
    let png = base64_encode(&png);
    if png.len() > protocol::MAX_SCREENSHOT_BASE64 {
        return out.send(&EngineEvent::ScreenshotError { code: "screenshot_too_large".to_string() });
    }
    out.send(&EngineEvent::Screenshot {
        frame_id: fb.frame_id(),
        width: fb.width(),
        height: fb.height(),
        timestamp: fb.last_update_ms(),
        png,
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

/// Validate and encode queued input batches against the current framebuffer
/// geometry and send them as one FastPath burst. A rejected event is reported
/// with its index (within its batch) and a stable code; the rest are applied.
/// Runs of mouse moves collapse to the latest position, across batches too.
fn handle_inputs(
    a: &mut Active,
    out: &Out,
    batches: &[Vec<protocol::InputEvent>],
) -> std::io::Result<Vec<ActiveStageOutput>> {
    let fb = Geometry { width: a.desk.fb.width(), height: a.desk.fb.height() };
    let mut fast = Vec::new();
    for batch in batches {
        let encoded = encode_input(batch, fb);
        if !encoded.rejected.is_empty() {
            out.send(&EngineEvent::InputRejected { applied: encoded.applied, rejected: encoded.rejected })?;
        }
        fast.extend(encoded.events);
    }
    let fast = coalesce_moves(fast);
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
    fn queued_input_batches_merge_and_stop_at_another_command() {
        use super::super::protocol::InputEvent;
        let mv = |x| InputEvent::MouseMove { x, y: 0, geom_width: 10, geom_height: 10 };
        let (tx, mut rx) = tokio::sync::mpsc::channel(8);
        tx.try_send(Control::Input(vec![mv(2)])).unwrap();
        tx.try_send(Control::Input(vec![mv(3), mv(4)])).unwrap();
        tx.try_send(Control::Screenshot).unwrap();
        tx.try_send(Control::Input(vec![mv(9)])).unwrap();
        let (batches, next) = drain_input(vec![mv(1)], &mut rx);
        assert_eq!(batches.len(), 3);
        assert_eq!(batches.iter().map(|b| b.len()).sum::<usize>(), 4);
        assert!(matches!(next, Some(Control::Screenshot)));
        // the input behind the screenshot is still queued, in order
        assert!(matches!(rx.try_recv(), Ok(Control::Input(_))));
        let (batches, next) = drain_input(vec![mv(1)], &mut rx);
        assert_eq!(batches.len(), 1);
        assert!(next.is_none());
    }

    /// Deterministic noise (an LCG with fixed constants); a PNG cannot compress it.
    fn noisy_desk(width: u32, height: u32) -> Desk {
        let mut state: u32 = 0x1234_5678;
        let mut rgba = Vec::with_capacity(width as usize * height as usize * 4);
        for _ in 0..width as usize * height as usize * 4 {
            state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            rgba.push((state >> 24) as u8);
        }
        let mut fb = Framebuffer::new(width, height).unwrap();
        fb.apply(0, 0, width, height, &rgba, 5).unwrap();
        let mut desk = Desk::new(fb);
        desk.desktop_sent = true;
        desk
    }

    fn frames_sent(desk: &Desk) -> Vec<Vec<u8>> {
        use std::io::Read as _;
        let (engine_end, mut peer) = std::os::unix::net::UnixStream::pair().unwrap();
        let out = Out::new(engine_end);
        std::thread::scope(|scope| {
            let reader = scope.spawn(move || {
                let mut all = Vec::new();
                peer.read_to_end(&mut all).unwrap();
                all
            });
            send_screenshot(desk, &out).unwrap();
            drop(out);
            let all = reader.join().unwrap();
            let mut frames = Vec::new();
            let mut at = 0;
            while at < all.len() {
                let len = u32::from_le_bytes(all[at..at + 4].try_into().unwrap()) as usize;
                frames.push(all[at..at + 4 + len].to_vec());
                at += 4 + len;
            }
            frames
        })
    }

    fn base64_decode(s: &str) -> Vec<u8> {
        let val = |c: u8| match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' => 62,
            _ => 63,
        };
        let mut out = Vec::new();
        for q in s.as_bytes().chunks(4) {
            let n = q.iter().filter(|&&c| c != b'=').fold(0u32, |a, &c| (a << 6) | val(c) as u32) << (6 * (4 - q.iter().filter(|&&c| c != b'=').count()));
            let bytes = q.iter().filter(|&&c| c != b'=').count() * 6 / 8;
            for i in 0..bytes {
                out.push((n >> (16 - 8 * i)) as u8);
            }
        }
        out
    }

    /// H3: a 3840x2160 noisy desktop (an ~33 MiB PNG) is refused with a stable
    /// code instead of producing a frame the client would treat as fatal.
    #[test]
    fn an_oversized_screenshot_is_refused_and_no_frame_exceeds_the_wire_limit() {
        let frames = frames_sent(&noisy_desk(3840, 2160));
        assert_eq!(frames.len(), 1);
        assert!(frames[0].len() <= 4_194_304, "frame of {} bytes", frames[0].len());
        let event: EngineEvent = serde_json::from_slice(&frames[0][5..]).unwrap();
        assert_eq!(event, EngineEvent::ScreenshotError { code: "screenshot_too_large".to_string() });
    }

    /// H3: a screenshot that fits is one frame under the limit and its PNG
    /// decodes to exactly the framebuffer.
    #[test]
    fn a_screenshot_that_fits_decodes_to_the_framebuffer() {
        let desk = noisy_desk(400, 300);
        let frames = frames_sent(&desk);
        assert_eq!(frames.len(), 1);
        assert!(frames[0].len() <= 4_194_304);
        let EngineEvent::Screenshot { width, height, png, .. } = serde_json::from_slice(&frames[0][5..]).unwrap() else {
            panic!("not a screenshot")
        };
        assert_eq!((width, height), (400, 300));
        let decoded = base64_decode(&png);
        let mut reader = png::Decoder::new(std::io::Cursor::new(decoded)).read_info().unwrap();
        let mut buf = vec![0u8; reader.output_buffer_size().unwrap()];
        let info = reader.next_frame(&mut buf).unwrap();
        assert_eq!(&buf[..info.buffer_size()], desk.fb.pixels());
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
