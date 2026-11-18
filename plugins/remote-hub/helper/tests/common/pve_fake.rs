//! A fake Proxmox VE: HTTPS with the fixture certificate (127.0.0.1, signed by the fixture CA), the REST calls
//! Remote Hub makes, and the termproxy websocket protocol in front of a scripted shell. It is written from the
//! protocol in docs/pve-consoles.md, independently of the client under test, and records what it received.
//! Fixtures only: nothing here talks to a real server.
#![allow(dead_code)]
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use bytes::Bytes;
use futures_util::{SinkExt, StreamExt};
use http_body_util::{BodyExt, Full};
use hyper::body::Incoming;
use hyper::service::service_fn;
use hyper::{Method, Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};
use serde_json::{json, Value};
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::handshake::derive_accept_key;
use tokio_tungstenite::tungstenite::protocol::Role;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::WebSocketStream;

pub const CA_DER: &[u8] = include_bytes!("../fixtures/tls-ca.der");
pub const LEAF_DER: &[u8] = include_bytes!("../fixtures/tls-leaf.der");
const LEAF_KEY: &[u8] = include_bytes!("../fixtures/tls-leaf-key.pkcs8.der");
pub const PASSWORD: &str = "Fake-PW-9d41";
pub const USER: &str = "remotehub@pve";
pub const TOKEN_ID: &str = "remotehub@pve!rh";
pub const TOKEN_SECRET: &str = "0a1b2c3d-fake-token";

#[derive(Default)]
pub struct State {
    pub nodes: Vec<(String, String)>,
    /// (vmid, name, type, node, status, template)
    pub guests: Vec<(u32, String, String, String, String, bool)>,
    pub expire_tickets: bool,
    pub forbid_console: bool,
    pub no_guest_privileges: bool,
    pub tfa: bool,
    pub tokens_reach_consoles: bool,
    /// The websocket says something other than OK to the ticket line.
    pub refuse_ticket_line: bool,
    pub delay_ok_ms: u64,
    pub tickets: Vec<String>,
    pub vnc_tickets: HashMap<String, String>,
    pub requests: Vec<String>,
    pub ws_open: u32,
    pub ws_closed: u32,
    pub ws_input: Vec<u8>,
    pub resizes: Vec<(u16, u16)>,
    pub pings: u32,
    pub ticket_lines: Vec<String>,
    pub logins: u32,
    pub counter: u32,
}

pub struct Fake {
    pub port: u16,
    pub state: Arc<Mutex<State>>,
    task: tokio::task::JoinHandle<()>,
}

impl Drop for Fake {
    fn drop(&mut self) {
        self.task.abort();
    }
}

fn server_config() -> Arc<rustls::ServerConfig> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let config = rustls::ServerConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .unwrap()
        .with_no_client_auth()
        .with_single_cert(vec![CertificateDer::from(LEAF_DER.to_vec())], PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(LEAF_KEY.to_vec())))
        .unwrap();
    Arc::new(config)
}

pub fn default_state() -> State {
    State {
        nodes: vec![("pve1".into(), "online".into()), ("pve2".into(), "online".into())],
        guests: vec![
            (100, "db".into(), "qemu".into(), "pve1".into(), "running".into(), false),
            (101, "web".into(), "lxc".into(), "pve1".into(), "running".into(), false),
            (102, "old".into(), "lxc".into(), "pve2".into(), "stopped".into(), false),
        ],
        ..State::default()
    }
}

pub async fn start_fake(state: State) -> Fake {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let state = Arc::new(Mutex::new(state));
    let acceptor = tokio_rustls::TlsAcceptor::from(server_config());
    let st = state.clone();
    let task = tokio::spawn(async move {
        loop {
            let Ok((tcp, _)) = listener.accept().await else { return };
            let acceptor = acceptor.clone();
            let st = st.clone();
            tokio::spawn(async move {
                let Ok(tls) = acceptor.accept(tcp).await else { return };
                let svc = service_fn(move |req| handle(req, st.clone()));
                let _ = hyper::server::conn::http1::Builder::new().serve_connection(TokioIo::new(tls), svc).with_upgrades().await;
            });
        }
    });
    Fake { port, state, task }
}

