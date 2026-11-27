//! Wire frames (S14 spec §4): `[u32 LE body length][body]`, body[0] = kind.
//!   0x01 control: UTF-8 JSON; 0x02 data: u32 LE reqId + bytes; 0x03 secret: u32 LE reqId + UTF-8.
//! Length is validated before any allocation.
use std::io::{self, Read, Write};
use zeroize::Zeroizing;

pub const KIND_CONTROL: u8 = 1;
pub const KIND_DATA: u8 = 2;
pub const KIND_SECRET: u8 = 3;
/// JSON payload range for control frames (body = 1 + payload).
pub const CONTROL_MIN: usize = 2;
pub const CONTROL_MAX: usize = 1 << 20;
pub const DATA_MAX: usize = 4 << 20;
pub const SECRET_MAX: usize = 1024;

#[derive(Debug)]
pub enum Frame {
    Control(serde_json::Value),
    Data { req: u32, bytes: Vec<u8> },
    Secret { req: u32, bytes: Zeroizing<Vec<u8>> },
}

#[derive(Debug)]
pub enum FrameError {
    /// Violation of the wire format; fatal (`protocol_error`).
    Protocol(&'static str),
    Eof,
    Io(io::Error),
}

fn read_exact_or(r: &mut impl Read, buf: &mut [u8], at_boundary: bool) -> Result<(), FrameError> {
    let mut done = 0;
    while done < buf.len() {
        match r.read(&mut buf[done..]) {
            Ok(0) => {
                return Err(if at_boundary && done == 0 { FrameError::Eof } else { FrameError::Protocol("eof inside a frame") });
            }
            Ok(n) => done += n,
            Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(FrameError::Io(e)),
        }
    }
    Ok(())
}

/// Read one frame. `Err(Eof)` only on a clean end of stream between frames.
pub fn read_frame(r: &mut impl Read) -> Result<Frame, FrameError> {
    let mut len = [0u8; 4];
    read_exact_or(r, &mut len, true)?;
    let len = u32::from_le_bytes(len) as usize;
    if len == 0 {
        return Err(FrameError::Protocol("zero-length frame"));
    }
    // Peek the kind first so the bound can be applied before allocating.
    let mut kind = [0u8; 1];
    read_exact_or(r, &mut kind, false)?;
    let rest = len - 1;
    match kind[0] {
        KIND_CONTROL => {
            if !(CONTROL_MIN..=CONTROL_MAX).contains(&rest) {
                return Err(FrameError::Protocol("control frame length out of range"));
            }
            let mut body = vec![0u8; rest];
            read_exact_or(r, &mut body, false)?;
            let text = std::str::from_utf8(&body).map_err(|_| FrameError::Protocol("control frame is not UTF-8"))?;
            let value: serde_json::Value = serde_json::from_str(text).map_err(|_| FrameError::Protocol("control frame is not JSON"))?;
            if !value.is_object() {
                return Err(FrameError::Protocol("control frame is not an object"));
            }
            Ok(Frame::Control(value))
        }
        KIND_DATA => {
            if rest < 4 || rest - 4 > DATA_MAX {
                return Err(FrameError::Protocol("data frame length out of range"));
            }
            let mut body = vec![0u8; rest];
            read_exact_or(r, &mut body, false)?;
            let req = u32::from_le_bytes([body[0], body[1], body[2], body[3]]);
            body.drain(..4);
            Ok(Frame::Data { req, bytes: body })
        }
        KIND_SECRET => {
            if rest < 5 || rest - 4 > SECRET_MAX {
                return Err(FrameError::Protocol("secret frame length out of range"));
            }
            let mut body = Zeroizing::new(vec![0u8; rest]);
            read_exact_or(r, &mut body, false)?;
            let req = u32::from_le_bytes([body[0], body[1], body[2], body[3]]);
            let secret = Zeroizing::new(body[4..].to_vec());
            if std::str::from_utf8(&secret).is_err() {
                return Err(FrameError::Protocol("secret frame is not UTF-8"));
            }
            Ok(Frame::Secret { req, bytes: secret })
        }
        _ => Err(FrameError::Protocol("unknown frame kind")),
    }
}

pub fn write_control(w: &mut impl Write, value: &serde_json::Value) -> io::Result<()> {
    let payload = serde_json::to_vec(value).map_err(io::Error::other)?;
    if payload.len() > CONTROL_MAX {
        return Err(io::Error::other("control frame too large"));
    }
    let mut out = Vec::with_capacity(payload.len() + 5);
    out.extend_from_slice(&((payload.len() as u32 + 1).to_le_bytes()));
    out.push(KIND_CONTROL);
    out.extend_from_slice(&payload);
    w.write_all(&out)?;
    w.flush()
}

pub fn write_data(w: &mut impl Write, req: u32, bytes: &[u8]) -> io::Result<()> {
    if bytes.len() > DATA_MAX {
        return Err(io::Error::other("data frame too large"));
    }
    let mut head = Vec::with_capacity(9);
    head.extend_from_slice(&((bytes.len() as u32 + 5).to_le_bytes()));
    head.push(KIND_DATA);
    head.extend_from_slice(&req.to_le_bytes());
    w.write_all(&head)?;
    w.write_all(bytes)?;
    w.flush()
}
