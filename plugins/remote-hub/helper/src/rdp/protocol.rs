//! Length-prefixed frame protocol between the helper and its `--rdp-engine`
//! child, carried over a socketpair. The same framing as the helper's stdio
//! protocol: `[u32 LE body length][body]`, body[0] = kind (0x01 control JSON,
//! 0x02 binary framebuffer update).
use serde::{Deserialize, Serialize};

use crate::secret::Secret;

/// Largest engine → helper control frame body: the client's own frame limit,
/// so nothing the engine sends can be too large to relay. Binary update frames
/// are limited far lower.
pub const RDP_MAX_CONTROL_BODY: usize = crate::protocol::MAX_FRAME_BODY_BYTES;
/// Largest base64 screenshot PNG the engine will send (3.5 MiB). A larger one
/// is refused with `screenshot_too_large`; with the JSON around it the
/// response stays under the 4 MiB wire limit.
pub const MAX_SCREENSHOT_BASE64: usize = 3_670_016;
/// Largest helper → engine frame body: commands are small and the client's own
/// frame limit is 4 MiB.
pub const RDP_MAX_COMMAND_BODY: usize = 4 * 1024 * 1024;
/// A binary update frame (length prefix included) never exceeds 1 MiB on the
/// wire, on either hop.
pub const WIRE_FRAME_LIMIT: usize = 1_048_576;
/// Largest body of an engine → helper binary update frame.
pub const RDP_MAX_UPDATE_BODY: usize = WIRE_FRAME_LIMIT - 4;
pub const FRAME_CONTROL: u8 = 0x01;
pub const FRAME_BINARY: u8 = 0x02;

/// Non-pixel bytes of an engine → helper update frame: length prefix, kind and
/// the update header.
pub const ENGINE_UPDATE_OVERHEAD: usize = 4 + 1 + UPDATE_HEADER_BYTES;
/// Non-pixel bytes of a helper → client update stream frame: length prefix,
/// kind, stream header (sessionId + seq) and the 28-byte update header
/// {frameId u64, fbW, fbH, x, y, w, h}.
pub const CLIENT_UPDATE_OVERHEAD: usize = 4 + 1 + 8 + 28;

/// Rows of `width` RGBA pixels that fit one update frame once `overhead`
/// non-pixel bytes are counted. At least one row, so progress is always made.
pub fn rows_per_chunk(width: u32, overhead: usize) -> usize {
    let row = (width as usize).saturating_mul(4).max(4);
    (WIRE_FRAME_LIMIT.saturating_sub(overhead) / row).max(1)
}

