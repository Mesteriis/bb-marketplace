//! The `--pve-engine` child: one process per PVE operation. It reads the `Open` command (all
//! parameters, including secrets) from fd 3, does the REST and websocket work on a current-thread
//! tokio runtime, and answers with `PveEvent` frames plus raw console bytes. Every wait has a bound.
use std::os::fd::FromRawFd;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use tokio::io::AsyncWriteExt;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;

use super::api::{self, ApiError, Client, ConsoleKind, Session};
use super::provision;
use crate::secret::Secret;
use super::protocol::{self, ConsoleTarget, ProvisionSteps, PveAuth, PveCommand, PveEvent, PveOp, Trust, ACTION_CREATE, ACTION_DIFFERS, ACTION_NAME_TAKEN, STEP_NOT_ATTEMPTED};
use super::term::{self, Gate, OkGate};

/// How long to wait for the server's `OK` after the ticket line (termproxy itself waits 10 s for the ticket).
const OK_TIMEOUT: Duration = Duration::from_secs(12);
const DEFAULT_KEEPALIVE: u64 = 30;
/// A whole discovery, and a whole onboarding, are bounded no matter how the individual steps add up.
const TARGETS_DEADLINE: Duration = Duration::from_secs(45);
const PROVISION_DEADLINE: Duration = Duration::from_secs(60);

/// Runs `work` until it ends, the deadline passes, or the helper cancels (Close, or its transport is gone): then nothing
/// more is sent to the server.
async fn run_cancellable(limit: Duration, out: &Out, cmds: &mut mpsc::Receiver<Cmd>, work: impl std::future::Future<Output = i32>) -> i32 {
    tokio::select! {
        r = tokio::time::timeout(limit, work) => match r {
            Ok(code) => code,
            Err(_) => {
                out.error(&ApiError::Timeout).await;
                1
            }
        },
        _ = wait_cancel(cmds) => 3,
    }
}

async fn wait_cancel(cmds: &mut mpsc::Receiver<Cmd>) {
    while let Some(c) = cmds.recv().await {
        if matches!(c, Cmd::Close) {
            return;
        }
    }
}

