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
pub const ADMIN: &str = "root@pam";
pub const ADMIN_PASSWORD: &str = "Admin-PW-77x";
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
    /// ticket -> who logged in
    pub ticket_users: HashMap<String, String>,
    pub users: HashMap<String, String>,
    pub roles: Vec<(String, String)>,
    /// (path, roleid, userid)
    pub acl: Vec<(String, String, String)>,
    /// Graphical consoles: every byte the client sent after the websocket opened, the handshake response, the opened count.
    pub vnc_input: Vec<u8>,
    pub vnc_response: Vec<u8>,
    pub vnc_opened: u32,
    pub vnc_updates_sent: u32,
    /// The last VNC password issued.
    pub vnc_password: Option<String>,
    /// Every console websocket is refused (a ticket the server will not take).
    pub refuse_ws_ticket: bool,
    /// The RFB server hangs up right after its first framebuffer update.
    pub vnc_drop_after_update: bool,
    /// userid -> (comment, groups, token ids)
    pub user_meta: HashMap<String, (String, Vec<String>, Vec<String>)>,
    /// Creating a user is refused (after the role step, in a provisioning run).
    pub fail_user_create: bool,
    /// Writing the ACL entry is refused (after the user step).
    pub fail_acl_put: bool,
    /// Every answer after the login is a 500 that echoes everything the request carried (form values and headers), as a
    /// misbehaving server or proxy might; the login itself too.
    pub echo_secrets: bool,
    /// The server answers a write only after this many milliseconds (the request has been received and may still be applied).
    pub stall_acl_ms: u64,
    pub stall_user_ms: u64,
    /// After a good login every answer is a 500 echoing the request's form values and headers.
    pub echo_after_login: bool,
    /// Calls that wrote to /access, in order.
    pub access_writes: Vec<String>,
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

/// A PVE where only the admin exists: nothing of Remote Hub's is set up yet.
pub fn provision_state() -> State {
    let mut st = default_state();
    st.users.remove(USER);
    st
}

