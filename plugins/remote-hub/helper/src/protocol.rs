//! The versioned stdio protocol, mirrored by src/core/protocol.ts on the
//! TypeScript side. A frame is:
//!
//!   [ u32 LE body length ][ body ]
//!   body[0] = kind: 0x01 control (JSON), 0x02 binary stream
//!   control = body[0] kind, body[1..] UTF-8 JSON
//!   stream  = body[0] kind, body[1..5] u32 LE sessionId,
//!             body[5..9] u32 LE seq, body[9..] terminal bytes
use serde::{Deserialize, Serialize};

pub const PROTOCOL_VERSION: u32 = 1;
pub const MAX_FRAME_BODY_BYTES: usize = 16 * 1024 * 1024;
pub const FRAME_KIND_CONTROL: u8 = 0x01;
pub const FRAME_KIND_STREAM: u8 = 0x02;
pub const STREAM_HEADER_BYTES: usize = 8;

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum Request {
    #[serde(rename = "hello")]
    Hello { protocol: u32 },
    #[serde(rename = "ping")]
    Ping { id: u64 },
    #[serde(rename = "session.open_echo")]
    OpenEcho { id: u64, cols: u16, rows: u16 },
    #[serde(rename = "session.input")]
    SessionInput {
        id: u64,
        #[serde(rename = "sessionId")]
        session_id: u32,
        data: String,
    },
    #[serde(rename = "session.resize")]
    SessionResize {
        id: u64,
        #[serde(rename = "sessionId")]
        session_id: u32,
        cols: u16,
        rows: u16,
    },
    #[serde(rename = "session.close")]
    SessionClose {
        id: u64,
        #[serde(rename = "sessionId")]
        session_id: u32,
    },
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum Response {
    #[serde(rename = "hello_ack")]
    HelloAck {
        protocol: u32,
        #[serde(rename = "helperVersion")]
        helper_version: String,
        platform: String,
        pid: u32,
    },
    #[serde(rename = "pong")]
    Pong { id: u64 },
    #[serde(rename = "session.opened")]
    SessionOpened {
        id: u64,
        #[serde(rename = "sessionId")]
        session_id: u32,
        cols: u16,
        rows: u16,
        pid: u32,
    },
    #[serde(rename = "session.input_ack")]
    SessionInputAck {
        id: u64,
        #[serde(rename = "sessionId")]
        session_id: u32,
    },
    #[serde(rename = "session.resized")]
    SessionResized {
        id: u64,
        #[serde(rename = "sessionId")]
        session_id: u32,
        cols: u16,
        rows: u16,
    },
    #[serde(rename = "session.closed")]
    SessionClosed {
        id: Option<u64>,
        #[serde(rename = "sessionId")]
        session_id: u32,
    },
    #[serde(rename = "error")]
    Error {
        id: Option<u64>,
        code: String,
        message: String,
    },
}

fn encode_frame_body(body: Vec<u8>) -> Vec<u8> {
    let mut frame = Vec::with_capacity(4 + body.len());
    frame.extend_from_slice(&(body.len() as u32).to_le_bytes());
    frame.extend_from_slice(&body);
    frame
}

fn encode_frame(kind: u8, payload: &[u8]) -> Vec<u8> {
    let mut body = Vec::with_capacity(1 + payload.len());
    body.push(kind);
    body.extend_from_slice(payload);
    encode_frame_body(body)
}

pub fn encode_request(req: &Request) -> Vec<u8> {
    let json = serde_json::to_vec(req).expect("serialize request");
    encode_frame(FRAME_KIND_CONTROL, &json)
}

pub fn encode_response(resp: &Response) -> Vec<u8> {
    let json = serde_json::to_vec(resp).expect("serialize response");
    encode_frame(FRAME_KIND_CONTROL, &json)
}

pub fn encode_stream(session_id: u32, seq: u32, data: &[u8]) -> Vec<u8> {
    let mut body = Vec::with_capacity(1 + STREAM_HEADER_BYTES + data.len());
    body.push(FRAME_KIND_STREAM);
    body.extend_from_slice(&session_id.to_le_bytes());
    body.extend_from_slice(&seq.to_le_bytes());
    body.extend_from_slice(data);
    encode_frame_body(body)
}

pub fn decode_response(json: &[u8]) -> Result<Response, serde_json::Error> {
    serde_json::from_slice(json)
}