/// As `run_cancellable`, for provisioning: a write that was in flight when the job was cut off, or timed out, is reported
/// as `unknown` (it may or may not have happened) and nothing further is written.
async fn run_provision_cancellable(
    out: &Out,
    cmds: &mut mpsc::Receiver<Cmd>,
    work: impl std::future::Future<Output = i32>,
    progress: std::sync::Arc<std::sync::Mutex<provision::Progress>>,
) -> i32 {
    tokio::select! {
        r = tokio::time::timeout(PROVISION_DEADLINE, work) => match r {
            Ok(code) => code,
            Err(_) => {
                let steps = progress.lock().unwrap().cut_off();
                out.error_steps("timeout", &ApiError::Timeout.message(), steps).await;
                1
            }
        },
        _ = wait_cancel(cmds) => {
            let steps = progress.lock().unwrap().cut_off();
            out.error_steps("cancelled", "the setup was cancelled", steps).await;
            3
        }
    }
}

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
    /// A new driver: drop the input queued for the old one, then answer `OwnerSet`.
    SetOwner(u64),
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
        self.event(&PveEvent::Error { code: e.code().to_string(), message: e.message(), fingerprint: e.fingerprint(), steps: None }).await;
    }
    async fn error_steps(&self, code: &str, message: &str, steps: ProvisionSteps) {
        self.event(&PveEvent::Error { code: code.to_string(), message: message.to_string(), fingerprint: None, steps: Some(steps) }).await;
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
    // The helper's answer to "I saved the new password" travels apart from the commands that can cancel the job.
    let (ack_tx, mut ack_rx) = mpsc::channel::<bool>(4);
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
                    Ok(PveCommand::SetOwner { request }) => Cmd::SetOwner(request),
                    Ok(PveCommand::SaveAck { ok }) => {
                        let _ = ack_tx.send(ok).await;
                        continue;
                    }
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
            PveOp::Targets => run_cancellable(TARGETS_DEADLINE, &out, &mut cmd_rx, run_targets(&client, &auth, &out)).await,
            PveOp::Provision { dry_run, acl_path, user_id, replace_role, plan_digest } => {
                let ctx = ProvisionCtx { endpoint: format!("{}:{}", endpoint.host, endpoint.port), admin: admin_name(&auth), dry_run, acl_path, user_id, replace_role, plan_digest };
                let progress = std::sync::Arc::new(std::sync::Mutex::new(provision::Progress::new()));
                let work = run_provision(&client, &auth, &ctx, &out, &mut ack_rx, progress.clone());
                run_provision_cancellable(&out, &mut cmd_rx, work, progress).await
            }
            PveOp::Terminal { target, cols, rows } => {
                let keepalive = Duration::from_secs(keepalive_secs.unwrap_or(DEFAULT_KEEPALIVE).clamp(1, 120));
                match &target {
                    ConsoleTarget::Qemu { node, vmid } => run_vnc(&client, &auth, node, *vmid, keepalive, &out, &mut cmd_rx).await,
                    _ => run_terminal(&client, &auth, &target, (cols, rows), keepalive, &out, &mut cmd_rx).await,
                }
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

struct ProvisionCtx {
    endpoint: String,
    admin: String,
    dry_run: bool,
    acl_path: String,
    user_id: String,
    replace_role: bool,
    plan_digest: Option<String>,
}

fn admin_name(auth: &PveAuth) -> String {
    match auth {
        PveAuth::Ticket { username, .. } => username.clone(),
        PveAuth::Token { token_id, .. } => token_id.clone(),
    }
}

async fn run_provision(
    client: &Client,
    auth: &PveAuth,
    ctx: &ProvisionCtx,
    out: &Out,
    acks: &mut mpsc::Receiver<bool>,
    progress: std::sync::Arc<std::sync::Mutex<provision::Progress>>,
) -> i32 {
    if !api::valid_acl_path(&ctx.acl_path) {
        out.error(&ApiError::Invalid("the ACL path must be / or /pool/<id>")).await;
        return 1;
    }
    if !provision::valid_user_id(&ctx.user_id) {
        out.error(&ApiError::Invalid("the user must be name@pve")).await;
        return 1;
    }
    out.state("authenticating").await;
    let session = match client.authenticate(auth).await {
        Ok(s) => s,
        Err(e) => {
            out.error(&e).await;
            return 1;
        }
    };
    let state = match provision::read_state(client, &session).await {
        Ok(s) => s,
        Err(e) => {
            out.error(&e).await;
            return 1;
        }
    };
    // The digest binds the plan to this endpoint, this admin and the certificate the server presented.
    let context = format!("{}|{}|{}", ctx.endpoint, ctx.admin, client.presented_fingerprint().unwrap_or_default());
    let plan = provision::plan_from(&state, &ctx.user_id, &ctx.acl_path, &context);
    if ctx.dry_run {
        out.event(&PveEvent::Plan {
            role: plan.role.to_string(),
            user: plan.user.to_string(),
            acl: plan.acl.to_string(),
            user_id: plan.user_id.clone(),
            role_privs: plan.role_privs.clone(),
            extras: plan.extras.clone(),
            digest: plan.digest.clone(),
        })
        .await;
        return 0;
    }
    // Nothing is written before these checks pass, and a refusal here says nothing was changed.
    let refuse = |code: &'static str, message: &'static str| async move {
        out.error_steps(code, message, ProvisionSteps::untouched()).await;
        1
    };
    match ctx.plan_digest.as_deref() {
        None => return refuse("plan_required", "an apply needs the plan the owner confirmed").await,
        Some(d) if d != plan.digest => return refuse("plan_changed", "the server changed since the plan was shown; review it again").await,
        Some(_) => {}
    }
    if plan.user == ACTION_NAME_TAKEN {
        return refuse("name_taken", "a user with this name exists and was not created by Remote Hub; nothing was changed").await;
    }
    if plan.role == ACTION_DIFFERS && !ctx.replace_role {
        return refuse("role_differs", "the role exists with other privileges; replacing it needs its own confirmation").await;
    }
    out.state("provisioning").await;
    let fail = |code: &str, error: &ApiError| {
        let steps = progress.lock().unwrap().steps.clone();
        let (code, message, fingerprint) = (code.to_string(), error.message(), error.fingerprint());
        async move {
            out.event(&PveEvent::Error { code, message, fingerprint, steps: Some(steps) }).await;
            1
        }
    };
    if let Err(e) = provision::step_role(client, &session, &plan, ctx.replace_role, &progress).await {
        return fail(e.code(), &e).await;
    }
    let password = match provision::step_user(client, &session, &plan, &progress).await {
        Ok(pw) => pw,
        Err(e) => return fail(e.code(), &e).await,
    };
    // The password is active on the server now: the helper saves it before anything else is written.
    out.event(&PveEvent::NewPassword { password }).await;
    let saved = matches!(tokio::time::timeout(Duration::from_secs(30), acks.recv()).await, Ok(Some(true)));
    if !saved {
        let steps = progress.lock().unwrap().steps.clone();
        out.error_steps("credential_save_failed", "the new password could not be saved in the Keychain; run the setup again to replace it", steps).await;
        return 1;
    }
    if let Err(e) = provision::step_acl(client, &session, &plan, &ctx.acl_path, &progress).await {
        return fail(e.code(), &e).await;
    }
    let steps = progress.lock().unwrap().steps.clone();
    out.event(&PveEvent::Provisioned { steps }).await;
    0
}

/// A call made with a login ticket that the server refuses (it expired, or was revoked) is answered with ONE new login and one
/// repeat of that call; a second refusal ends the attempt as `login_failed`. A token is never retried, and nothing is retried
/// twice: repeating a refused login is how an account gets locked.
macro_rules! relogin_once {
    ($client:expr, $auth:expr, $out:expr, $session:ident, $relogged:ident, $call:expr) => {
        match $call {
            Err(ApiError::LoginFailed) if !$relogged && matches!($auth, PveAuth::Ticket { .. }) => {
                $relogged = true;
                $out.state("authenticating").await;
                $session = $client.authenticate($auth).await?;
                $call?
            }
            other => other?,
        }
    };
}

/// Everything up to the first console byte. `Err(None)` means the helper asked to stop.
#[allow(unused_assignments)]
async fn connect_terminal(
    client: &Client,
    auth: &PveAuth,
    target: &ConsoleTarget,
    size: (u16, u16),
    out: &Out,
) -> Result<(tokio_tungstenite::WebSocketStream<tokio_rustls::client::TlsStream<tokio::net::TcpStream>>, Vec<u8>), ApiError> {
    out.state("authenticating").await;
    let mut session: Session = client.authenticate(auth).await?;
    let mut relogged = false;
    out.state("creating_console").await;
    let (node, kind) = match target {
        ConsoleTarget::Node { node } => (node.as_str(), ConsoleKind::Node),
        ConsoleTarget::Lxc { node, vmid } => (node.as_str(), ConsoleKind::Lxc(*vmid)),
        ConsoleTarget::Qemu { .. } => return Err(ApiError::Invalid("a graphical console is not a terminal")),
    };
    let proxy = relogin_once!(client, auth, out, session, relogged, client.termproxy(&session, &api::proxy_path(node, kind)?).await);
    out.state("connecting").await;
    let path = api::websocket_path(node, kind, proxy.port, proxy.ticket.expose())?;
    let mut ws = relogin_once!(client, auth, out, session, relogged, client.websocket(&session, &path).await);
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

type Ws = tokio_tungstenite::WebSocketStream<tokio_rustls::client::TlsStream<tokio::net::TcpStream>>;

/// Everything up to the RFB server's greeting: the VNC proxy, the websocket, and the first bytes the server sends
/// (a QEMU console speaks first). Returns the socket, the handshake password and those first bytes.
#[allow(unused_assignments)]
async fn connect_vnc(client: &Client, auth: &PveAuth, node: &str, vmid: u32, out: &Out) -> Result<(Ws, Secret, Vec<u8>), ApiError> {
    out.state("authenticating").await;
    let mut session: Session = client.authenticate(auth).await?;
    let mut relogged = false;
    out.state("creating_console").await;
    let kind = ConsoleKind::Qemu(vmid);
    let proxy = relogin_once!(client, auth, out, session, relogged, client.vncproxy(&session, &api::proxy_path(node, kind)?).await);
    out.state("connecting").await;
    let path = api::websocket_path(node, kind, proxy.port, proxy.ticket.expose())?;
    let mut ws = relogin_once!(client, auth, out, session, relogged, client.websocket(&session, &path).await);
    out.state("waiting_for_console").await;
    let first = tokio::time::timeout(OK_TIMEOUT, async {
        loop {
            match ws.next().await {
                Some(Ok(Message::Binary(b))) => return Some(b.to_vec()),
                Some(Ok(Message::Text(_) | Message::Ping(_) | Message::Pong(_) | Message::Frame(_))) => continue,
                _ => return None,
            }
        }
    })
    .await
    .map_err(|_| ApiError::Timeout)?;
    match first {
        Some(bytes) => Ok((ws, proxy.password, bytes)),
        None => Err(ApiError::Unreachable("the console closed before it opened".to_string())),
    }
}

/// A QEMU graphical console: the raw RFB stream, relayed both ways without looking inside it.
async fn run_vnc(client: &Client, auth: &PveAuth, node: &str, vmid: u32, keepalive: Duration, out: &Out, cmds: &mut mpsc::Receiver<Cmd>) -> i32 {
    let connected = tokio::select! {
        r = connect_vnc(client, auth, node, vmid, out) => r,
        _ = async { while let Some(c) = cmds.recv().await { if matches!(c, Cmd::Close) { break; } } } => {
            out.event(&PveEvent::Closed { reason: "closed_by_user".to_string() }).await;
            return 0;
        }
    };
    let (mut ws, password, first) = match connected {
        Ok(v) => v,
        Err(e) => {
            out.error(&e).await;
            out.event(&PveEvent::Closed { reason: "error".to_string() }).await;
            return 1;
        }
    };
    // The password first: whoever views the session needs it before the server's greeting is answered.
    out.event(&PveEvent::VncPassword { password }).await;
    out.state("open").await;
    if !out.data(&first).await {
        return 2;
    }
    let mut ping = tokio::time::interval(keepalive);
    ping.reset();
    let reason = loop {
        tokio::select! {
            msg = ws.next() => match msg {
                Some(Ok(Message::Binary(b))) => { if !out.data(&b).await { break "helper_gone"; } }
                Some(Ok(Message::Close(_))) | None => break "remote_closed",
                Some(Ok(_)) => {}
                Some(Err(_)) => break "websocket_error",
            },
            cmd = cmds.recv() => match cmd {
                Some(Cmd::Input(bytes)) => { if ws.send(Message::binary(bytes)).await.is_err() { break "websocket_error"; } }
                Some(Cmd::Resize(..)) => {}
                Some(Cmd::SetOwner(request)) => { out.event(&PveEvent::OwnerSet { request, dropped: 0 }).await; }
                Some(Cmd::Close) | None => break "closed_by_user",
            },
            _ = ping.tick() => { if ws.send(Message::Ping(Vec::new().into())).await.is_err() { break "websocket_error"; } }
        }
    };
    let _ = tokio::time::timeout(Duration::from_secs(2), ws.close(None)).await;
    out.event(&PveEvent::Closed { reason: reason.to_string() }).await;
    0
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
    let (ws, rest) = match connected {
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
    // Everything written upstream goes through one writer task, so a transport that stops accepting bytes never stops this loop
    // from reading its commands: a hand-over (`SetOwner`) is still processed at once and drops what has not been written.
    let (sink, mut stream) = ws.split();
    let outbox = std::sync::Arc::new(Outbox::default());
    let (failed_tx, mut failed_rx) = tokio::sync::oneshot::channel::<()>();
    let writer = tokio::spawn(write_upstream(sink, outbox.clone(), failed_tx));
    let reason = loop {
        tokio::select! {
            msg = stream.next() => match msg {
                Some(Ok(Message::Binary(b))) => { if !out.data(&b).await { break "helper_gone"; } }
                Some(Ok(Message::Text(t))) => { if !out.data(t.as_bytes()).await { break "helper_gone"; } }
                Some(Ok(Message::Close(_))) | None => break "remote_closed",
                Some(Ok(_)) => {}
                Some(Err(_)) => break "websocket_error",
            },
            cmd = cmds.recv() => match cmd {
                Some(Cmd::Input(bytes)) => {
                    for m in term::encode_input(&bytes) {
                        let payload = payload_len(&m);
                        if !outbox.push(Message::binary(m), Some(payload)) { break; }
                    }
                    if outbox.stalled() { break "upstream_stalled"; }
                }
                Some(Cmd::SetOwner(request)) => {
                    // After this answer nothing of the previous driver is written: the queue is emptied of input here, and the one
                    // message the writer may already be sending is the only one that can still go.
                    let dropped = outbox.drop_input();
                    // ...but a message of the old driver may be inside the writer's send right now. It is answered only when none is:
                    // the send gets a short deadline; a transport that holds it longer is closed (retryable) instead of answered.
                    if !outbox.wait_no_input_in_flight(HANDOVER_DEADLINE).await { break "upstream_stalled"; }
                    if !out.event(&PveEvent::OwnerSet { request, dropped }).await { break "helper_gone"; }
                }
                Some(Cmd::Resize(c, r)) => { outbox.push(Message::binary(term::encode_resize(c.clamp(1, 1000), r.clamp(1, 1000))), None); }
                Some(Cmd::Close) | None => break "closed_by_user",
            },
            _ = &mut failed_rx => break "websocket_error",
            _ = ping.tick() => { outbox.push(Message::binary(term::PING), None); }
        }
    };
    // A graceful close when the writer is idle; a writer stuck in a send is abandoned (the process exits right after).
    outbox.stop();
    if let Ok(Ok(mut sink)) = tokio::time::timeout(Duration::from_secs(2), writer).await {
        let _ = tokio::time::timeout(Duration::from_secs(2), sink.close()).await;
    }
    out.event(&PveEvent::Closed { reason: reason.to_string() }).await;
    0
}

/// How long a hand-over waits for the old driver's message that is already being written.
const HANDOVER_DEADLINE: Duration = Duration::from_secs(2);

/// Most bytes of input the engine holds for a transport that is not accepting writes; past it the console is closed
/// (`upstream_stalled`) instead of letting the queue grow.
const OUTBOX_LIMIT: usize = 1024 * 1024;

#[derive(Default)]
struct Outbox {
    state: std::sync::Mutex<OutboxState>,
    wake: tokio::sync::Notify,
}

#[derive(Default)]
struct OutboxState {
    /// A message and, for typed input, the payload bytes it carries.
    queue: std::collections::VecDeque<(Message, Option<usize>)>,
    input_bytes: usize,
    input_payload: u64,
    /// An input message was taken by the writer and its send has not finished.
    input_in_flight: bool,
    stopped: bool,
}

impl Outbox {
    /// Queue a message; `false` when it was refused because the writer was stopped.
    fn push(&self, m: Message, input: Option<usize>) -> bool {
        let mut st = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if st.stopped {
            return false;
        }
        if let Some(payload) = input {
            st.input_bytes += m.len();
            st.input_payload += payload as u64;
        }
        st.queue.push_back((m, input));
        drop(st);
        self.wake.notify_one();
        true
    }
    fn stalled(&self) -> bool {
        self.state.lock().unwrap_or_else(|e| e.into_inner()).input_bytes > OUTBOX_LIMIT
    }
    /// Drop every queued input message; returns the bytes dropped. Control messages (resize, ping) stay.
    fn drop_input(&self) -> u64 {
        let mut st = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let dropped = st.input_payload;
        st.queue.retain(|(_, input)| input.is_none());
        st.input_bytes = 0;
        st.input_payload = 0;
        dropped
    }
    /// The writer finished the message it took.
    fn sent(&self) {
        self.state.lock().unwrap_or_else(|e| e.into_inner()).input_in_flight = false;
    }
    /// True once no input message is inside a send; false when `limit` passed first.
    async fn wait_no_input_in_flight(&self, limit: Duration) -> bool {
        let deadline = tokio::time::Instant::now() + limit;
        loop {
            if !self.state.lock().unwrap_or_else(|e| e.into_inner()).input_in_flight {
                return true;
            }
            if tokio::time::Instant::now() >= deadline {
                return false;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    }
    fn stop(&self) {
        self.state.lock().unwrap_or_else(|e| e.into_inner()).stopped = true;
        self.wake.notify_one();
    }
    fn next(&self) -> Option<Option<Message>> {
        let mut st = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if st.stopped {
            return None;
        }
        Some(st.queue.pop_front().map(|(m, input)| {
            st.input_in_flight = input.is_some();
            if let Some(payload) = input {
                st.input_bytes = st.input_bytes.saturating_sub(m.len());
                st.input_payload = st.input_payload.saturating_sub(payload as u64);
            }
            m
        }))
    }
}

/// The typed bytes inside a `0:<len>:<data>` input message.
fn payload_len(m: &[u8]) -> usize {
    m.iter().enumerate().filter(|(_, c)| **c == b':').nth(1).map(|(i, _)| m.len() - i - 1).unwrap_or(0)
}

/// Writes the queue upstream in order until stopped; a failed write is reported once and ends the task.
async fn write_upstream<S>(mut sink: S, outbox: std::sync::Arc<Outbox>, failed: tokio::sync::oneshot::Sender<()>) -> S
where
    S: futures_util::Sink<Message> + Unpin,
{
    loop {
        match outbox.next() {
            None => return sink,
            Some(Some(m)) => {
                if sink.send(m).await.is_err() {
                    let _ = failed.send(());
                    return sink;
                }
                outbox.sent();
            }
            Some(None) => outbox.wake.notified().await,
        }
    }
}

#[allow(dead_code)]
fn _trust_is_exhaustive(t: &Trust) -> bool {
    matches!(t, Trust::System | Trust::Ca { .. } | Trust::Pin { .. })
}
