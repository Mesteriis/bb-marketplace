//! The `--rdp-engine` child: one process per RDP session. It reads the Open
//! command (all parameters, including the password) from the socketpair on fd
//! 3, runs the IronRDP connection sequence (`connect.rs`), owns one RGBA8
//! framebuffer and streams state/desktop/update/screenshot events back to the
//! helper. If the helper goes away the engine ends its session and exits.
use std::os::fd::FromRawFd;
use std::os::unix::net::UnixStream;
use std::sync::Arc;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use ironrdp_graphics::image_processing::PixelFormat;
use ironrdp_pdu::geometry::InclusiveRectangle;
use ironrdp_session::image::DecodedImage;
use ironrdp_session::{ActiveStage, ActiveStageBuilder, ActiveStageOutput};
use ironrdp_tokio::FramedWrite as _;

use super::connect::{
    connect_sequence, Clock, Connected, FramedRead, FramedWrite, Params, SystemClock, SystemTls, Timeouts, TlsUpgrader,
};
use super::driver::Driver;
use super::engine_io::{read_frame, spawn_reader, Cancel, Control, Inbox, Out};
use super::framebuffer::{Framebuffer, Rect};
use super::health::{self, Health};
use super::input::Geometry;
use super::input_encode::{coalesce_moves, encode_input};
use super::mapping::map_terminate;
use super::pump::UpdatePump;
use super::protocol::{self, EngineCommand, EngineEvent};
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
    let EngineCommand::Open { host, port, username, password, domain, width, height, expected_fingerprint, pin_first_use } = open
    else {
        return Ok(1);
    };
    health::install_counter();
    let params = Params { host, port, username, password, domain, width, height, expected_fingerprint, pin_first_use };
    let out = Arc::new(Out::new(stream.try_clone()?));
    let inbox = spawn_reader(stream);
    let rt = match tokio::runtime::Builder::new_multi_thread().enable_all().build() {
        Ok(rt) => rt,
        Err(e) => {
            // No runtime (e.g. thread limit): say so instead of exiting silently.
            // (fd 2 is /dev/null by design, so the helper hears it as an event.)
            let _ = out.send(&EngineEvent::Error { code: "engine_start_failed".to_string(), message: e.kind().to_string() });
            let _ = out.closed(RdpClosedReason::ProtocolError);
            return Ok(1);
        }
    };
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
    match connect_sequence(params, timeouts, out.clone(), decisions, cancel.clone(), clock.clone(), tls).await {
        Ok(connected) => run_active(connected, &out, control, &cancel, clock, timeouts.first_paint).await,
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

    /// The whole framebuffer is dirty again (a new or lagging view needs it).
    /// Before the first update there is nothing to resend.
    pub fn refresh(&mut self, out: &Out) -> std::io::Result<()> {
        if !self.desktop_sent {
            return Ok(());
        }
        // The pixels are unchanged, but the resent frame needs its own id: ids on
        // the wire are strictly increasing.
        self.fb.new_frame();
        let full = Rect { x: 0, y: 0, w: self.fb.width(), h: self.fb.height() };
        self.dirty(out, full)
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
    /// Who drives (A2): stale input is dropped here, and what was applied and is still down is released on a handover.
    driver: Driver,
    health: Health,
    /// What the server advertised for asking it to repaint (a redraw request needs one of them).
    refresh_rect: bool,
    suppress_output: bool,
}

/// How long the session may wait for its first painted update.
struct FirstPaint {
    clock: Arc<dyn Clock>,
    started: std::time::Duration,
    budget: std::time::Duration,
}

impl FirstPaint {
    fn new(clock: Arc<dyn Clock>, budget: std::time::Duration) -> Self {
        let started = clock.now();
        FirstPaint { clock, started, budget }
    }

    fn expired(&self) -> bool {
        self.clock.now().saturating_sub(self.started) >= self.budget
    }
}

async fn run_active(
    connected: Connected,
    out: &Out,
    control: tokio::sync::mpsc::Receiver<Control>,
    cancel: &Cancel,
    clock: Arc<dyn Clock>,
    first_paint: std::time::Duration,
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
    let (refresh_rect, suppress_output) = (connection.refresh_rect_support, connection.suppress_output_support);
    let a = Active { reader, writer, stage, image, desk: Desk::new(framebuffer), driver: Driver::default(), health: Health::new(), refresh_rect, suppress_output };
    drive(a, out, control, cancel, FirstPaint::new(clock, first_paint)).await
}

/// The active session loop: server PDUs, helper commands and cancellation,
/// until the session ends. Without a first painted update inside the
/// `FirstPaint` budget the session ends as `timeout`.
async fn drive(
    mut a: Active,
    out: &Out,
    mut control: tokio::sync::mpsc::Receiver<Control>,
    cancel: &Cancel,
    paint: FirstPaint,
) -> std::io::Result<()> {
    let mut held: Option<Control> = None;
    loop {
        if !a.desk.desktop_sent && paint.expired() {
            return report_closed(out, RdpClosedReason::Timeout);
        }
        let outputs = if let Some(c) = held.take() {
            handle_control(&mut a, out, c, &mut control, &mut held)?
        } else {
            tokio::select! {
                reason = cancel.wait() => return report_closed(out, reason),
                // Re-checks the first-paint budget while the server is quiet.
                _ = tokio::time::sleep(super::connect::BUDGET_TICK), if !a.desk.desktop_sent => Vec::new(),
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
        if let Some(reason) = recover_and_report(&mut a, out).await? {
            return report_closed(out, reason);
        }
    }
}

/// After a turn: IronRDP discards a malformed visual update and latches a request for a full redraw; answer it (bounded:
/// `health::RECOVERY_CAP` per minute, and only when the server advertised a way to repaint), then say how complete the
/// picture is. Counts only, never a payload.
async fn recover_and_report(a: &mut Active, out: &Out) -> std::io::Result<Option<RdpClosedReason>> {
    let mut force = false;
    if a.stage.take_bitmap_recovery_request() {
        force = true;
        let (w, h) = (a.desk.fb.width(), a.desk.fb.height());
        let sendable = (a.refresh_rect || a.suppress_output) && w > 0 && h > 0 && w <= u32::from(u16::MAX) && h <= u32::from(u16::MAX);
        if sendable && a.health.allow_recovery(Instant::now()) {
            match a.stage.request_full_redraw(w as u16, h as u16, a.refresh_rect, a.suppress_output) {
                Ok(frames) => {
                    for frame in frames {
                        if a.writer.write_all(&frame).await.is_err() {
                            return Ok(Some(RdpClosedReason::NetworkError));
                        }
                    }
                    a.health.recovered();
                }
                Err(_) => a.health.recovery_skipped(),
            }
        } else {
            a.health.recovery_skipped();
        }
    }
    if let Some(s) = a.health.due(Instant::now(), force) {
        out.send(&EngineEvent::Stats {
            updates: s.updates,
            pixels: s.pixels,
            last_update_ms: s.last_update_ms,
            discarded: s.discarded,
            recoveries: s.recoveries,
            recovery_skipped: s.recovery_skipped,
            ignored_outputs: s.ignored_outputs,
        })?;
    }
    Ok(None)
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
        Control::Input { generation, events } => {
            let (batches, next) = drain_input((generation, events), control);
            *held = next;
            handle_inputs(a, out, &batches)
        }
        Control::SetOwner { generation, request } => {
            // The release is computed from what THIS process applied, against THIS framebuffer as it is now.
            let release = a.driver.hand_over(generation, (a.desk.fb.width(), a.desk.fb.height()));
            let released = release.len() as u32;
            let outputs = if release.is_empty() { Vec::new() } else { handle_inputs(a, out, &[(generation, release)])? };
            out.send(&EngineEvent::OwnerSet { request, released })?;
            Ok(outputs)
        }
        Control::Screenshot => {
            a.desk.screenshot(out)?;
            Ok(Vec::new())
        }
        Control::Ack(frame_id) => {
            a.desk.ack(out, frame_id)?;
            Ok(Vec::new())
        }
        Control::Refresh => {
            a.desk.refresh(out)?;
            Ok(Vec::new())
        }
    }
}

/// Collect every input batch already queued behind `first`, stopping at the
/// first other command (returned so the caller can handle it next).
pub fn drain_input(
    first: (u64, Vec<protocol::InputEvent>),
    control: &mut tokio::sync::mpsc::Receiver<Control>,
) -> (Vec<(u64, Vec<protocol::InputEvent>)>, Option<Control>) {
    let mut batches = vec![first];
    loop {
        match control.try_recv() {
            Ok(Control::Input { generation, events }) => batches.push((generation, events)),
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
                a.health.applied(rect.w, rect.h);
                a.desk.dirty(out, rect)?;
            }
            ActiveStageOutput::Terminate(reason) => return Ok(Some(map_terminate(&reason))),
            // Output kinds this engine does not act on, each counted (`ignored_outputs`) so a silent drop is visible:
            // - pointer shape/position/visibility: the owner's view draws its own pointer, the remote one is not forwarded;
            // - monitor layout: one monitor only, the desktop size is fixed at connect;
            // - windowing orders and anything IronRDP adds later: no such channel is negotiated, nothing to apply.
            ActiveStageOutput::PointerDefault
            | ActiveStageOutput::PointerHidden
            | ActiveStageOutput::PointerPosition { .. }
            | ActiveStageOutput::PointerBitmap(_)
            | ActiveStageOutput::MonitorLayout(_) => a.health.ignored_output(),
            _ => a.health.ignored_output(),
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
    // Sized for the client frame (the larger header), so the helper forwards
    // every band whole and `chunks` is the band count the view sees.
    let rows_per_chunk = protocol::rows_per_chunk(rect.w, protocol::CLIENT_UPDATE_OVERHEAD) as u32;
    let chunks = rect.h.div_ceil(rows_per_chunk);
    let mut y = rect.y;
    let mut remaining = rect.h;
    let mut band = 0u32;
    let mut pixels = Vec::new();
    while remaining > 0 {
        let chunk_h = remaining.min(rows_per_chunk);
        let sub = fb.copy_region(rect.x, y, rect.w, chunk_h, &mut pixels);
        out.send_frame(&protocol::encode_update_band(
            0,
            fb.frame_id(),
            fb.width(),
            fb.height(),
            sub.x,
            sub.y,
            sub.w,
            sub.h,
            band,
            chunks,
            &pixels,
        ))?;
        y += chunk_h;
        remaining -= chunk_h;
        band += 1;
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
        let chunks = png.len().div_ceil(protocol::SCREENSHOT_CHUNK_BASE64);
        if chunks > protocol::MAX_SCREENSHOT_CHUNKS as usize {
            return out.send(&EngineEvent::ScreenshotError { code: "screenshot_too_large".to_string() });
        }
        out.send(&EngineEvent::ScreenshotStart {
            frame_id: fb.frame_id(),
            width: fb.width(),
            height: fb.height(),
            timestamp: fb.last_update_ms(),
            chunks: chunks as u32,
        })?;
        for (index, part) in png.as_bytes().chunks(protocol::SCREENSHOT_CHUNK_BASE64).enumerate() {
            // base64 is ASCII, so any byte boundary is a char boundary.
            out.send(&EngineEvent::ScreenshotChunk {
                index: index as u32,
                data: String::from_utf8_lossy(part).into_owned(),
            })?;
        }
        return Ok(());
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
    batches: &[(u64, Vec<protocol::InputEvent>)],
) -> std::io::Result<Vec<ActiveStageOutput>> {
    let fb = Geometry { width: a.desk.fb.width(), height: a.desk.fb.height() };
    let mut fast = Vec::new();
    for (generation, batch) in batches {
        // Input queued under an older driver is dropped here, wherever it was in the pipe when the driver changed.
        if !a.driver.accepts(*generation) {
            continue;
        }
        let encoded = encode_input(batch, fb);
        let refused: Vec<u32> = encoded.rejected.iter().map(|r| r.index).collect();
        a.driver.applied(batch, &refused);
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
        tx.try_send(Control::Input { generation: 0, events: vec![mv(2)] }).unwrap();
        tx.try_send(Control::Input { generation: 0, events: vec![mv(3), mv(4)] }).unwrap();
        tx.try_send(Control::Screenshot).unwrap();
        tx.try_send(Control::Input { generation: 0, events: vec![mv(9)] }).unwrap();
        let (batches, next) = drain_input((0, vec![mv(1)]), &mut rx);
        assert_eq!(batches.len(), 3);
        assert_eq!(batches.iter().map(|b| b.1.len()).sum::<usize>(), 4);
        assert!(matches!(next, Some(Control::Screenshot)));
        // the input behind the screenshot is still queued, in order
        assert!(matches!(rx.try_recv(), Ok(Control::Input { .. })));
        let (batches, next) = drain_input((0, vec![mv(1)]), &mut rx);
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

    /// R2: a 3840x2160 noisy desktop (an ~33 MiB PNG, ~44 MiB of base64) no
    /// longer fits one frame and is no longer refused: it is sent as a header
    /// plus ordered chunks, no frame larger than the wire limit, no more than
    /// MAX_SCREENSHOT_CHUNKS of them (so `screenshot_too_large` cannot be
    /// reached at the largest desktop), and the chunks reassemble to the PNG.
    #[test]
    fn a_huge_screenshot_is_sent_as_ordered_chunks_that_reassemble() {
        let desk = noisy_desk(3840, 2160);
        let frames = frames_sent(&desk);
        assert!(frames.len() >= 3 && frames.len() <= 1 + protocol::MAX_SCREENSHOT_CHUNKS as usize, "{} frames", frames.len());
        assert!(frames.iter().all(|f| f.len() < 1_153_434), "a frame exceeded 1.1 MiB");
        let EngineEvent::ScreenshotStart { width, height, chunks, .. } = serde_json::from_slice(&frames[0][5..]).unwrap() else {
            panic!("the first frame must be the chunked header")
        };
        assert_eq!((width, height), (3840, 2160));
        assert_eq!(chunks as usize, frames.len() - 1);
        let mut b64 = String::new();
        for (i, f) in frames[1..].iter().enumerate() {
            let EngineEvent::ScreenshotChunk { index, data } = serde_json::from_slice(&f[5..]).unwrap() else {
                panic!("frame {i} is not a chunk")
            };
            assert_eq!(index as usize, i);
            b64.push_str(&data);
        }
        let decoded = base64_decode(&b64);
        let mut reader = png::Decoder::new(std::io::Cursor::new(decoded)).read_info().unwrap();
        let mut buf = vec![0u8; reader.output_buffer_size().unwrap()];
        let info = reader.next_frame(&mut buf).unwrap();
        assert_eq!(&buf[..info.buffer_size()], desk.fb.pixels());
    }

    /// R1: a refresh resends the WHOLE framebuffer under a frame id that no
    /// earlier update used (the pixels did not change, so the id would otherwise
    /// repeat and a consumer would have to treat it as a stream error).
    #[test]
    fn a_refresh_sends_the_whole_frame_under_a_new_frame_id() {
        use std::io::Read as _;
        let mut fb = Framebuffer::new(8, 4).unwrap();
        fb.apply(0, 0, 8, 4, &vec![7u8; 8 * 4 * 4], 1).unwrap();
        let mut desk = Desk::new(fb);
        let (engine_end, mut peer) = std::os::unix::net::UnixStream::pair().unwrap();
        let out = Out::new(engine_end);
        desk.dirty(&out, Rect { x: 0, y: 0, w: 8, h: 4 }).unwrap(); // desktop + update, frame 1 in flight
        desk.refresh(&out).unwrap(); // coalesced behind the in-flight update
        desk.ack(&out, 1).unwrap(); // releases the refreshed full frame
        drop(out);
        let mut all = Vec::new();
        peer.read_to_end(&mut all).unwrap();
        let mut updates = Vec::new(); // (frame_id, x, y, w, h)
        let mut at = 0;
        while at < all.len() {
            let len = u32::from_le_bytes(all[at..at + 4].try_into().unwrap()) as usize;
            let body = &all[at + 4..at + 4 + len];
            if body[0] == protocol::FRAME_BINARY {
                let (header, _) = protocol::decode_update_body(&body[1..]).unwrap();
                updates.push((header.frame_id, header.x, header.y, header.w, header.h));
            }
            at += 4 + len;
        }
        assert_eq!(updates, vec![(1, 0, 0, 8, 4), (2, 0, 0, 8, 4)]);
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

    /// A clock the test moves; counts reads so it can tell the loop looked again.
    struct TestClock {
        millis: std::sync::atomic::AtomicU64,
        reads: std::sync::atomic::AtomicU64,
    }

    impl Clock for TestClock {
        fn now(&self) -> std::time::Duration {
            use std::sync::atomic::Ordering::SeqCst;
            self.reads.fetch_add(1, SeqCst);
            std::time::Duration::from_millis(self.millis.load(SeqCst))
        }
    }

    /// An `Active` over streams that never deliver a byte (the server is quiet).
    fn quiet_active() -> (Active, tokio::io::DuplexStream, tokio::io::DuplexStream) {
        use ironrdp_svc::StaticChannelSet;
        let (client_r, server_r) = tokio::io::duplex(4096);
        let (client_w, server_w) = tokio::io::duplex(4096);
        let reader_stream: super::super::connect::BoxStream = Box::new(client_r);
        let writer_stream: super::super::connect::BoxStream = Box::new(client_w);
        let (reader, _unused_w) = tokio::io::split(reader_stream);
        let (_unused_r, writer) = tokio::io::split(writer_stream);
        let stage = ActiveStageBuilder {
            static_channels: StaticChannelSet::new(),
            user_channel_id: 1002,
            io_channel_id: 1003,
            message_channel_id: None,
            share_id: 1,
            compression_type: None,
            enable_server_pointer: false,
            pointer_software_rendering: false,
        }
        .build();
        let a = Active {
            reader: ironrdp_tokio::TokioFramed::new(reader),
            writer: ironrdp_tokio::TokioFramed::new(writer),
            stage,
            image: DecodedImage::new(PixelFormat::RgbA32, 8, 8),
            desk: Desk::new(Framebuffer::new(8, 8).unwrap()),
            driver: Driver::default(),
            health: Health::new(),
            refresh_rect: true,
            suppress_output: false,
        };
        (a, server_r, server_w)
    }

    fn event_texts(out: Out, peer: &mut std::os::unix::net::UnixStream) -> String {
        use std::io::Read as _;
        drop(out);
        let mut all = Vec::new();
        peer.read_to_end(&mut all).unwrap();
        String::from_utf8_lossy(&all).to_string()
    }

    #[test]
    fn a_handover_in_the_engine_drops_older_input_and_releases_what_it_applied_against_its_own_framebuffer() {
        use super::super::protocol::InputEvent;
        let (mut a, _r, _w) = quiet_active();
        let (engine_end, mut peer) = std::os::unix::net::UnixStream::pair().unwrap();
        let out = Out::new(engine_end);
        let (_tx, mut control) = tokio::sync::mpsc::channel::<Control>(8);
        let mut held = None;
        let press = |down| InputEvent::MouseButton { button: "left".into(), down, x: 7, y: 7, geom_width: 8, geom_height: 8 };
        // The first driver (generation 0) presses at the far corner of an 8x8 desktop.
        handle_control(&mut a, &out, Control::Input { generation: 0, events: vec![press(true)] }, &mut control, &mut held).unwrap();
        assert_eq!(a.driver.held(), 1);
        // The desktop shrinks, then the driver changes: the release lands inside the NEW 4x4 desktop and is accepted.
        a.desk = Desk::new(Framebuffer::new(4, 4).unwrap());
        handle_control(&mut a, &out, Control::SetOwner { generation: 1, request: 9 }, &mut control, &mut held).unwrap();
        assert_eq!(a.driver.held(), 0, "the held button was released");
        // Input of the old generation that was still in the pipe is dropped, not applied.
        handle_control(&mut a, &out, Control::Input { generation: 0, events: vec![InputEvent::Key { scancode: 0x1e, extended: false, down: true }] }, &mut control, &mut held).unwrap();
        assert_eq!(a.driver.held(), 0, "stale input must not be applied");
        handle_control(&mut a, &out, Control::Input { generation: 1, events: vec![InputEvent::Key { scancode: 0x1e, extended: false, down: true }] }, &mut control, &mut held).unwrap();
        assert_eq!(a.driver.held(), 1, "the new driver's input is applied");
        let text = event_texts(out, &mut peer);
        assert!(text.contains("\"type\":\"owner_set\"") && text.contains("\"request\":9") && text.contains("\"released\":1"), "{text}");
        assert!(!text.contains("input_rejected"), "the release must be valid for the current geometry: {text}");
    }

    /// Run `drive` while `script` moves the clock; returns the Closed reason the
    /// helper would see (None when the loop was ended by cancellation first).
    fn drive_scripted(
        painted: bool,
        script: impl FnOnce(
            Arc<TestClock>,
            Arc<std::sync::atomic::AtomicBool>,
            Arc<Cancel>,
            tokio::sync::mpsc::Sender<Control>,
        ) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()>>>,
    ) -> Option<String> {
        use std::io::Read as _;
        use std::sync::atomic::Ordering::SeqCst;
        let clock = Arc::new(TestClock { millis: 0.into(), reads: 0.into() });
        let (mut a, _s1, _s2) = quiet_active();
        a.desk.desktop_sent = painted;
        let (engine_end, mut peer) = std::os::unix::net::UnixStream::pair().unwrap();
        let out = Out::new(engine_end);
        let (tx, rx) = tokio::sync::mpsc::channel::<Control>(4);
        let cancel = Arc::new(Cancel::new());
        let done = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let _ = rt.block_on(async {
            let paint = FirstPaint::new(clock.clone(), std::time::Duration::from_secs(30));
            let driven = async {
                let r = drive(a, &out, rx, &cancel, paint).await;
                done.store(true, SeqCst);
                r
            };
            let scripted = script(clock.clone(), done.clone(), cancel.clone(), tx);
            // Hang guard: the whole scene must finish.
            tokio::time::timeout(std::time::Duration::from_secs(30), async { tokio::join!(driven, scripted) })
                .await
                .expect("hang guard: drive did not finish")
        });
        drop(out);
        let mut all = Vec::new();
        peer.read_to_end(&mut all).unwrap();
        if all.len() < 5 {
            return None;
        }
        match serde_json::from_slice::<EngineEvent>(&all[5..]).unwrap() {
            EngineEvent::Closed { reason } => Some(reason),
            other => panic!("unexpected event {other:?}"),
        }
    }

    /// Wait (async) until the loop has read the clock `n` more times.
    async fn looked_again(clock: &TestClock, n: u64) {
        use std::sync::atomic::Ordering::SeqCst;
        let target = clock.reads.load(SeqCst) + n;
        while clock.reads.load(SeqCst) < target {
            tokio::time::sleep(std::time::Duration::from_millis(1)).await;
        }
    }

    /// H7: a server that never paints ends the session as `timeout`: not at
    /// 29 s of the 30 s budget, at 31 s.
    #[test]
    fn a_session_that_never_paints_times_out_after_the_first_paint_budget() {
        use std::sync::atomic::Ordering::SeqCst;
        let reason = drive_scripted(false, |clock, done, _cancel, tx| {
            Box::pin(async move {
                // Keep the command channel open: its closing ends the loop.
                let _open = tx;
                clock.millis.store(29_000, SeqCst);
                looked_again(&clock, 2).await;
                assert!(!done.load(SeqCst), "timed out at 29 s of a 30 s budget");
                clock.millis.store(31_000, SeqCst);
                // Hold the channel open until the loop has ended on its own.
                while !done.load(SeqCst) {
                    tokio::time::sleep(std::time::Duration::from_millis(1)).await;
                }
            })
        });
        assert_eq!(reason.as_deref(), Some("timeout"));
    }

    /// H7: once the desktop has painted there is no first-paint deadline.
    #[test]
    fn a_painted_session_has_no_first_paint_deadline() {
        use std::sync::atomic::Ordering::SeqCst;
        let reason = drive_scripted(true, |clock, done, cancel, tx| {
            Box::pin(async move {
                clock.millis.store(100_000, SeqCst);
                // Two commands force two more passes through the loop; the
                // second is consumed only if the first pass did not end the
                // session (the capacity returns to 4 when both are taken).
                tx.send(Control::Ack(0)).await.unwrap();
                tx.send(Control::Ack(0)).await.unwrap();
                while tx.capacity() < 4 {
                    tokio::time::sleep(std::time::Duration::from_millis(1)).await;
                }
                assert!(!done.load(SeqCst), "a painted session timed out");
                cancel.trigger(RdpClosedReason::KilledByClose);
                while !done.load(SeqCst) {
                    tokio::time::sleep(std::time::Duration::from_millis(1)).await;
                }
            })
        });
        assert_eq!(reason.as_deref(), Some("killed_by_close"));
    }

    #[test]
    fn base64_matches_rfc_vectors() {
        assert_eq!(base64_encode(b""), "");
        assert_eq!(base64_encode(b"f"), "Zg==");
        assert_eq!(base64_encode(b"fo"), "Zm8=");
        assert_eq!(base64_encode(b"foo"), "Zm9v");
        assert_eq!(base64_encode(b"foobar"), "Zm9vYmFy");
    }

    // ---- picture completeness: discarded updates are answered with a full-redraw request ----

    /// A Fast-Path Bitmap update that claims more bytes than it carries (the shape ironrdp discards and latches recovery on).
    fn truncated_bitmap_pdu() -> Vec<u8> {
        use ironrdp_pdu::fast_path::{EncryptionFlags, FastPathHeader, UpdateCode};
        let mut frame = ironrdp_core::encode_vec(&FastPathHeader::new(EncryptionFlags::empty(), 1 + 2 + 3_200)).unwrap();
        frame.push(UpdateCode::Bitmap.as_u8());
        frame.extend_from_slice(&48_788u16.to_le_bytes());
        frame.resize(frame.len() + 3_200, 0);
        frame
    }

    fn run<T>(f: impl std::future::Future<Output = T>) -> T {
        tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(f)
    }

    /// What the (fake) server has received so far from the client, without waiting for more.
    fn received(server: &mut tokio::io::DuplexStream) -> Vec<u8> {
        use tokio::io::AsyncReadExt as _;
        run(async {
            let mut buf = vec![0u8; 4096];
            match tokio::time::timeout(std::time::Duration::from_millis(100), server.read(&mut buf)).await {
                Ok(Ok(n)) => buf[..n].to_vec(),
                _ => Vec::new(),
            }
        })
    }

    fn feed_truncated(a: &mut Active) {
        let dispatch = tracing_core::Dispatch::new(health::test_counter());
        tracing_core::dispatcher::with_default(&dispatch, || {
            let frame = truncated_bitmap_pdu();
            a.stage.process(&mut a.image, ironrdp_pdu::Action::FastPath, &frame, None).expect("a malformed update is not fatal");
        });
    }

    fn stats_of(out: Out, peer: &mut std::os::unix::net::UnixStream) -> Vec<serde_json::Value> {
        event_texts(out, peer)
            .split(|c: char| !c.is_ascii() || c.is_control())
            .flat_map(|chunk| chunk.match_indices("{\"type\":\"stats\"").map(|(i, _)| chunk[i..].to_string()).collect::<Vec<_>>())
            .filter_map(|t| serde_json::Deserializer::from_str(&t).into_iter::<serde_json::Value>().next().and_then(|r| r.ok()))
            .collect()
    }

    #[test]
    fn a_discarded_bitmap_update_is_answered_with_one_full_redraw_request_and_counted() {
        let (mut a, mut server_to_client_unused, mut client_to_server) = quiet_active();
        let _ = &mut server_to_client_unused;
        let (engine_end, mut peer) = std::os::unix::net::UnixStream::pair().unwrap();
        let out = Out::new(engine_end);
        feed_truncated(&mut a);
        assert!(run(recover_and_report(&mut a, &out)).unwrap().is_none());
        assert!(!received(&mut client_to_server).is_empty(), "a redraw request must reach the server");
        // IronRDP latches: the same loss reported again is not a second request.
        feed_truncated(&mut a);
        assert!(run(recover_and_report(&mut a, &out)).unwrap().is_none());
        assert!(received(&mut client_to_server).is_empty(), "no second request for the same latch");
        let stats = stats_of(out, &mut peer);
        let last = stats.last().expect("stats were sent");
        assert!(last["discarded"].as_u64().unwrap() >= 1, "{last}");
        assert_eq!(last["recoveries"], 1, "{last}");
        assert_eq!(last["recovery_skipped"], 0, "{last}");
    }

    #[test]
    fn without_a_way_to_repaint_no_request_is_sent_and_the_skip_is_counted() {
        let (mut a, _unused, mut client_to_server) = quiet_active();
        a.refresh_rect = false;
        a.suppress_output = false;
        let (engine_end, mut peer) = std::os::unix::net::UnixStream::pair().unwrap();
        let out = Out::new(engine_end);
        feed_truncated(&mut a);
        run(recover_and_report(&mut a, &out)).unwrap();
        assert!(received(&mut client_to_server).is_empty());
        let stats = stats_of(out, &mut peer);
        let last = stats.last().unwrap();
        assert_eq!((last["recoveries"].clone(), last["recovery_skipped"].clone()), (0.into(), 1.into()), "{last}");
    }

    #[test]
    fn requests_are_capped_per_minute_even_if_the_latch_is_rearmed() {
        let (mut a, _unused, _w) = quiet_active();
        let (engine_end, mut peer) = std::os::unix::net::UnixStream::pair().unwrap();
        let out = Out::new(engine_end);
        // Pre-fill the window so the cap is already reached, then a fresh loss.
        for _ in 0..health::RECOVERY_CAP {
            assert!(a.health.allow_recovery(Instant::now()));
        }
        feed_truncated(&mut a);
        run(recover_and_report(&mut a, &out)).unwrap();
        let stats = stats_of(out, &mut peer);
        let last = stats.last().unwrap();
        assert_eq!((last["recoveries"].clone(), last["recovery_skipped"].clone()), (0.into(), 1.into()), "{last}");
    }

    #[test]
    fn output_kinds_the_engine_does_not_act_on_are_counted_not_silent() {
        let (mut a, _r, _w) = quiet_active();
        let (engine_end, _peer) = std::os::unix::net::UnixStream::pair().unwrap();
        let out = Out::new(engine_end);
        let outputs = vec![ActiveStageOutput::PointerDefault, ActiveStageOutput::PointerHidden, ActiveStageOutput::PointerPosition { x: 1, y: 2 }];
        assert!(run(handle_outputs(&mut a, &out, outputs)).unwrap().is_none());
        assert_eq!(a.health.snapshot().ignored_outputs, 3);
        let region = InclusiveRectangle { left: 0, top: 0, right: 3, bottom: 1 };
        run(handle_outputs(&mut a, &out, vec![ActiveStageOutput::GraphicsUpdate(region)])).unwrap();
        let s = a.health.snapshot();
        assert_eq!((s.updates, s.pixels), (1, 8), "a 4x2 region covers 8 pixels");
    }
}