fn unescape(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

fn json_resp(status: u16, body: Value) -> Response<Full<Bytes>> {
    Response::builder().status(status).header("Content-Type", "application/json").body(Full::new(Bytes::from(body.to_string()))).unwrap()
}

#[derive(PartialEq)]
enum Who {
    Ticket,
    Token,
}

async fn handle(req: Request<Incoming>, state: Arc<Mutex<State>>) -> Result<Response<Full<Bytes>>, std::convert::Infallible> {
    let method = req.method().clone();
    let path = req.uri().path().to_string();
    let query = req.uri().query().unwrap_or("").to_string();
    {
        let mut st = state.lock().unwrap();
        st.requests.push(format!("{method} {path}"));
    }
    if path.ends_with("/vncwebsocket") && method == Method::GET {
        return Ok(websocket(req, state, &path, &query).await);
    }
    let (parts, body) = req.into_parts();
    let bytes = body.collect().await.map(|b| b.to_bytes()).unwrap_or_default();
    let form: HashMap<String, String> = String::from_utf8_lossy(&bytes)
        .split('&')
        .filter(|p| !p.is_empty())
        .filter_map(|p| p.split_once('=').map(|(k, v)| (unescape(k), unescape(v))))
        .collect();
    let req = Request::from_parts(parts, ());
    let _ = &req;
    Ok(route(&method, &path, &form, &req, state))
}

fn route(method: &Method, path: &str, form: &HashMap<String, String>, req: &Request<()>, state: Arc<Mutex<State>>) -> Response<Full<Bytes>> {
    let mut st = state.lock().unwrap();
    let write = *method != Method::GET;
    // Re-create the minimal view authenticate needs.
    let h = |n: &str| req.headers().get(n).and_then(|v| v.to_str().ok()).map(str::to_string);
    if method == Method::POST && path == "/api2/json/access/ticket" {
        st.logins += 1;
        if form.get("username").map(String::as_str) == Some(USER) && form.get("password").map(String::as_str) == Some(PASSWORD) {
            st.counter += 1;
            let ticket = format!("PVE:{USER}:{:08X}::fake+sig/{}==", st.counter, st.counter);
            st.tickets.push(ticket.clone());
            if st.tfa {
                return json_resp(200, json!({"data": {"ticket": format!("!tfa!{ticket}"), "NeedTFA": 1, "username": USER}}));
            }
            return json_resp(200, json!({"data": {"ticket": ticket, "CSRFPreventionToken": "CSRF-FAKE", "username": USER, "cap": {}}}));
        }
        return json_resp(401, json!({"data": null, "message": "authentication failure"}));
    }
    // Authenticate everything else.
    let who = {
        let cookie = h("cookie");
        let auth = h("authorization");
        let csrf = h("csrfpreventiontoken");
        if let Some(c) = cookie.and_then(|c| c.strip_prefix("PVEAuthCookie=").map(unescape)) {
            if st.expire_tickets || !st.tickets.contains(&c) {
                return json_resp(401, json!({"data": null, "message": "invalid PVE ticket"}));
            }
            if write && csrf.is_none() {
                return json_resp(401, json!({"data": null, "message": "No CSRF prevention token"}));
            }
            Who::Ticket
        } else if auth.as_deref() == Some(&format!("PVEAPIToken={TOKEN_ID}={TOKEN_SECRET}")) {
            Who::Token
        } else {
            return json_resp(401, json!({"data": null, "message": "No ticket"}));
        }
    };
    match (method.as_str(), path) {
        ("GET", "/api2/json/version") => json_resp(200, json!({"data": {"version": "9.0.3", "release": "9.0", "repoid": "fake"}})),
        ("GET", "/api2/json/nodes") => json_resp(200, json!({"data": st.nodes.iter().map(|(n, s)| json!({"node": n, "status": s})).collect::<Vec<_>>()})),
        ("GET", "/api2/json/cluster/resources") => {
            let list: Vec<Value> = if st.no_guest_privileges {
                vec![]
            } else {
                st.guests
                    .iter()
                    .map(|(id, name, kind, node, status, tpl)| {
                        json!({"id": format!("{kind}/{id}"), "type": kind, "vmid": id, "name": name, "node": node, "status": status, "template": if *tpl {1} else {0}})
                    })
                    .collect()
            };
            json_resp(200, json!({"data": list}))
        }
        ("GET", "/api2/json/access/permissions") => {
            if st.no_guest_privileges {
                json_resp(200, json!({"data": {"/": {"Sys.Audit": 1}}}))
            } else {
                json_resp(200, json!({"data": {"/": {"VM.Audit": 1, "VM.Console": 1, "Sys.Console": 1}}}))
            }
        }
        ("POST", p) if p.ends_with("/termproxy") => {
            if who == Who::Token && !st.tokens_reach_consoles {
                return json_resp(401, json!({"data": null, "message": "No ticket"}));
            }
            if st.forbid_console {
                return json_resp(403, json!({"data": null, "message": "Permission check failed (/vms/101, VM.Console)"}));
            }
            let parts: Vec<&str> = p.trim_start_matches('/').split('/').collect();
            // api2 json nodes {node} [lxc {vmid}] termproxy
            let node = parts[3];
            if !st.nodes.iter().any(|(n, _)| n == node) {
                return json_resp(500, json!({"data": null, "message": format!("hostname lookup '{node}' failed - failed to get address info for: {node}: Name or service not known")}));
            }
            if parts.len() == 7 {
                let vmid: u32 = parts[5].parse().unwrap_or(0);
                let on_node = st.guests.iter().any(|(id, _, kind, n, _, _)| *id == vmid && kind == "lxc" && n == node);
                if !on_node {
                    return json_resp(500, json!({"data": null, "message": format!("Configuration file 'nodes/{node}/lxc/{vmid}.conf' does not exist")}));
                }
            }
            st.counter += 1;
            let ticket = format!("PVEVNC:{:08X}::vnc+ticket/{}==", st.counter, st.counter);
            st.vnc_tickets.insert(ticket.clone(), p.trim_end_matches("/termproxy").to_string());
            json_resp(200, json!({"data": {"user": USER, "ticket": ticket, "port": 5901 + st.counter % 50, "upid": "UPID:fake"}}))
        }
        _ => json_resp(404, json!({"data": null, "message": "no such method"})),
    }
}

async fn websocket(req: Request<Incoming>, state: Arc<Mutex<State>>, path: &str, query: &str) -> Response<Full<Bytes>> {
    let q: HashMap<String, String> = query.split('&').filter_map(|p| p.split_once('=').map(|(k, v)| (k.to_string(), unescape(v)))).collect();
    let owner_path = path.trim_end_matches("/vncwebsocket").to_string();
    let cookie = req.headers().get("cookie").and_then(|v| v.to_str().ok()).map(str::to_string);
    let key = req.headers().get("sec-websocket-key").and_then(|v| v.to_str().ok()).map(str::to_string);
    {
        let st = state.lock().unwrap();
        let cookie_ok = cookie
            .as_deref()
            .and_then(|c| c.strip_prefix("PVEAuthCookie=").map(unescape))
            .is_some_and(|t| !st.expire_tickets && st.tickets.contains(&t));
        if !cookie_ok {
            return json_resp(401, json!({"data": null, "message": "invalid PVE ticket"}));
        }
        let vt = q.get("vncticket").cloned().unwrap_or_default();
        if st.vnc_tickets.get(&vt).map(String::as_str) != Some(owner_path.as_str()) || q.get("port").and_then(|p| p.parse::<u16>().ok()).is_none() {
            return json_resp(403, json!({"data": null, "message": "invalid vncticket"}));
        }
    }
    let Some(key) = key else { return json_resp(400, json!({"message": "missing key"})) };
    let on_upgrade = hyper::upgrade::on(req);
    let st = state.clone();
    tokio::spawn(async move {
        let Ok(upgraded) = on_upgrade.await else { return };
        let ws = WebSocketStream::from_raw_socket(TokioIo::new(upgraded), Role::Server, None).await;
        shell(ws, st).await;
    });
    Response::builder()
        .status(StatusCode::SWITCHING_PROTOCOLS)
        .header("Upgrade", "websocket")
        .header("Connection", "Upgrade")
        .header("Sec-WebSocket-Accept", derive_accept_key(key.as_bytes()))
        .body(Full::new(Bytes::new()))
        .unwrap()
}

/// The termproxy side: ticket line, OK, then a shell that echoes data and records resize and ping.
async fn shell<S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin>(mut ws: WebSocketStream<S>, state: Arc<Mutex<State>>) {
    state.lock().unwrap().ws_open += 1;
    let Some(Ok(first)) = ws.next().await else { return };
    let line = match first {
        Message::Text(t) => t.as_bytes().to_vec(),
        Message::Binary(b) => b.to_vec(),
        _ => return,
    };
    let (refuse, delay) = {
        let mut st = state.lock().unwrap();
        st.ticket_lines.push(String::from_utf8_lossy(&line).to_string());
        (st.refuse_ticket_line, st.delay_ok_ms)
    };
    let valid = {
        let st = state.lock().unwrap();
        let text = String::from_utf8_lossy(&line).to_string();
        text.ends_with('\n') && text.trim_end().split_once(':').is_some_and(|(u, t)| u == USER && st.vnc_tickets.contains_key(t))
    };
    if refuse || !valid {
        let _ = ws.send(Message::text("authentication request failed")).await;
        let _ = ws.close(None).await;
        state.lock().unwrap().ws_closed += 1;
        return;
    }
    if delay > 0 {
        tokio::time::sleep(std::time::Duration::from_millis(delay)).await;
    }
    let _ = ws.send(Message::text("OK")).await;
    let _ = ws.send(Message::binary(&b"root@ct101:~# "[..])).await;
    let mut buf: Vec<u8> = Vec::new();
    while let Some(Ok(msg)) = ws.next().await {
        match msg {
            Message::Binary(b) => buf.extend_from_slice(&b),
            Message::Text(t) => buf.extend_from_slice(t.as_bytes()),
            Message::Close(_) => break,
            _ => continue,
        }
        loop {
            // Parse like termproxy: type digit, ':' then numbers.
            if buf.is_empty() {
                break;
            }
            match buf[0] {
                b'0' => {
                    let Some(p2) = buf[2..].iter().position(|&c| c == b':') else { break };
                    let len: usize = String::from_utf8_lossy(&buf[2..2 + p2]).parse().unwrap_or(0);
                    let start = 2 + p2 + 1;
                    if buf.len() < start + len {
                        break;
                    }
                    let data = buf[start..start + len].to_vec();
                    buf.drain(..start + len);
                    state.lock().unwrap().ws_input.extend_from_slice(&data);
                    let _ = ws.send(Message::binary(data.clone())).await;
                    if data == b"exit\r" {
                        let _ = ws.close(None).await;
                        state.lock().unwrap().ws_closed += 1;
                        return;
                    }
                }
                b'1' => {
                    // 1:cols:rows:
                    let s = String::from_utf8_lossy(&buf).to_string();
                    let parts: Vec<&str> = s.splitn(4, ':').collect();
                    if parts.len() < 4 {
                        break;
                    }
                    let (c, r) = (parts[1].parse().unwrap_or(0), parts[2].parse().unwrap_or(0));
                    let used = parts[0].len() + 1 + parts[1].len() + 1 + parts[2].len() + 1;
                    buf.drain(..used);
                    state.lock().unwrap().resizes.push((c, r));
                }
                b'2' => {
                    buf.drain(..1);
                    state.lock().unwrap().pings += 1;
                }
                _ => {
                    buf.drain(..1);
                }
            }
        }
    }
    state.lock().unwrap().ws_closed += 1;
}
