//! The `--rdp-engine` child: one process per RDP session. It reads length-
//! prefixed control frames from a socketpair on fd 3, runs the IronRDP
//! connection sequence with strict TLS and a certificate-decision callback,
//! owns one RGBA8 framebuffer, and streams state/desktop/update/screenshot
//! events back to the helper.
use std::io::{Read as _, Write as _};
use std::os::fd::FromRawFd;
use std::os::unix::net::UnixStream;
use std::sync::mpsc::{self, Receiver};
use std::future::Future;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use ironrdp_connector::sspi::generator::NetworkRequest;
use ironrdp_connector::{
    ClientConnector, Config, ConnectorError, ConnectorErrorKind, ConnectorResult, Credentials, DesktopSize,
    ServerName,
};
use ironrdp_graphics::image_processing::PixelFormat;
use ironrdp_session::image::DecodedImage;
use ironrdp_session::{ActiveStageBuilder, ActiveStageOutput};
use ironrdp_tls::{extract_tls_server_public_key, upgrade_with_certificate_validation_callback_for_endpoint};
use ironrdp_tokio::{
    connect_begin, connect_finalize, mark_as_upgraded, split_tokio_framed, FramedWrite as _, TokioFramed,
};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::net::TcpStream;

use super::cert::{fingerprint_matches, fingerprint_sha256, parse_cert_fields, CertFields};
use super::framebuffer::{Framebuffer, Rect};
use super::input::{validate_pointer, Geometry, PointerPosition};
use super::protocol::{self, EngineCommand, EngineEvent, InputEvent};
use super::reasons::RdpClosedReason;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const CERT_PROMPT_TIMEOUT: Duration = Duration::from_secs(60);
const MAX_HELPER_FRAME: usize = 1024 * 1024; // one helper frame stays <= 1 MiB