pub fn default_state() -> State {
    State {
        users: HashMap::from([(USER.to_string(), PASSWORD.to_string()), (ADMIN.to_string(), ADMIN_PASSWORD.to_string())]),
        roles: vec![("Administrator".into(), "Sys.Console,Sys.Modify,VM.Audit".into())],
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
    let stall = {
        let st = state.lock().unwrap();
        if method == Method::PUT && path == "/api2/json/access/acl" {
            st.stall_acl_ms
        } else if method == Method::POST && path == "/api2/json/access/users" {
            st.stall_user_ms
        } else {
            0
        }
    };
    if stall > 0 {
        tokio::time::sleep(std::time::Duration::from_millis(stall)).await;
    }
    Ok(route(&method, &path, &form, &req, state))
}

fn route(method: &Method, path: &str, form: &HashMap<String, String>, req: &Request<()>, state: Arc<Mutex<State>>) -> Response<Full<Bytes>> {
    let mut st = state.lock().unwrap();
    let write = *method != Method::GET;
    // Re-create the minimal view authenticate needs.
    let h = |n: &str| req.headers().get(n).and_then(|v| v.to_str().ok()).map(str::to_string);
    if method == Method::POST && path == "/api2/json/access/ticket" {
        st.logins += 1;
        if st.echo_secrets {
            return json_resp(500, json!({"data": null, "message": format!("echo form={form:?}")}));
        }
        let who = form.get("username").cloned().unwrap_or_default();
        if st.users.get(&who).is_some_and(|pw| form.get("password") == Some(pw)) {
            st.counter += 1;
            let ticket = format!("PVE:{who}:{:08X}::fake+sig/{}==", st.counter, st.counter);
            st.tickets.push(ticket.clone());
            st.ticket_users.insert(ticket.clone(), who.clone());
            if st.tfa {
                return json_resp(200, json!({"data": {"ticket": format!("!tfa!{ticket}"), "NeedTFA": 1, "username": who}}));
            }
            return json_resp(200, json!({"data": {"ticket": ticket, "CSRFPreventionToken": "CSRF-FAKE", "username": who, "cap": {}}}));
        }
        return json_resp(401, json!({"data": null, "message": "authentication failure"}));
    }
    // Authenticate everything else.
    let mut ticket_user = String::new();
    let who = {
        let cookie = h("cookie");
        let auth = h("authorization");
        let csrf = h("csrfpreventiontoken");
        if let Some(c) = cookie.and_then(|c| c.strip_prefix("PVEAuthCookie=").map(unescape)) {
            if st.expire_tickets || !st.tickets.contains(&c) {
                return json_resp(401, json!({"data": null, "message": "invalid PVE ticket"}));
            }
            ticket_user = st.ticket_users.get(&c).cloned().unwrap_or_default();
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
    if st.echo_secrets || st.echo_after_login {
        let headers: Vec<String> = req.headers().iter().map(|(k, v)| format!("{k}: {}", v.to_str().unwrap_or(""))).collect();
        return json_resp(500, json!({"data": null, "message": format!("echo form={form:?} headers={headers:?}")}));
    }
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
        ("GET", "/api2/json/access/roles") => {
            json_resp(200, json!({"data": st.roles.iter().map(|(r, p)| json!({"roleid": r, "privs": p})).collect::<Vec<_>>()}))
        }
        ("GET", "/api2/json/access/users") => json_resp(
            200,
            json!({"data": st.users.keys().map(|u| {
                let (comment, groups, tokens) = st.user_meta.get(u).cloned().unwrap_or_default();
                json!({"userid": u, "enable": 1, "comment": comment, "groups": groups.join(","), "tokens": tokens.iter().map(|t| json!({"tokenid": t})).collect::<Vec<_>>()})
            }).collect::<Vec<_>>()}),
        ),
        ("GET", "/api2/json/access/acl") => json_resp(
            200,
            json!({"data": st.acl.iter().map(|(p, r, u)| json!({"path": p, "type": "user", "ugid": u, "roleid": r, "propagate": 1})).collect::<Vec<_>>()}),
        ),
        (m, p) if (m == "POST" || m == "PUT") && p.starts_with("/api2/json/access/") => {
            if ticket_user != ADMIN || who == Who::Token {
                return json_resp(403, json!({"data": null, "message": "Permission check failed (/access, Sys.Modify)"}));
            }
            st.access_writes.push(format!("{m} {p}"));
            let get = |k: &str| form.get(k).cloned().unwrap_or_default();
            match (m, p) {
                ("POST", "/api2/json/access/roles") => {
                    if st.roles.iter().any(|(r, _)| *r == get("roleid")) {
                        return json_resp(500, json!({"data": null, "message": "role already exists"}));
                    }
                    let mut privs: Vec<String> = get("privs").split(',').map(str::to_string).collect();
                    privs.sort();
                    st.roles.push((get("roleid"), privs.join(",")));
                    json_resp(200, json!({"data": null}))
                }
                ("PUT", p) if p.starts_with("/api2/json/access/roles/") => {
                    let id = p.trim_start_matches("/api2/json/access/roles/").to_string();
                    let mut privs: Vec<String> = get("privs").split(',').map(str::to_string).collect();
                    privs.sort();
                    match st.roles.iter_mut().find(|(r, _)| *r == id) {
                        Some(r) => {
                            r.1 = privs.join(",");
                            json_resp(200, json!({"data": null}))
                        }
                        None => json_resp(500, json!({"data": null, "message": "role does not exist"})),
                    }
                }
                ("POST", "/api2/json/access/users") => {
                    if st.users.contains_key(&get("userid")) {
                        return json_resp(500, json!({"data": null, "message": "user already exists"}));
                    }
                    if st.fail_user_create {
                        return json_resp(500, json!({"data": null, "message": "cannot create user (realm disabled)"}));
                    }
                    if get("password").len() < 8 {
                        return json_resp(400, json!({"data": null, "message": "password: value must be at least 8 characters long"}));
                    }
                    st.user_meta.insert(get("userid"), (get("comment"), vec![], vec![]));
                    st.users.insert(get("userid"), get("password"));
                    json_resp(200, json!({"data": null}))
                }
                ("PUT", "/api2/json/access/password") => {
                    if !st.users.contains_key(&get("userid")) {
                        return json_resp(500, json!({"data": null, "message": "user does not exist"}));
                    }
                    st.users.insert(get("userid"), get("password"));
                    json_resp(200, json!({"data": null}))
                }
                ("PUT", "/api2/json/access/acl") => {
                    if st.fail_acl_put {
                        return json_resp(500, json!({"data": null, "message": "cannot write the ACL"}));
                    }
                    st.acl.push((get("path"), get("roles"), get("users")));
                    json_resp(200, json!({"data": null}))
                }
                _ => json_resp(404, json!({"data": null, "message": "no such method"})),
            }
        }
        ("POST", p) if p.ends_with("/vncproxy") => {
            if who == Who::Token && !st.tokens_reach_consoles {
                return json_resp(401, json!({"data": null, "message": "No ticket"}));
            }
            if st.forbid_console {
                return json_resp(403, json!({"data": null, "message": "Permission check failed (/vms/100, VM.Console)"}));
            }
            let parts: Vec<&str> = p.trim_start_matches('/').split('/').collect();
            // api2 json nodes {node} qemu {vmid} vncproxy
            let node = parts[3];
            if !st.nodes.iter().any(|(n, _)| n == node) {
                return json_resp(500, json!({"data": null, "message": format!("hostname lookup '{node}' failed - failed to get address info for: {node}: Name or service not known")}));
            }
            let vmid: u32 = parts[5].parse().unwrap_or(0);
            let Some(guest) = st.guests.iter().find(|(id, _, kind, n, _, _)| *id == vmid && kind == "qemu" && n == node) else {
                return json_resp(500, json!({"data": null, "message": format!("Configuration file 'nodes/{node}/qemu-server/{vmid}.conf' does not exist")}));
            };
            if guest.4 != "running" {
                return json_resp(500, json!({"data": null, "message": format!("VM {vmid} not running")}));
            }
            if form.get("websocket").map(String::as_str) != Some("1") {
                return json_resp(400, json!({"data": null, "message": "this fake only serves the websocket form"}));
            }
            st.counter += 1;
            let ticket = format!("PVEVNC:{:08X}::vnc+ticket/{}==", st.counter, st.counter);
            let password = format!("vncPw{:03}", st.counter % 1000);
            st.vnc_password = Some(password.clone());
            st.vnc_tickets.insert(ticket.clone(), p.trim_end_matches("/vncproxy").to_string());
            json_resp(200, json!({"data": {"user": USER, "ticket": ticket, "password": password, "cert": "-----BEGIN CERTIFICATE-----", "port": 5901 + st.counter % 50, "upid": "UPID:fake"}}))
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
                let Some(guest) = st.guests.iter().find(|(id, _, kind, n, _, _)| *id == vmid && kind == "lxc" && n == node) else {
                    return json_resp(500, json!({"data": null, "message": format!("Configuration file 'nodes/{node}/lxc/{vmid}.conf' does not exist")}));
                };
                if guest.4 != "running" {
                    return json_resp(500, json!({"data": null, "message": format!("CT {vmid} not running")}));
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
    let graphical = owner_path.contains("/qemu/");
    if state.lock().unwrap().refuse_ws_ticket {
        return json_resp(403, json!({"data": null, "message": "invalid vncticket"}));
    }
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
        if graphical {
            rfb(ws, st).await;
        } else {
            shell(ws, st).await;
        }
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

/// A minimal RFB 3.8 server behind the websocket: greeting, VNC authentication (the challenge is sent and any 16-byte
/// answer is accepted: DES is not checked here), ServerInit of a 2x1 desktop, and one raw framebuffer update per
/// FramebufferUpdateRequest. Everything the client sends after the upgrade is recorded.
async fn rfb<S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin>(mut ws: WebSocketStream<S>, state: Arc<Mutex<State>>) {
    state.lock().unwrap().vnc_opened += 1;
    let mut buf: Vec<u8> = Vec::new();
    // `need(n)`: wait until n bytes are buffered; None when the client went away.
    async fn need<S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin>(ws: &mut WebSocketStream<S>, buf: &mut Vec<u8>, state: &Arc<Mutex<State>>, n: usize) -> Option<()> {
        while buf.len() < n {
            match ws.next().await {
                Some(Ok(Message::Binary(b))) => {
                    state.lock().unwrap().vnc_input.extend_from_slice(&b);
                    buf.extend_from_slice(&b);
                }
                Some(Ok(Message::Ping(_) | Message::Pong(_))) => {}
                _ => return None,
            }
        }
        Some(())
    }
    if ws.send(Message::binary(&b"RFB 003.008\n"[..])).await.is_err() {
        return;
    }
    let done = async {
        need(&mut ws, &mut buf, &state, 12).await?;
        buf.drain(..12);
        ws.send(Message::binary(vec![1u8, 2])).await.ok()?; // one security type: VNC authentication
        need(&mut ws, &mut buf, &state, 1).await?;
        buf.drain(..1);
        ws.send(Message::binary(vec![7u8; 16])).await.ok()?; // the challenge
        need(&mut ws, &mut buf, &state, 16).await?;
        state.lock().unwrap().vnc_response = buf.drain(..16).collect();
        ws.send(Message::binary(vec![0u8; 4])).await.ok()?; // SecurityResult: OK
        need(&mut ws, &mut buf, &state, 1).await?; // ClientInit
        buf.drain(..1);
        let mut init: Vec<u8> = vec![0, 2, 0, 1]; // 2 x 1
        init.extend_from_slice(&[32, 24, 0, 1, 0, 255, 0, 255, 0, 255, 16, 8, 0, 0, 0, 0]); // pixel format
        init.extend_from_slice(&4u32.to_be_bytes());
        init.extend_from_slice(b"fake");
        ws.send(Message::binary(init)).await.ok()?;
        loop {
            need(&mut ws, &mut buf, &state, 1).await?;
            let want = match buf[0] {
                0 => 20,                                       // SetPixelFormat
                2 => {
                    need(&mut ws, &mut buf, &state, 4).await?;
                    4 + 4 * u16::from_be_bytes([buf[2], buf[3]]) as usize // SetEncodings
                }
                3 => 10,                                       // FramebufferUpdateRequest
                4 => 8,                                        // KeyEvent
                5 => 6,                                        // PointerEvent
                6 => {
                    need(&mut ws, &mut buf, &state, 8).await?;
                    8 + u32::from_be_bytes([buf[4], buf[5], buf[6], buf[7]]) as usize // ClientCutText
                }
                _ => return None,
            };
            need(&mut ws, &mut buf, &state, want).await?;
            let kind = buf[0];
            buf.drain(..want);
            if kind == 3 {
                let mut update: Vec<u8> = vec![0, 0, 0, 1]; // FramebufferUpdate, one rectangle
                update.extend_from_slice(&[0, 0, 0, 0, 0, 2, 0, 1]); // x y w h
                update.extend_from_slice(&0i32.to_be_bytes()); // raw
                update.extend_from_slice(&[0x10, 0x20, 0x30, 0, 0x40, 0x50, 0x60, 0]); // two pixels (B G R pad)
                ws.send(Message::binary(update)).await.ok()?;
                let drop_now = {
                    let mut st = state.lock().unwrap();
                    st.vnc_updates_sent += 1;
                    st.vnc_drop_after_update
                };
                if drop_now {
                    let _ = ws.close(None).await;
                    return None;
                }
            }
        }
    };
    let _: Option<()> = done.await;
    state.lock().unwrap().ws_closed += 1;
}
