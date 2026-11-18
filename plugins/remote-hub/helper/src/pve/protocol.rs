//! Typed frames between the helper and its `--pve-engine` child, carried over a socketpair.
//! Same framing as the RDP engine: `[u32 LE body length][body]`, body[0] = kind (0x01 control JSON,
//! 0x02 raw terminal bytes). Secrets travel only inside the `Open` command.
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncRead, AsyncReadExt};

use crate::secret::Secret;

pub const FRAME_CONTROL: u8 = 0x01;
pub const FRAME_DATA: u8 = 0x02;
/// Largest frame body in either direction.
pub const MAX_BODY: usize = 4 * 1024 * 1024;
/// Console bytes per engine → helper data frame.
pub const DATA_CHUNK: usize = 16 * 1024;

pub fn encode_frame(kind: u8, payload: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(5 + payload.len());
    out.extend_from_slice(&((payload.len() + 1) as u32).to_le_bytes());
    out.push(kind);
    out.extend_from_slice(payload);
    out
}

pub fn encode_control<T: Serialize>(msg: &T) -> Vec<u8> {
    encode_frame(FRAME_CONTROL, &serde_json::to_vec(msg).expect("serialize pve control"))
}

pub fn encode_data(bytes: &[u8]) -> Vec<u8> {
    encode_frame(FRAME_DATA, bytes)
}

/// Read one frame body. `None` on a clean EOF at a frame boundary.
pub async fn read_frame(r: &mut (impl AsyncRead + Unpin)) -> std::io::Result<Option<Vec<u8>>> {
    let mut len_buf = [0u8; 4];
    match r.read(&mut len_buf[..1]).await? {
        0 => return Ok(None),
        _ => r.read_exact(&mut len_buf[1..]).await?,
    };
    let len = u32::from_le_bytes(len_buf) as usize;
    if len == 0 || len > MAX_BODY {
        return Err(std::io::Error::other("frame body length out of range"));
    }
    let mut body = vec![0u8; len];
    r.read_exact(&mut body).await?;
    Ok(Some(body))
}

/// Incremental frame cutter for the helper side (non-blocking socket).
pub enum Take {
    Incomplete,
    Frame(Vec<u8>),
    Violation,
}

pub fn take_frame(buf: &mut Vec<u8>) -> Take {
    if buf.len() < 4 {
        return Take::Incomplete;
    }
    let len = u32::from_le_bytes([buf[0], buf[1], buf[2], buf[3]]) as usize;
    if len == 0 || len > MAX_BODY {
        return Take::Violation;
    }
    if buf.len() < 4 + len {
        return Take::Incomplete;
    }
    let body = buf[4..4 + len].to_vec();
    buf.drain(..4 + len);
    Take::Frame(body)
}

/// Where the API answers. The host is a name or an address; the engine refuses anything else.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Endpoint {
    pub host: String,
    pub port: u16,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "mode", rename_all = "snake_case")]
pub enum PveAuth {
    /// User + password: a ticket session (cookie and CSRF token).
    Ticket { username: String, password: Secret },
    /// `user@realm!tokenname` and its secret.
    Token { token_id: String, secret: Secret },
}

/// How the server certificate is trusted. There is no "ignore" mode.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "mode", rename_all = "snake_case")]
pub enum Trust {
    /// The operating system's roots.
    System,
    /// One CA the owner supplied (DER, lower-case hex), in addition to nothing else.
    Ca { der_hex: String },
    /// This exact leaf certificate (SHA-256, colon hex), confirmed earlier by the owner.
    Pin { fingerprint: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ConsoleTarget {
    /// The node's own shell (`/nodes/{node}/termproxy`).
    Node { node: String },
    /// An LXC container terminal (`/nodes/{node}/lxc/{vmid}/termproxy`).
    Lxc { node: String, vmid: u32 },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum PveOp {
    /// Login, version, nodes and guests. One answer, then the engine exits.
    Targets,
    Terminal { target: ConsoleTarget, cols: u16, rows: u16 },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum PveCommand {
    /// The one parameter frame. All secrets are in `auth`.
    Open {
        endpoint: Endpoint,
        auth: PveAuth,
        trust: Trust,
        op: PveOp,
        /// Seconds between terminal keep-alive pings; 30 when absent, 1..=120 otherwise.
        #[serde(default)]
        keepalive_secs: Option<u64>,
    },
    Resize { cols: u16, rows: u16 },
    Close,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NodeInfo {
    pub node: String,
    pub status: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GuestInfo {
    pub vmid: u32,
    pub name: String,
    /// `qemu` or `lxc`.
    pub kind: String,
    pub node: String,
    pub status: String,
    pub template: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum PveEvent {
    State { state: String },
    Targets { version: Option<String>, nodes: Vec<NodeInfo>, guests: Vec<GuestInfo> },
    /// A failure with a closed set of codes: login_failed, no_permission, unreachable, timeout, tls_untrusted,
    /// cert_changed, tfa_required, api_error, protocol_error, console_refused, invalid_request.
    /// `fingerprint` is the certificate the server presented (tls_untrusted, cert_changed).
    Error {
        code: String,
        message: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        fingerprint: Option<String>,
    },
    Closed { reason: String },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frames_round_trip_and_cut_incrementally() {
        let mut wire = encode_data(b"abc");
        wire.extend(encode_control(&PveEvent::State { state: "open".into() }));
        let mut buf = Vec::new();
        buf.extend_from_slice(&wire[..3]);
        assert!(matches!(take_frame(&mut buf), Take::Incomplete));
        buf.extend_from_slice(&wire[3..]);
        match take_frame(&mut buf) {
            Take::Frame(b) => assert_eq!(b, vec![FRAME_DATA, b'a', b'b', b'c']),
            _ => panic!("first frame"),
        }
        match take_frame(&mut buf) {
            Take::Frame(b) => {
                assert_eq!(b[0], FRAME_CONTROL);
                assert_eq!(std::str::from_utf8(&b[1..]).unwrap(), r#"{"type":"state","state":"open"}"#);
            }
            _ => panic!("second frame"),
        }
        assert!(buf.is_empty());
    }

    #[test]
    fn a_zero_or_oversized_length_is_a_violation() {
        let mut zero = vec![0, 0, 0, 0, 1];
        assert!(matches!(take_frame(&mut zero), Take::Violation));
        let mut big = ((MAX_BODY as u32) + 1).to_le_bytes().to_vec();
        big.push(1);
        assert!(matches!(take_frame(&mut big), Take::Violation));
    }

    #[test]
    fn open_wire_shape_is_stable_and_debug_hides_the_secret() {
        let cmd = PveCommand::Open {
            endpoint: Endpoint { host: "pve.test".into(), port: 8006 },
            auth: PveAuth::Ticket { username: "remotehub@pve".into(), password: Secret::new("S3cr3t-MARK") },
            trust: Trust::Pin { fingerprint: "AA".into() },
            op: PveOp::Terminal { target: ConsoleTarget::Lxc { node: "n1".into(), vmid: 101 }, cols: 80, rows: 24 },
            keepalive_secs: None,
        };
        assert_eq!(
            serde_json::to_string(&cmd).unwrap(),
            r#"{"type":"open","endpoint":{"host":"pve.test","port":8006},"auth":{"mode":"ticket","username":"remotehub@pve","password":"S3cr3t-MARK"},"trust":{"mode":"pin","fingerprint":"AA"},"op":{"op":"terminal","target":{"kind":"lxc","node":"n1","vmid":101},"cols":80,"rows":24},"keepalive_secs":null}"#
        );
        assert!(!format!("{cmd:?}").contains("S3cr3t"));
    }
}
