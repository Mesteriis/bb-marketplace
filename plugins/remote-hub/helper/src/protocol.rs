//! The versioned stdio protocol, mirrored by src/core/protocol.ts on the
//! TypeScript side. A frame is:
//!
//!   [ u32 LE body length ][ body ]
//!   body[0] = kind: 0x01 control (JSON), 0x02 binary stream
//!   control = body[0] kind, body[1..] UTF-8 JSON
//!   stream  = body[0] kind, body[1..5] u32 LE sessionId,
//!             body[5..9] u32 LE seq, body[9..] terminal bytes
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

pub const PROTOCOL_VERSION: u32 = 1;
pub const MAX_FRAME_BODY_BYTES: usize = 4 * 1024 * 1024;
pub const FRAME_KIND_CONTROL: u8 = 0x01;
pub const FRAME_KIND_STREAM: u8 = 0x02;
pub const STREAM_HEADER_BYTES: usize = 8;

#[derive(Debug, Serialize, Deserialize)]
pub struct AskpassSpec {
    #[serde(rename = "credentialRef")]
    pub credential_ref: String,
    /// Test-hooks only: what a free-form "ssh" (a fake) is going to do, since its argv is not ssh's.
    #[cfg(feature = "test-hooks")]
    #[serde(default, rename = "testFacts")]
    pub test_facts: Option<crate::ssh_args::SshFacts>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum Request {
    #[serde(rename = "hello")]
    Hello { protocol: u32 },
    #[serde(rename = "ping")]
    Ping { id: u64 },
    #[serde(rename = "session.open_echo")]
    OpenEcho { id: u64, cols: u16, rows: u16 },
    #[serde(rename = "session.open_ssh")]
    OpenSsh {
        id: u64,
        cols: u16,
        rows: u16,
        program: String,
        argv: Vec<String>,
        env: HashMap<String, String>,
        cwd: Option<String>,
        /// A saved credential whose secret prompt the helper answers from the Keychain.
        #[serde(default)]
        askpass: Option<AskpassSpec>,
    },
    /// Runs ONE remote command with ssh and NO pty: stdin is closed, stdout and stderr are kept apart and bounded (stage 4b-2).
    /// The argv is the same strict ssh shape as `session.open_ssh` with `-T` and the command as the last word.
    #[serde(rename = "exec.run")]
    ExecRun {
        id: u64,
        program: String,
        argv: Vec<String>,
        env: HashMap<String, String>,
        /// A saved credential answered from the Keychain; any other prompt is refused, never shown.
        #[serde(default)]
        askpass: Option<AskpassSpec>,
        #[serde(rename = "timeoutMs")]
        timeout_ms: u64,
        /// Bytes kept per stream (the head); more is counted and dropped.
        #[serde(rename = "maxBytes")]
        max_bytes: usize,
    },
    /// What a run has produced from the given offsets (at most `max` bytes per stream).
    #[serde(rename = "exec.read")]
    ExecRead {
        id: u64,
        #[serde(rename = "execId")]
        exec_id: u32,
        #[serde(rename = "stdoutFrom")]
        stdout_from: u64,
        #[serde(rename = "stderrFrom")]
        stderr_from: u64,
        max: usize,
    },
    #[serde(rename = "exec.cancel")]
    ExecCancel {
        id: u64,
        #[serde(rename = "execId")]
        exec_id: u32,
    },
    /// Drops a finished run's buffers.
    #[serde(rename = "exec.forget")]
    ExecForget {
        id: u64,
        #[serde(rename = "execId")]
        exec_id: u32,
    },
    /// The user's answer to an `ssh.prompt` (`answer` null = cancelled). Never stored.
    #[serde(rename = "ssh.prompt_answer")]
    SshPromptAnswer {
        id: u64,
        #[serde(rename = "sessionId")]
        session_id: u32,
        #[serde(rename = "promptId")]
        prompt_id: u64,
        answer: Option<String>,
    },
    #[serde(rename = "session.input")]
    SessionInput {
        id: u64,
        #[serde(rename = "sessionId")]
        session_id: u32,
        data: String,
        /// Who is sending (stage 4b-1, Z2): "human" when absent.
        #[serde(default)]
        owner: Option<String>,
    },
    #[serde(rename = "session.resize")]
    SessionResize {
        id: u64,
        #[serde(rename = "sessionId")]
        session_id: u32,
        cols: u16,
        rows: u16,
    },
    #[serde(rename = "session.credit")]
    SessionCredit {
        id: u64,
        #[serde(rename = "sessionId")]
        session_id: u32,
        bytes: u64,
    },
    #[serde(rename = "session.close")]
    SessionClose {
        id: u64,
        #[serde(rename = "sessionId")]
        session_id: u32,
    },
    #[serde(rename = "session.open_rdp")]
    OpenRdp {
        id: u64,
        host: String,
        port: u16,
        username: String,
        /// Exactly one of `password` (use once) and `credentialRef` (a saved credential the
        /// helper resolves from the Keychain itself; the secret never travels back).
        #[serde(default)]
        password: Option<crate::secret::Secret>,
        #[serde(default, rename = "credentialRef")]
        credential_ref: Option<String>,
        domain: Option<String>,
        width: u32,
        height: u32,
        #[serde(rename = "expectedFingerprint")]
        expected_fingerprint: Option<String>,
        /// Compression, colour depth and experience switches (closed set; absent = the default).
        #[serde(default)]
        options: Option<crate::rdp::options::RdpOptions>,
    },
    /// Store (or replace) a secret in the Keychain under `ref`. The secret is consumed here.
    #[serde(rename = "credential.save")]
    CredentialSave {
        id: u64,
        #[serde(rename = "ref")]
        reference: String,
        secret: crate::secret::Secret,
        /// What the secret is for; stored with it and enforced by the helper.
        bind: crate::binding::Bind,
    },
    #[serde(rename = "credential.delete")]
    CredentialDelete {
        id: u64,
        #[serde(rename = "ref")]
        reference: String,
    },
    /// Whether the credential exists and the Keychain would hand it over. Never returns it.
    #[serde(rename = "credential.status")]
    CredentialStatus {
        id: u64,
        #[serde(rename = "ref")]
        reference: String,
    },
    /// The helper-owned known_hosts overlay: its lines (no path crosses the wire).
    #[serde(rename = "known_hosts.list")]
    KnownHostsList { id: u64 },
    #[serde(rename = "known_hosts.add")]
    KnownHostsAdd { id: u64, lines: Vec<String> },
    #[serde(rename = "known_hosts.remove")]
    KnownHostsRemove { id: u64, host: String },
    #[serde(rename = "rdp.cert_decision")]
    RdpCertDecision {
        id: u64,
        #[serde(rename = "sessionId")]
        session_id: u32,
        fingerprint: String,
        accept: String,
    },
    #[serde(rename = "rdp.input")]
    RdpInput {
        id: u64,
        #[serde(rename = "sessionId")]
        session_id: u32,
        events: Vec<crate::rdp::protocol::InputEvent>,
        /// Who is sending (stage 4b-1, Z2): "human" when absent. Input from anyone but the session's current owner is refused.
        #[serde(default)]
        owner: Option<String>,
    },
    /// The session has a new driver (a lease started or ended). Whatever the previous driver still had waiting in the
    /// helper is dropped, what it left pressed is released against the CURRENT desktop, and only then is this acknowledged:
    /// the barrier before the next driver's input is admitted.
    #[serde(rename = "session.set_owner")]
    SessionSetOwner {
        id: u64,
        #[serde(rename = "sessionId")]
        session_id: u32,
        owner: String,
    },
    #[serde(rename = "rdp.screenshot")]
    RdpScreenshot {
        id: u64,
        #[serde(rename = "sessionId")]
        session_id: u32,
    },
    /// Resend the whole framebuffer as the next update (a new or lagging view).
    #[serde(rename = "rdp.refresh")]
    RdpRefresh {
        id: u64,
        #[serde(rename = "sessionId")]
        session_id: u32,
    },
    /// The consumer received the update in flight; releases the next one.
    #[serde(rename = "rdp.update_ack")]
    RdpUpdateAck {
        id: u64,
        #[serde(rename = "sessionId")]
        session_id: u32,
        #[serde(rename = "frameId")]
        frame_id: u64,
    },
}

/// A slice of one stream of an exec run: bytes `start..end` of what was kept, as base64.
#[derive(Debug, Serialize, Deserialize)]
pub struct ExecChunk {
    pub start: u64,
    pub end: u64,
    pub data: String,
    /// Bytes the stream produced in all, kept or dropped.
    pub total: u64,
    /// Some bytes were dropped because the stream was over its bound.
    pub truncated: bool,
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
        generation: String,
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
        kind: String,
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
    #[serde(rename = "session.credit_ack")]
    SessionCreditAck {
        id: u64,
        #[serde(rename = "sessionId")]
        session_id: u32,
    },
    #[serde(rename = "session.closed")]
    SessionClosed {
        id: Option<u64>,
        #[serde(rename = "sessionId")]
        session_id: u32,
        #[serde(rename = "exitCode")]
        exit_code: Option<i32>,
        signal: Option<i32>,
        reason: String,
    },
    #[serde(rename = "session.owner_set")]
    SessionOwnerSet {
        id: u64,
        #[serde(rename = "sessionId")]
        session_id: u32,
        /// Bytes (terminal) or events (desktop) the previous driver had queued that were dropped.
        dropped: u64,
        /// Keys and buttons the previous driver left down that were released (desktop).
        released: u64,
    },
    #[serde(rename = "exec.started")]
    ExecStarted {
        id: u64,
        #[serde(rename = "execId")]
        exec_id: u32,
    },
    #[serde(rename = "exec.state")]
    ExecState {
        id: u64,
        #[serde(rename = "execId")]
        exec_id: u32,
        running: bool,
        #[serde(rename = "exitCode")]
        exit_code: Option<i32>,
        signal: Option<i32>,
        /// exited, timeout, cancelled, output_flood; null while running.
        reason: Option<String>,
        /// A question ssh asked that was refused: host_key, login_prompt (no text).
        refused: Option<String>,
        #[serde(rename = "elapsedMs")]
        elapsed_ms: u64,
        stdout: ExecChunk,
        stderr: ExecChunk,
    },
    /// A run ended (unsolicited), so the page need not poll.
    #[serde(rename = "exec.finished")]
    ExecFinished {
        #[serde(rename = "execId")]
        exec_id: u32,
        #[serde(rename = "exitCode")]
        exit_code: Option<i32>,
        signal: Option<i32>,
        reason: String,
        refused: Option<String>,
    },
    #[serde(rename = "exec.forgotten")]
    ExecForgotten { id: u64 },
    #[serde(rename = "error")]
    Error {
        id: Option<u64>,
        code: String,
        message: String,
    },
    #[serde(rename = "credential.ok")]
    CredentialOk { id: u64 },
    #[serde(rename = "known_hosts.lines")]
    KnownHostsLines { id: u64, lines: Vec<String> },
    /// How many lines an add or a remove changed.
    #[serde(rename = "known_hosts.done")]
    KnownHostsDone { id: u64, count: u32 },
    /// OpenSSH asked something the helper must not answer itself (a host key confirmation, an
    /// informational message): the user decides. `kind` is "confirm" or "none".
    #[serde(rename = "ssh.prompt")]
    SshPrompt {
        #[serde(rename = "sessionId")]
        session_id: u32,
        #[serde(rename = "promptId")]
        prompt_id: u64,
        text: String,
        kind: String,
    },
    /// The saved credential was used once and the server asked again: it was refused.
    #[serde(rename = "ssh.credential_used")]
    SshCredentialUsed {
        #[serde(rename = "sessionId")]
        session_id: u32,
    },
    #[serde(rename = "ssh.connected")]
    SshConnected {
        #[serde(rename = "sessionId")]
        session_id: u32,
    },
    #[serde(rename = "ssh.credential_rejected")]
    SshCredentialRejected {
        #[serde(rename = "sessionId")]
        session_id: u32,
    },
    /// The Keychain would not hand over the saved credential (`code`: keychain_locked, ...).
    #[serde(rename = "ssh.credential_failed")]
    SshCredentialFailed {
        #[serde(rename = "sessionId")]
        session_id: u32,
        code: String,
    },
    /// A question was refused because it was not answered in time, or its ssh went away.
    #[serde(rename = "ssh.prompt_expired")]
    SshPromptExpired {
        #[serde(rename = "sessionId")]
        session_id: u32,
        #[serde(rename = "promptId")]
        prompt_id: u64,
    },
    #[serde(rename = "ssh.prompt_ack")]
    SshPromptAck { id: u64 },
    /// The answer to `credential.status` (a different name: `credential.status` is the request).
    #[serde(rename = "credential.state")]
    CredentialStatus { id: u64, present: bool },
    #[serde(rename = "rdp.ack")]
    RdpAck {
        id: u64,
        #[serde(rename = "sessionId")]
        session_id: u32,
    },
    #[serde(rename = "rdp.state")]
    RdpState {
        #[serde(rename = "sessionId")]
        session_id: u32,
        state: String,
    },
    #[serde(rename = "rdp.cert_prompt")]
    RdpCertPrompt {
        #[serde(rename = "sessionId")]
        session_id: u32,
        host: String,
        port: u16,
        fingerprint: String,
        subject: String,
        issuer: String,
        #[serde(rename = "notBefore")]
        not_before: String,
        #[serde(rename = "notAfter")]
        not_after: String,
        /// Stable code: untrusted_root, hostname_mismatch, expired, other.
        reason: String,
        /// The TLS library's own text; diagnostic only.
        detail: Option<String>,
        /// The first use of a saved password: accepting this certificate pins the password to it.
        #[serde(rename = "firstUse", default)]
        first_use: bool,
    },
    /// The peer certificate of the finished TLS handshake and whether it
    /// validated against the system roots.
    #[serde(rename = "rdp.certificate")]
    RdpCertificate {
        #[serde(rename = "sessionId")]
        session_id: u32,
        fingerprint: String,
        validated: bool,
    },
    /// Input events the engine refused; the rest of the batch was applied.
    #[serde(rename = "rdp.input_rejected")]
    RdpInputRejected {
        #[serde(rename = "sessionId")]
        session_id: u32,
        applied: u32,
        rejected: Vec<crate::rdp::protocol::InputRejection>,
    },
    #[serde(rename = "rdp.desktop")]
    RdpDesktop {
        #[serde(rename = "sessionId")]
        session_id: u32,
        #[serde(rename = "frameId")]
        frame_id: u64,
        width: u32,
        height: u32,
        timestamp: u64,
    },
    #[serde(rename = "rdp.screenshot")]
    RdpScreenshot {
        id: u64,
        #[serde(rename = "sessionId")]
        session_id: u32,
        #[serde(rename = "frameId")]
        frame_id: u64,
        width: u32,
        height: u32,
        timestamp: u64,
        png: String,
        /// Present when the PNG is too large for one frame: `png` is empty and
        /// this many `rdp.screenshot_chunk` frames follow (indices 0..chunks-1),
        /// each carrying a slice of the base64 text.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        chunks: Option<u32>,
    },
    #[serde(rename = "rdp.screenshot_chunk")]
    RdpScreenshotChunk {
        id: u64,
        #[serde(rename = "sessionId")]
        session_id: u32,
        index: u32,
        count: u32,
        data: String,
    },
}

/// A parsed inbound stream frame (client -> helper terminal bytes).
pub struct InboundStream {
    pub session_id: u32,
    pub seq: u32,
    pub data: Vec<u8>,
}

pub fn decode_stream_body(payload: &[u8]) -> Option<InboundStream> {
    if payload.len() < STREAM_HEADER_BYTES {
        return None;
    }
    let session_id = u32::from_le_bytes(payload[0..4].try_into().ok()?);
    let seq = u32::from_le_bytes(payload[4..8].try_into().ok()?);
    Some(InboundStream {
        session_id,
        seq,
        data: payload[8..].to_vec(),
    })
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

/// A response never exceeds the wire limit: an oversized one is replaced by a
/// stable error, because the client treats a longer frame as fatal for every
/// session.
pub fn encode_response(resp: &Response) -> Vec<u8> {
    let json = serde_json::to_vec(resp).expect("serialize response");
    if 1 + json.len() > MAX_FRAME_BODY_BYTES {
        // Keep the request id: the request must still be answered.
        #[derive(Deserialize)]
        struct IdOnly {
            id: Option<u64>,
        }
        let id = serde_json::from_slice::<IdOnly>(&json).ok().and_then(|v| v.id);
        let error = Response::Error {
            id,
            code: "response_too_large".to_string(),
            message: "a response exceeded the frame size limit and was dropped".to_string(),
        };
        let json = serde_json::to_vec(&error).expect("serialize response");
        return encode_frame(FRAME_KIND_CONTROL, &json);
    }
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

#[cfg(test)]
mod frame_limit_tests {
    use super::*;

    #[test]
    fn an_oversized_response_becomes_a_small_error_frame() {
        let big = Response::RdpScreenshot {
            id: 9,
            session_id: 1,
            frame_id: 1,
            width: 1,
            height: 1,
            timestamp: 0,
            png: "A".repeat(MAX_FRAME_BODY_BYTES),
            chunks: None,
        };
        let frame = encode_response(&big);
        assert!(frame.len() <= 4 + MAX_FRAME_BODY_BYTES, "{} bytes", frame.len());
        match decode_response(&frame[5..]).unwrap() {
            Response::Error { id, code, .. } => {
                assert_eq!(code, "response_too_large");
                assert_eq!(id, Some(9), "the request id must survive");
            }
            other => panic!("expected an error frame, got {other:?}"),
        }
    }
}