/// Binary update body after the kind byte: session_id (u32) + the update
/// header + raw RGBA rows.
pub const UPDATE_HEADER_BYTES: usize = 4 /* session_id */ + 8 /* frame_id */ + 4 * 6 /* fb w/h, x,y,w,h */;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum EngineCommand {
    /// Open the (single) session this engine process owns. All parameters,
    /// including the password, travel only over this frame.
    Open {
        host: String,
        port: u16,
        username: String,
        password: Secret,
        domain: Option<String>,
        width: u32,
        height: u32,
        expected_fingerprint: Option<String>,
    },
    CertDecision { fingerprint: String, accept: String },
    Input { events: Vec<InputEvent> },
    Screenshot,
    /// The consumer received the update in flight (frame id of that update).
    Ack { frame_id: u64 },
    Close,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum InputEvent {
    MouseMove {
        x: u32,
        y: u32,
        geom_width: u32,
        geom_height: u32,
    },
    MouseButton {
        button: String,
        down: bool,
        x: u32,
        y: u32,
        geom_width: u32,
        geom_height: u32,
    },
    MouseWheel {
        vertical: i16,
        horizontal: i16,
        x: u32,
        y: u32,
        geom_width: u32,
        geom_height: u32,
    },
    Key {
        scancode: u8,
        extended: bool,
        down: bool,
    },
    CtrlAltDel,
    Unicode {
        text: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum EngineEvent {
    State { state: String },
    CertPrompt {
        host: String,
        port: u16,
        fingerprint: String,
        subject: String,
        issuer: String,
        not_before: String,
        not_after: String,
        /// Stable code: untrusted_root, hostname_mismatch, expired, other.
        reason: String,
        /// The TLS library's own text; diagnostic only.
        detail: Option<String>,
    },
    /// The peer certificate of the completed TLS handshake and whether it
    /// validated against the system roots (true) or only passed on a decision
    /// or a matching expected fingerprint (false).
    Certificate { fingerprint: String, validated: bool },
    Desktop { frame_id: u64, width: u32, height: u32, timestamp: u64 },
    Closed { reason: String },
    Screenshot { frame_id: u64, width: u32, height: u32, timestamp: u64, png: String },
    /// A screenshot request that could not be served (e.g. not_ready).
    ScreenshotError { code: String },
    /// Input events that were refused; the rest of the batch was applied.
    InputRejected { applied: u32, rejected: Vec<InputRejection> },
    Error { code: String, message: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InputRejection {
    pub index: u32,
    /// stale_geometry, out_of_bounds, invalid_scancode or invalid_button.
    pub code: String,
}

pub fn encode_body(kind: u8, payload: &[u8]) -> Vec<u8> {
    let mut body = Vec::with_capacity(1 + payload.len());
    body.push(kind);
    body.extend_from_slice(payload);
    body
}

pub fn encode_frame(kind: u8, payload: &[u8]) -> Vec<u8> {
    let body = encode_body(kind, payload);
    let mut frame = Vec::with_capacity(4 + body.len());
    frame.extend_from_slice(&(body.len() as u32).to_le_bytes());
    frame.extend_from_slice(&body);
    frame
}

pub fn encode_control<T: Serialize>(msg: &T) -> Vec<u8> {
    let json = serde_json::to_vec(msg).expect("serialize rdp control");
    encode_frame(FRAME_CONTROL, &json)
}

/// Encode a framebuffer update binary frame (engine → helper).
#[allow(clippy::too_many_arguments)]
pub fn encode_update(
    session_id: u32,
    frame_id: u64,
    fb_width: u32,
    fb_height: u32,
    x: u32,
    y: u32,
    w: u32,
    h: u32,
    rgba: &[u8],
) -> Vec<u8> {
    let mut payload = Vec::with_capacity(UPDATE_HEADER_BYTES + rgba.len());
    payload.extend_from_slice(&session_id.to_le_bytes());
    payload.extend_from_slice(&frame_id.to_le_bytes());
    payload.extend_from_slice(&fb_width.to_le_bytes());
    payload.extend_from_slice(&fb_height.to_le_bytes());
    payload.extend_from_slice(&x.to_le_bytes());
    payload.extend_from_slice(&y.to_le_bytes());
    payload.extend_from_slice(&w.to_le_bytes());
    payload.extend_from_slice(&h.to_le_bytes());
    payload.extend_from_slice(rgba);
    encode_frame(FRAME_BINARY, &payload)
}

#[derive(Debug)]
pub struct UpdateHeader {
    pub session_id: u32,
    pub frame_id: u64,
    pub fb_width: u32,
    pub fb_height: u32,
    pub x: u32,
    pub y: u32,
    pub w: u32,
    pub h: u32,
}

/// Decode a binary update body (everything after the kind byte).
pub fn decode_update_body(payload: &[u8]) -> Option<(UpdateHeader, &[u8])> {
    if payload.len() < UPDATE_HEADER_BYTES {
        return None;
    }
    let u32_at = |i: usize| u32::from_le_bytes(payload[i..i + 4].try_into().unwrap());
    let session_id = u32_at(0);
    let frame_id = u64::from_le_bytes(payload[4..12].try_into().unwrap());
    let fb_width = u32_at(12);
    let fb_height = u32_at(16);
    let x = u32_at(20);
    let y = u32_at(24);
    let w = u32_at(28);
    let h = u32_at(32);
    let rgba = &payload[UPDATE_HEADER_BYTES..];
    Some((UpdateHeader { session_id, frame_id, fb_width, fb_height, x, y, w, h }, rgba))
}

/// Check an engine update header against its payload. The engine is
/// untrusted: the pixel byte length must equal `w * h * 4`, the rectangle must
/// lie inside a framebuffer no larger than 3840x2160, and nothing may overflow.
pub fn update_is_valid(header: &UpdateHeader, rgba_len: usize) -> bool {
    use super::framebuffer::{MAX_DESKTOP_HEIGHT, MAX_DESKTOP_WIDTH};
    if header.fb_width == 0
        || header.fb_height == 0
        || header.fb_width > MAX_DESKTOP_WIDTH
        || header.fb_height > MAX_DESKTOP_HEIGHT
        || header.w == 0
        || header.h == 0
    {
        return false;
    }
    let (Some(right), Some(bottom)) = (header.x.checked_add(header.w), header.y.checked_add(header.h)) else {
        return false;
    };
    if right > header.fb_width || bottom > header.fb_height {
        return false;
    }
    let Some(expected) = (header.w as usize).checked_mul(header.h as usize).and_then(|n| n.checked_mul(4)) else {
        return false;
    };
    rgba_len == expected
}

#[cfg(test)]
mod tests {
    use super::*;

    fn header(fb_w: u32, fb_h: u32, x: u32, y: u32, w: u32, h: u32) -> UpdateHeader {
        UpdateHeader { session_id: 0, frame_id: 1, fb_width: fb_w, fb_height: fb_h, x, y, w, h }
    }

    #[test]
    fn update_validation_literals() {
        assert!(update_is_valid(&header(100, 100, 0, 0, 100, 100), 40000));
        assert!(update_is_valid(&header(3840, 2160, 3839, 2159, 1, 1), 4));
        assert!(!update_is_valid(&header(100, 100, 0, 0, 100, 100), 39999)); // short
        assert!(!update_is_valid(&header(100, 100, 0, 0, 100, 100), 40004)); // long
        assert!(!update_is_valid(&header(100, 100, 1, 0, 100, 1), 400)); // x+w = 101
        assert!(!update_is_valid(&header(100, 100, 0, 1, 1, 100), 400)); // y+h = 101
        assert!(!update_is_valid(&header(100, 100, u32::MAX, 0, 2, 1), 8)); // overflow
        assert!(!update_is_valid(&header(100, 100, 0, 0, 0, 1), 0)); // empty
        assert!(!update_is_valid(&header(3841, 100, 0, 0, 1, 1), 4)); // fb too wide
        assert!(!update_is_valid(&header(100, 2161, 0, 0, 1, 1), 4)); // fb too tall
        assert!(!update_is_valid(&header(0, 100, 0, 0, 1, 1), 4));
    }

    /// B5: a frame is at most 1 048 576 bytes on the wire, headers included.
    /// At width 512 a row is 2048 bytes; 511 rows + 41 bytes of framing is
    /// 1 046 569, while 512 rows would be 1 048 617.
    #[test]
    fn rows_per_chunk_counts_all_headers_at_width_512() {
        assert_eq!(ENGINE_UPDATE_OVERHEAD, 41);
        assert_eq!(CLIENT_UPDATE_OVERHEAD, 41);
        assert_eq!(rows_per_chunk(512, ENGINE_UPDATE_OVERHEAD), 511);
        assert_eq!(rows_per_chunk(512, CLIENT_UPDATE_OVERHEAD), 511);
        let rgba = vec![0u8; 511 * 512 * 4];
        let frame = encode_update(0, 1, 512, 512, 0, 0, 512, 511, &rgba);
        assert_eq!(frame.len(), 1_046_569);
        assert!(frame.len() <= 1_048_576);
        let too_big = encode_update(0, 1, 512, 512, 0, 0, 512, 512, &vec![0u8; 512 * 512 * 4]);
        assert_eq!(too_big.len(), 1_048_617);
    }

    #[test]
    fn rows_per_chunk_makes_progress_for_any_width() {
        assert_eq!(rows_per_chunk(3840, ENGINE_UPDATE_OVERHEAD), 68); // (1048576-41)/15360 = 68.26
        assert_eq!(rows_per_chunk(1, ENGINE_UPDATE_OVERHEAD), 262_133); // (1048576-41)/4
        assert_eq!(rows_per_chunk(u32::MAX, ENGINE_UPDATE_OVERHEAD), 1);
    }

    #[test]
    fn password_never_appears_in_command_debug() {
        let cmd = EngineCommand::Open {
            host: "h".into(),
            port: 1,
            username: "u".into(),
            password: Secret::new("S3cr3t-MARK-91"),
            domain: None,
            width: 1,
            height: 1,
            expected_fingerprint: None,
        };
        let text = format!("{cmd:?} {cmd:#?}");
        assert!(!text.contains("S3cr3t-MARK-91"), "password printed: {text}");
        assert!(text.contains("redacted"));
        // ...and still reaches the engine in the frame.
        let frame = encode_control(&cmd);
        assert!(String::from_utf8_lossy(&frame).contains("S3cr3t-MARK-91"));
    }

    #[test]
    fn update_frame_round_trips_header_and_pixels() {
        let rgba = vec![1u8, 2, 3, 4, 5, 6, 7, 8];
        let frame = encode_update(7, 42, 1920, 1080, 1, 2, 1, 2, &rgba);
        // frame = [len][kind][payload]
        assert_eq!(frame[4], FRAME_BINARY);
        let body_len = u32::from_le_bytes(frame[0..4].try_into().unwrap()) as usize;
        assert_eq!(body_len, 1 + UPDATE_HEADER_BYTES + rgba.len());
        let (header, out_rgba) = decode_update_body(&frame[5..]).unwrap();
        assert_eq!(header.session_id, 7);
        assert_eq!(header.frame_id, 42);
        assert_eq!(header.fb_width, 1920);
        assert_eq!(header.fb_height, 1080);
        assert_eq!(header.x, 1);
        assert_eq!(header.y, 2);
        assert_eq!(header.w, 1);
        assert_eq!(header.h, 2);
        assert_eq!(out_rgba, &rgba[..]);
    }

    #[test]
    fn decode_rejects_short_bodies() {
        assert!(decode_update_body(&[0u8; 3]).is_none());
    }
}