struct NoopNetworkClient;
impl ironrdp_tokio::NetworkClient for NoopNetworkClient {
    fn send(&mut self, _request: &NetworkRequest) -> impl Future<Output = ConnectorResult<Vec<u8>>> {
        async move {
            Err(ConnectorError::new(
                "kdc proxy",
                ConnectorErrorKind::Reason("no network client; Kerberos KDC proxying is not implemented".into()),
            ))
        }
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn write_frame(stream: &mut UnixStream, frame: &[u8]) -> std::io::Result<()> {
    stream.write_all(frame)
}

fn read_frame(stream: &mut UnixStream) -> std::io::Result<Option<Vec<u8>>> {
    let mut len_buf = [0u8; 4];
    let mut got = 0;
    while got < 4 {
        match stream.read(&mut len_buf[got..]) {
            Ok(0) if got == 0 => return Ok(None),
            Ok(0) => return Err(std::io::Error::other("short frame header")),
            Ok(n) => got += n,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(e),
        }
    }
    let len = u32::from_le_bytes(len_buf) as usize;
    if len == 0 || len > protocol::RDP_MAX_FRAME_BODY {
        return Err(std::io::Error::other("frame body length out of range"));
    }
    let mut body = vec![0u8; len];
    stream.read_exact(&mut body)?;
    Ok(Some(body))
}

fn send_control(stream: &mut UnixStream, event: &EngineEvent) {
    let _ = write_frame(stream, &protocol::encode_control(event));
}

fn send_state(stream: &mut UnixStream, state: &str) {
    send_control(stream, &EngineEvent::State { state: state.to_string() });
}

fn connector_config(host: String, username: String, password: String, domain: Option<String>, width: u32, height: u32) -> Config {
    Config {
        desktop_size: DesktopSize { width: width as u16, height: height as u16 },
        monitor_layout: None,
        desktop_scale_factor: 0,
        desktop_physical_size: None,
        desktop_orientation: None,
        device_scale_factor: None,
        monitor_extended_layout: None,
        relative_mouse_input: false,
        enable_tls: true,
        enable_credssp: true,
        enable_standard_rdp_security: false,
        credentials: Credentials::UsernamePassword { username, password },
        domain,
        client_build: 2600,
        client_name: host,
        keyboard_type: ironrdp_pdu::gcc::KeyboardType::IBM_ENHANCED,
        keyboard_subtype: 0,
        keyboard_functional_keys_count: 12,
        keyboard_layout: 0x409,
        connection_type: ironrdp_pdu::gcc::ConnectionType::Lan,
        ime_file_name: String::new(),
        bitmap: None,
        dig_product_id: String::new(),
        client_dir: String::new(),
        alternate_shell: String::new(),
        work_dir: String::new(),
        remote_application_mode: false,
        rail_support_level: ironrdp_pdu::rdp::capability_sets::RailSupportLevel::empty(),
        platform: ironrdp_pdu::rdp::capability_sets::MajorPlatformType::UNSPECIFIED,
        hardware_id: None,
        request_data: None,
        autologon: false,
        enable_audio_playback: false,
        enable_audio_capture: false,
        performance_flags: ironrdp_pdu::rdp::client_info::PerformanceFlags::default(),
        license_cache: None,
        timezone_info: ironrdp_pdu::rdp::client_info::TimezoneInfo::default(),
        compression_type: None,
        enable_server_pointer: false,
        pointer_software_rendering: false,
        multitransport_flags: None,
        support_dyn_vc_gfx_protocol: false,
    }
}

fn map_connector_error(e: &ConnectorError) -> RdpClosedReason {
    match e.kind() {
        ConnectorErrorKind::AccessDenied => RdpClosedReason::AuthFailed,
        ConnectorErrorKind::Credssp(_) => RdpClosedReason::AuthFailed,
        _ => RdpClosedReason::ProtocolError,
    }
}

pub fn run_engine() -> i32 {
    let stream = unsafe { UnixStream::from_raw_fd(3) };
    match engine_main(stream) {
        Ok(code) => code,
        Err(_) => 1,
    }
}

fn engine_main(mut stream: UnixStream) -> Result<i32, std::io::Error> {
    // First frame must be Open. All parameters (including the password) arrive
    // over this socketpair, never argv/env/file.
    let open = loop {
        match read_frame(&mut stream)? {
            Some(body) if body.first() == Some(&protocol::FRAME_CONTROL) => {
                match serde_json::from_slice::<EngineCommand>(&body[1..]) {
                    Ok(cmd @ EngineCommand::Open { .. }) => break cmd,
                    _ => continue,
                }
            }
            Some(_) => continue,
            None => return Ok(0),
        }
    };
    let EngineCommand::Open { host, port, username, password, domain, width, height, expected_fingerprint } = open
    else {
        return Ok(1);
    };

    let (decision_tx, decision_rx): (mpsc::Sender<(String, String)>, Receiver<(String, String)>) = mpsc::channel();
    let (input_tx, mut input_rx) = tokio::sync::mpsc::unbounded_channel::<Vec<InputEvent>>();
    let screenshot_requested = Arc::new(Mutex::new(false));
    let close_requested = Arc::new(Mutex::new(false));
    let forced_reason: Arc<Mutex<Option<RdpClosedReason>>> = Arc::new(Mutex::new(None));

    {
        let mut read_stream = stream.try_clone()?;
        let decision_tx = decision_tx.clone();
        let input_tx = input_tx.clone();
        let screenshot_requested = screenshot_requested.clone();
        let close_requested = close_requested.clone();
        std::thread::spawn(move || loop {
            match read_frame(&mut read_stream) {
                Ok(Some(body)) if body.first() == Some(&protocol::FRAME_CONTROL) => {
                    let Ok(cmd) = serde_json::from_slice::<EngineCommand>(&body[1..]) else { continue };
                    match cmd {
                        EngineCommand::CertDecision { fingerprint, accept } => {
                            let _ = decision_tx.send((fingerprint, accept));
                        }
                        EngineCommand::Input { events } => {
                            let _ = input_tx.send(events);
                        }
                        EngineCommand::Screenshot => {
                            *screenshot_requested.lock().unwrap() = true;
                        }
                        EngineCommand::Close => {
                            *close_requested.lock().unwrap() = true;
                            let _ = decision_tx.send((String::new(), "reject".to_string()));
                        }
                        EngineCommand::Open { .. } => {}
                    }
                }
                Ok(Some(_)) => {}
                Ok(None) | Err(_) => break,
            }
        });
    }

    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("build tokio runtime");
    rt.block_on(connect_and_run(
        host,
        port,
        username,
        password,
        domain,
        width,
        height,
        expected_fingerprint,
        &mut stream,
        decision_rx,
        &mut input_rx,
        screenshot_requested,
        close_requested,
        forced_reason,
    ));
    Ok(0)
}

#[allow(clippy::too_many_arguments)]
async fn connect_and_run(
    host: String,
    port: u16,
    username: String,
    password: String,
    domain: Option<String>,
    width: u32,
    height: u32,
    expected_fingerprint: Option<String>,
    stream: &mut UnixStream,
    decision_rx: Receiver<(String, String)>,
    input_rx: &mut tokio::sync::mpsc::UnboundedReceiver<Vec<InputEvent>>,
    screenshot_requested: Arc<Mutex<bool>>,
    close_requested: Arc<Mutex<bool>>,
    forced_reason: Arc<Mutex<Option<RdpClosedReason>>>,
) {
    send_state(stream, "connecting");
    let result = tokio::time::timeout(CONNECT_TIMEOUT, connect_sequence(
        host, port, username, password, domain, width, height, expected_fingerprint, decision_rx, &forced_reason, stream,
    ))
    .await;
    match result {
        Err(_) => send_control(stream, &EngineEvent::Closed { reason: RdpClosedReason::Timeout.as_str().to_string() }),
        Ok(Ok(mut session)) => run_active_stage(&mut session, stream, input_rx, screenshot_requested, close_requested).await,
        Ok(Err(reason)) => {
            let forced = forced_reason.lock().unwrap().take();
            send_control(stream, &EngineEvent::Closed { reason: forced.unwrap_or(reason).as_str().to_string() });
        }
    }
}

type FramedRead = TokioFramed<tokio::io::ReadHalf<Box<dyn AsyncReadWrite + Unpin + Send + Sync>>>;
type FramedWrite = TokioFramed<tokio::io::WriteHalf<Box<dyn AsyncReadWrite + Unpin + Send + Sync>>>;

trait AsyncReadWrite: AsyncRead + AsyncWrite + Unpin + Send + Sync {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send + Sync> AsyncReadWrite for T {}

struct Session {
    reader: FramedRead,
    writer: FramedWrite,
    active_stage: ironrdp_session::ActiveStage,
    framebuffer: Framebuffer,
    desktop_sent: bool,
}

#[allow(clippy::too_many_arguments)]
async fn connect_sequence(
    host: String,
    port: u16,
    username: String,
    password: String,
    domain: Option<String>,
    width: u32,
    height: u32,
    expected_fingerprint: Option<String>,
    decision_rx: Receiver<(String, String)>,
    forced_reason: &Arc<Mutex<Option<RdpClosedReason>>>,
    stream: &mut UnixStream,
) -> Result<Session, RdpClosedReason> {
    let tcp = TcpStream::connect((host.as_str(), port)).await.map_err(|_| RdpClosedReason::NetworkError)?;
    let client_addr = tcp.local_addr().map_err(|_| RdpClosedReason::NetworkError)?;
    let config = connector_config(host.clone(), username, password, domain, width, height);
    let mut connector = ClientConnector::new(config, client_addr);
    let mut framed = TokioFramed::new(tcp);

    send_state(stream, "tls");
    let should_upgrade = connect_begin(&mut framed, &mut connector).await.map_err(|_| RdpClosedReason::NetworkError)?;
    let (initial_stream, leftover) = framed.into_inner();

    let expected = expected_fingerprint.clone();
    let forced = forced_reason.clone();
    let decision_rx = Arc::new(Mutex::new(decision_rx));
    let cb_stream = Arc::new(Mutex::new(stream.try_clone().map_err(|_| RdpClosedReason::TlsError)?));
    let callback: ironrdp_tls::CertificateValidationCallback = Arc::new(move |der, _endpoint, error| {
        let presented = fingerprint_sha256(der);
        if let Some(expected) = &expected {
            if !fingerprint_matches(&presented, expected) {
                *forced.lock().unwrap() = Some(RdpClosedReason::CertChanged);
                return false;
            }
            return true;
        }
        send_state(&mut *cb_stream.lock().unwrap(), "cert_prompt");
        let fields = parse_cert_fields(der).unwrap_or(CertFields {
            subject: String::new(),
            issuer: String::new(),
            not_before: String::new(),
            not_after: String::new(),
        });
        send_control(&mut *cb_stream.lock().unwrap(), &EngineEvent::CertPrompt {
            host: String::new(),
            port: 0,
            fingerprint: presented.clone(),
            subject: fields.subject,
            issuer: fields.issuer,
            not_before: fields.not_before,
            not_after: fields.not_after,
            reason: error.to_string(),
        });
        match decision_rx.lock().unwrap().recv_timeout(CERT_PROMPT_TIMEOUT) {
            Ok((decision_fp, accept)) if fingerprint_matches(&presented, &decision_fp) && (accept == "once" || accept == "session_trust") => true,
            _ => {
                *forced.lock().unwrap() = Some(RdpClosedReason::CertRejected);
                false
            }
        }
    });

    let (tls_stream, tls_cert) = upgrade_with_certificate_validation_callback_for_endpoint(initial_stream, &host, &host, callback)
        .await
        .map_err(|_| RdpClosedReason::TlsError)?;
    let server_public_key = extract_tls_server_public_key(&tls_cert).ok_or(RdpClosedReason::TlsError)?.to_vec();
    let upgraded = mark_as_upgraded(should_upgrade, &mut connector);

    send_state(stream, "authenticating");
    let mut upgraded_framed = TokioFramed::new_with_leftover(Box::new(tls_stream) as Box<dyn AsyncReadWrite + Unpin + Send + Sync>, leftover);
    let outcome = connect_finalize(
        upgraded,
        connector,
        &mut upgraded_framed,
        &mut NoopNetworkClient,
        ServerName::from(host.as_str()),
        server_public_key,
        None,
    )
    .await
    .map_err(|e| map_connector_error(&e))?;
    let connection = outcome.into_connected().map_err(|e| map_connector_error(&e))?;

    let framebuffer = Framebuffer::new(connection.desktop_size.width as u32, connection.desktop_size.height as u32)
        .map_err(|_| RdpClosedReason::ProtocolError)?;
    let active_stage = ActiveStageBuilder {
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
    let (reader, writer) = split_tokio_framed(upgraded_framed);

    Ok(Session { reader, writer, active_stage, framebuffer, desktop_sent: false })
}

async fn run_active_stage(
    session: &mut Session,
    stream: &mut UnixStream,
    input_rx: &mut tokio::sync::mpsc::UnboundedReceiver<Vec<InputEvent>>,
    screenshot_requested: Arc<Mutex<bool>>,
    close_requested: Arc<Mutex<bool>>,
) {
    let mut image = DecodedImage::new(PixelFormat::RgbA32, session.framebuffer.width() as u16, session.framebuffer.height() as u16);

    loop {
        if *close_requested.lock().unwrap() {
            send_control(stream, &EngineEvent::Closed { reason: RdpClosedReason::KilledByClose.as_str().to_string() });
            return;
        }
        if *screenshot_requested.lock().unwrap() {
            *screenshot_requested.lock().unwrap() = false;
            send_screenshot(session, stream);
        }

        let outputs = tokio::select! {
            frame = session.reader.read_pdu() => {
                match frame {
                    Ok((action, payload)) => match session.active_stage.process(&mut image, action, &payload, None) {
                        Ok(o) => o,
                        Err(_) => {
                            send_control(stream, &EngineEvent::Closed { reason: RdpClosedReason::ProtocolError.as_str().to_string() });
                            return;
                        }
                    },
                    Err(_) => {
                        send_control(stream, &EngineEvent::Closed { reason: RdpClosedReason::NetworkError.as_str().to_string() });
                        return;
                    }
                }
            }
            events = input_rx.recv() => {
                match events {
                    Some(events) => encode_and_apply_input(session, &events).unwrap_or_default(),
                    None => {
                        send_control(stream, &EngineEvent::Closed { reason: RdpClosedReason::HelperShutdown.as_str().to_string() });
                        return;
                    }
                }
            }
        };

        let mut done = false;
        for out in outputs {
            match out {
                ActiveStageOutput::ResponseFrame(frame) => {
                    let _ = session.writer.write_all(&frame).await;
                }
                ActiveStageOutput::GraphicsUpdate(_region) => {
                    let rect = apply_image(session, &image);
                    if !session.desktop_sent && session.framebuffer.frame_id() > 0 {
                        session.desktop_sent = true;
                        send_control(stream, &EngineEvent::Desktop {
                            frame_id: session.framebuffer.frame_id(),
                            width: session.framebuffer.width(),
                            height: session.framebuffer.height(),
                            timestamp: session.framebuffer.last_update_ms(),
                        });
                    }
                    if let Some(rect) = rect {
                        let _ = send_update_chunked(session, stream, rect);
                    }
                }
                ActiveStageOutput::Terminate(_reason) => done = true,
                _ => {}
            }
        }
        if done {
            send_control(stream, &EngineEvent::Closed { reason: RdpClosedReason::ProtocolError.as_str().to_string() });
            return;
        }
    }
}

/// Copy the decoded image into the engine framebuffer and return the region to
/// send (the whole frame, split into <= 1 MiB helper frames on the way out).
fn apply_image(session: &mut Session, image: &DecodedImage) -> Option<Rect> {
    let w = image.width() as u32;
    let h = image.height() as u32;
    if w != session.framebuffer.width() || h != session.framebuffer.height() {
        return None;
    }
    session.framebuffer.apply(0, 0, w, h, image.data(), now_ms()).ok()?;
    Some(Rect { x: 0, y: 0, w, h })
}

fn send_update_chunked(session: &Session, stream: &mut UnixStream, rect: Rect) -> std::io::Result<()> {
    let bytes_per_row = rect.w as usize * 4;
    if bytes_per_row == 0 {
        return Ok(());
    }
    let rows_per_chunk = (MAX_HELPER_FRAME / bytes_per_row).max(1);
    let mut y = rect.y;
    let mut remaining = rect.h;
    let mut out = Vec::new();
    while remaining > 0 {
        let chunk_h = remaining.min(rows_per_chunk as u32);
        let sub = session.framebuffer.copy_region(rect.x, y, rect.w, chunk_h, &mut out);
        let frame = protocol::encode_update(
            0,
            session.framebuffer.frame_id(),
            session.framebuffer.width(),
            session.framebuffer.height(),
            sub.x,
            sub.y,
            sub.w,
            sub.h,
            &out,
        );
        write_frame(stream, &frame)?;
        y += chunk_h;
        remaining -= chunk_h;
    }
    Ok(())
}

fn send_screenshot(session: &Session, stream: &mut UnixStream) {
    let fb = &session.framebuffer;
    let mut png = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut png, fb.width(), fb.height());
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = match encoder.write_header() {
            Ok(w) => w,
            Err(_) => return,
        };
        if writer.write_image_data(fb.pixels()).is_err() {
            return;
        }
    }
    send_control(stream, &EngineEvent::Screenshot {
        frame_id: fb.frame_id(),
        width: fb.width(),
        height: fb.height(),
        timestamp: fb.last_update_ms(),
        png: base64_encode(&png),
    });
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

fn encode_and_apply_input(session: &mut Session, events: &[InputEvent]) -> Result<Vec<ActiveStageOutput>, ()> {
    use ironrdp_pdu::input::fast_path::{FastPathInputEvent, KeyboardFlags};
    use ironrdp_pdu::input::mouse::{MousePdu, PointerFlags};
    let fb = Geometry { width: session.framebuffer.width(), height: session.framebuffer.height() };
    let mut fast = Vec::new();
    for event in events {
        match event {
            InputEvent::MouseMove { x, y, geom_width, geom_height } => {
                validate_pointer(Geometry { width: *geom_width, height: *geom_height }, fb, PointerPosition { x: *x, y: *y }).map_err(|_| ())?;
                fast.push(FastPathInputEvent::MouseEvent(MousePdu {
                    flags: PointerFlags::MOVE,
                    number_of_wheel_rotation_units: 0,
                    x_position: *x as u16,
                    y_position: *y as u16,
                }));
            }
            InputEvent::MouseButton { button, down, x, y, geom_width, geom_height } => {
                validate_pointer(Geometry { width: *geom_width, height: *geom_height }, fb, PointerPosition { x: *x, y: *y }).map_err(|_| ())?;
                let mut flags = match button.as_str() {
                    "left" => PointerFlags::LEFT_BUTTON,
                    "right" => PointerFlags::RIGHT_BUTTON,
                    "middle" => PointerFlags::MIDDLE_BUTTON_OR_WHEEL,
                    _ => return Err(()),
                };
                if *down {
                    flags |= PointerFlags::DOWN;
                }
                fast.push(FastPathInputEvent::MouseEvent(MousePdu {
                    flags,
                    number_of_wheel_rotation_units: 0,
                    x_position: *x as u16,
                    y_position: *y as u16,
                }));
            }
            InputEvent::MouseWheel { vertical, horizontal, x, y, geom_width, geom_height } => {
                validate_pointer(Geometry { width: *geom_width, height: *geom_height }, fb, PointerPosition { x: *x, y: *y }).map_err(|_| ())?;
                if *vertical != 0 {
                    let mut flags = PointerFlags::VERTICAL_WHEEL;
                    if *vertical < 0 {
                        flags |= PointerFlags::WHEEL_NEGATIVE;
                    }
                    fast.push(FastPathInputEvent::MouseEvent(MousePdu {
                        flags,
                        number_of_wheel_rotation_units: (*vertical).clamp(-256, 255) as i16,
                        x_position: *x as u16,
                        y_position: *y as u16,
                    }));
                }
                if *horizontal != 0 {
                    let mut flags = PointerFlags::HORIZONTAL_WHEEL;
                    if *horizontal < 0 {
                        flags |= PointerFlags::WHEEL_NEGATIVE;
                    }
                    fast.push(FastPathInputEvent::MouseEvent(MousePdu {
                        flags,
                        number_of_wheel_rotation_units: (*horizontal).clamp(-256, 255) as i16,
                        x_position: *x as u16,
                        y_position: *y as u16,
                    }));
                }
            }
            InputEvent::Key { scancode, extended, down } => {
                if !super::input::valid_scancode(*scancode) {
                    return Err(());
                }
                let mut flags = KeyboardFlags::empty();
                if !*down {
                    flags |= KeyboardFlags::RELEASE;
                }
                if *extended {
                    flags |= KeyboardFlags::EXTENDED;
                }
                fast.push(FastPathInputEvent::KeyboardEvent(flags, *scancode));
            }
            InputEvent::CtrlAltDel => {
                fast.push(FastPathInputEvent::KeyboardEvent(KeyboardFlags::empty(), 0x1D));
                fast.push(FastPathInputEvent::KeyboardEvent(KeyboardFlags::empty(), 0x38));
                fast.push(FastPathInputEvent::KeyboardEvent(KeyboardFlags::EXTENDED, 0x53));
                fast.push(FastPathInputEvent::KeyboardEvent(KeyboardFlags::EXTENDED | KeyboardFlags::RELEASE, 0x53));
                fast.push(FastPathInputEvent::KeyboardEvent(KeyboardFlags::RELEASE, 0x38));
                fast.push(FastPathInputEvent::KeyboardEvent(KeyboardFlags::RELEASE, 0x1D));
            }
            InputEvent::Unicode { text } => {
                for ch in text.chars() {
                    if (ch as u32) <= 0xFFFF {
                        fast.push(FastPathInputEvent::UnicodeKeyboardEvent(KeyboardFlags::empty(), ch as u16));
                    }
                }
            }
        }
    }
    if fast.is_empty() {
        return Ok(Vec::new());
    }
    let mut image = DecodedImage::new(PixelFormat::RgbA32, session.framebuffer.width() as u16, session.framebuffer.height() as u16);
    session.active_stage.process_fastpath_input(&mut image, &fast).map_err(|_| ())
}
