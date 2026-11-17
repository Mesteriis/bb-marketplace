//! Length-prefixed frame protocol between the helper and its `--rdp-engine`
//! child, carried over a socketpair. The same framing as the helper's stdio
//! protocol: `[u32 LE body length][body]`, body[0] = kind (0x01 control JSON,
//! 0x02 binary framebuffer update).
use serde::{Deserialize, Serialize};

/// One helper→engine frame may carry a full-screen RGBA update; allow enough.
pub const RDP_MAX_FRAME_BODY: usize = 64 * 1024 * 1024;
pub const FRAME_CONTROL: u8 = 0x01;
pub const FRAME_BINARY: u8 = 0x02;

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
        password: String,
        domain: Option<String>,
        width: u32,
        height: u32,
        expected_fingerprint: Option<String>,
    },
    CertDecision { fingerprint: String, accept: String },
    Input { events: Vec<InputEvent> },
    Screenshot,
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

#[derive(Debug, Clone, Serialize, Deserialize)]
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
        reason: String,
    },
    Desktop { frame_id: u64, width: u32, height: u32, timestamp: u64 },
    Closed { reason: String },
    Screenshot { frame_id: u64, width: u32, height: u32, timestamp: u64, png: String },
    Error { code: String, message: String },
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

#[cfg(test)]
mod tests {
    use super::*;

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
