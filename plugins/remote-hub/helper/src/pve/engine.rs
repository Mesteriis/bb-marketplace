//! The `--pve-engine` child: one process per PVE operation. It reads the `Open` command (all
//! parameters, including secrets) from fd 3, does the REST and websocket work on a current-thread
//! tokio runtime, and answers with `PveEvent` frames plus raw console bytes. Every wait has a bound.
use std::os::fd::FromRawFd;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use tokio::io::AsyncWriteExt;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;

use super::api::{self, ApiError, Client, Session};
use super::protocol::{self, ConsoleTarget, PveAuth, PveCommand, PveEvent, PveOp, Trust};
use super::term::{self, Gate, OkGate};

/// How long to wait for the server's `OK` after the ticket line (termproxy itself waits 10 s for the ticket).
const OK_TIMEOUT: Duration = Duration::from_secs(12);
const DEFAULT_KEEPALIVE: u64 = 30;

pub fn run_engine() -> i32 {
    let std_stream = unsafe { std::os::unix::net::UnixStream::from_raw_fd(3) };
    if std_stream.set_nonblocking(true).is_err() {
        return 2;
    }
    let rt = match tokio::runtime::Builder::new_current_thread().enable_all().build() {
        Ok(rt) => rt,
        Err(_) => return 2,
    };
    rt.block_on(async {
        match tokio::net::UnixStream::from_std(std_stream) {
            Ok(stream) => serve(stream).await,
            Err(_) => 2,
        }
    })
}

/// Commands the helper sends after `Open`.
enum Cmd {
    Input(Vec<u8>),
    Resize(u16, u16),
    Close,
}

/// Writes frames to the helper in order; a failed write means the helper is gone.
struct Out {
    tx: mpsc::Sender<Vec<u8>>,
}

impl Out {
    async fn event(&self, e: &PveEvent) -> bool {
        self.tx.send(protocol::encode_control(e)).await.is_ok()
    }
    async fn state(&self, s: &str) -> bool {
        self.event(&PveEvent::State { state: s.to_string() }).await
    }
    async fn data(&self, bytes: &[u8]) -> bool {
        for chunk in bytes.chunks(protocol::DATA_CHUNK) {
            if self.tx.send(protocol::encode_data(chunk)).await.is_err() {
                return false;
            }
        }
        true
    }
    async fn error(&self, e: &ApiError) {
        self.event(&PveEvent::Error { code: e.code().to_string(), message: e.message(), fingerprint: e.fingerprint() }).await;
    }
}

/// Runs one engine session on `stream` until it ends. The exit status is the process exit code.
pub async fn serve(stream: tokio::net::UnixStream) -> i32 {
    let (mut rd, mut wr) = stream.into_split();
    let (out_tx, mut out_rx) = mpsc::channel::<Vec<u8>>(64);
    let writer = tokio::spawn(async move {
        while let Some(frame) = out_rx.recv().await {
            if wr.write_all(&frame).await.is_err() {
                return;
            }
        }
        let _ = wr.shutdown().await;
    });
    let out = Out { tx: out_tx };

    // The first control frame is the one Open.
    let open = loop {
        match protocol::read_frame(&mut rd).await {
            Ok(Some(body)) if body.first() == Some(&protocol::FRAME_CONTROL) => {
                if let Ok(cmd @ PveCommand::Open { .. }) = serde_json::from_slice::<PveCommand>(&body[1..]) {
                    break cmd;
                }
            }
            Ok(Some(_)) => {}
            _ => return 0,
        }
    };
    let PveCommand::Open { endpoint, auth, trust, op, keepalive_secs } = open else { return 1 };

    // Commands after Open arrive on a channel so every phase can be interrupted by Close or the helper going away.
    let (cmd_tx, mut cmd_rx) = mpsc::channel::<Cmd>(64);
    tokio::spawn(async move {
        loop {
            let body = match protocol::read_frame(&mut rd).await {
                Ok(Some(b)) => b,
                _ => {
                    let _ = cmd_tx.send(Cmd::Close).await;
                    return;
                }
            };
            let cmd = match body.first() {
                Some(&protocol::FRAME_DATA) => Cmd::Input(body[1..].to_vec()),
                Some(&protocol::FRAME_CONTROL) => match serde_json::from_slice::<PveCommand>(&body[1..]) {
                    Ok(PveCommand::Resize { cols, rows }) => Cmd::Resize(cols, rows),
                    Ok(PveCommand::Close) => Cmd::Close,
                    _ => continue,
                },
                _ => continue,
            };
            if cmd_tx.send(cmd).await.is_err() {
                return;
            }
        }
    });

    let code = match Client::new(&endpoint, &trust) {
        Err(e) => {
            out.error(&e).await;
            1
        }
        Ok(client) => match op {
            PveOp::Targets => run_targets(&client, &auth, &out).await,
            PveOp::Terminal { target, cols, rows } => {
                let keepalive = Duration::from_secs(keepalive_secs.unwrap_or(DEFAULT_KEEPALIVE).clamp(1, 120));
                run_terminal(&client, &auth, &target, (cols, rows), keepalive, &out, &mut cmd_rx).await
            }
        },
    };
    drop(out);
    let _ = writer.await;
    code
}

async fn run_targets(client: &Client, auth: &PveAuth, out: &Out) -> i32 {
    out.state("authenticating").await;
    let result = async {
        let session = client.authenticate(auth).await?;
        let version = client.version(&session).await?;
        let nodes = client.nodes(&session).await?;
        let guests = client.guests(&session).await?;
        if guests.is_empty() && !client.has_guest_privileges(&session).await? {
            return Err(ApiError::NoPermission("no VM.Audit or VM.Console privilege on any path".to_string()));
        }
        Ok((version, nodes, guests))
    }
    .await;
    match result {
        Ok((version, nodes, guests)) => {
            out.event(&PveEvent::Targets { version, nodes, guests }).await;
            0
        }
        Err(e) => {
            out.error(&e).await;
            1
        }
    }
}

/// Everything up to the first console byte. `Err(None)` means the helper asked to stop.
async fn connect_terminal(
    client: &Client,
    auth: &PveAuth,
    target: &ConsoleTarget,
    size: (u16, u16),
    out: &Out,
) -> Result<(tokio_tungstenite::WebSocketStream<tokio_rustls::client::TlsStream<tokio::net::TcpStream>>, Vec<u8>), ApiError> {
    out.state("authenticating").await;
    let session: Session = client.authenticate(auth).await?;
    out.state("creating_console").await;
    let (node, vmid) = match target {
        ConsoleTarget::Node { node } => (node.as_str(), None),
        ConsoleTarget::Lxc { node, vmid } => (node.as_str(), Some(*vmid)),
    };
    let proxy = client.termproxy(&session, &api::termproxy_path(node, vmid)?).await?;
    out.state("connecting").await;
    let path = api::websocket_path(node, vmid, proxy.port, proxy.ticket.expose())?;
    let mut ws = client.websocket(&session, &path).await?;
    ws.send(Message::text(String::from_utf8_lossy(&term::ticket_line(&proxy.user, proxy.ticket.expose())).to_string()))
        .await
        .map_err(|_| ApiError::Unreachable("websocket closed".to_string()))?;
    out.state("waiting_for_console").await;
    let mut gate = OkGate::default();
    let first = tokio::time::timeout(OK_TIMEOUT, async {
        loop {
            match ws.next().await {
                Some(Ok(Message::Text(t))) => match gate.feed(t.as_bytes()) {
                    Gate::NeedMore => continue,
                    other => return Some(other),
                },
                Some(Ok(Message::Binary(b))) => match gate.feed(&b) {
                    Gate::NeedMore => continue,
                    other => return Some(other),
                },
                Some(Ok(Message::Ping(_) | Message::Pong(_) | Message::Frame(_))) => continue,
                _ => return None,
            }
        }
    })
    .await
    .map_err(|_| ApiError::Timeout)?;
    let rest = match first {
        Some(Gate::Open(rest)) => rest,
        Some(Gate::Refused) => return Err(ApiError::LoginFailed),
        _ => return Err(ApiError::Unreachable("the console closed before it opened".to_string())),
    };
    ws.send(Message::binary(term::encode_resize(size.0, size.1)))
        .await
        .map_err(|_| ApiError::Unreachable("websocket closed".to_string()))?;
    Ok((ws, rest))
}

async fn run_terminal(
    client: &Client,
    auth: &PveAuth,
    target: &ConsoleTarget,
    size: (u16, u16),
    keepalive: Duration,
    out: &Out,
    cmds: &mut mpsc::Receiver<Cmd>,
) -> i32 {
    let size = (size.0.clamp(1, 1000), size.1.clamp(1, 1000));
    // A Close (or the helper vanishing) during connect ends it at once; other early commands are dropped:
    // typed input never replays after a connect.
    let connected = tokio::select! {
        r = connect_terminal(client, auth, target, size, out) => r,
        _ = async { while let Some(c) = cmds.recv().await { if matches!(c, Cmd::Close) { break; } } } => {
            out.event(&PveEvent::Closed { reason: "closed_by_user".to_string() }).await;
            return 0;
        }
    };
    let (mut ws, rest) = match connected {
        Ok(v) => v,
        Err(e) => {
            out.error(&e).await;
            out.event(&PveEvent::Closed { reason: "error".to_string() }).await;
            return 1;
        }
    };
    out.state("open").await;
    if !rest.is_empty() && !out.data(&rest).await {
        return 2;
    }
    let mut ping = tokio::time::interval(keepalive);
    ping.reset();
    let reason = loop {
        tokio::select! {
            msg = ws.next() => match msg {
                Some(Ok(Message::Binary(b))) => { if !out.data(&b).await { break "helper_gone"; } }
                Some(Ok(Message::Text(t))) => { if !out.data(t.as_bytes()).await { break "helper_gone"; } }
                Some(Ok(Message::Close(_))) | None => break "remote_closed",
                Some(Ok(_)) => {}
                Some(Err(_)) => break "websocket_error",
            },
            cmd = cmds.recv() => match cmd {
                Some(Cmd::Input(bytes)) => {
                    let mut failed = false;
                    for m in term::encode_input(&bytes) {
                        if ws.send(Message::binary(m)).await.is_err() { failed = true; break; }
                    }
                    if failed { break "websocket_error"; }
                }
                Some(Cmd::Resize(c, r)) => {
                    if ws.send(Message::binary(term::encode_resize(c.clamp(1, 1000), r.clamp(1, 1000)))).await.is_err() { break "websocket_error"; }
                }
                Some(Cmd::Close) | None => break "closed_by_user",
            },
            _ = ping.tick() => {
                if ws.send(Message::binary(term::PING)).await.is_err() { break "websocket_error"; }
            }
        }
    };
    let _ = tokio::time::timeout(Duration::from_secs(2), ws.close(None)).await;
    out.event(&PveEvent::Closed { reason: reason.to_string() }).await;
    0
}

#[allow(dead_code)]
fn _trust_is_exhaustive(t: &Trust) -> bool {
    matches!(t, Trust::System | Trust::Ca { .. } | Trust::Pin { .. })
}
