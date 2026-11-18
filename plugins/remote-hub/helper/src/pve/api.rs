//! A small client for the parts of the PVE REST API Remote Hub uses (docs/pve-consoles.md). One
//! connection per request, strict TLS through `tls.rs`, every wait bounded.
use std::sync::Arc;
use std::time::Duration;

use bytes::Bytes;
use http_body_util::{BodyExt, Full, Limited};
use hyper::Method;
use hyper_util::rt::TokioIo;
use rustls::pki_types::ServerName;
use serde_json::Value;
use tokio::net::TcpStream;
use tokio_rustls::client::TlsStream;
use tokio_tungstenite::WebSocketStream;

use super::protocol::{Endpoint, GuestInfo, NodeInfo, PveAuth, Trust};
use super::tls::{client_config, is_certificate_failure, Presented};
use crate::secret::Secret;

pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);
const MAX_RESPONSE: usize = 4 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ApiError {
    /// TCP connect failed, DNS failed, or the socket broke.
    Unreachable(String),
    Timeout,
    /// The certificate is not trusted; carries what the server presented.
    TlsUntrusted { fingerprint: Option<String> },
    /// A pinned certificate no longer matches.
    CertChanged { fingerprint: Option<String> },
    /// 401, or a refused ticket.
    LoginFailed,
    /// The realm asks for a second factor, which Remote Hub does not complete.
    TfaRequired,
    /// 403.
    NoPermission(String),
    /// Any other status, with the server's message.
    Http { status: u16, message: String },
    /// An answer that is not what the API documents.
    Protocol(String),
    /// The request itself is not acceptable (a bad node name, a bad host).
    Invalid(&'static str),
}

impl ApiError {
    pub fn code(&self) -> &'static str {
        match self {
            ApiError::Unreachable(_) => "unreachable",
            ApiError::Timeout => "timeout",
            ApiError::TlsUntrusted { .. } => "tls_untrusted",
            ApiError::CertChanged { .. } => "cert_changed",
            ApiError::LoginFailed => "login_failed",
            ApiError::TfaRequired => "tfa_required",
            ApiError::NoPermission(_) => "no_permission",
            ApiError::Http { .. } => "api_error",
            ApiError::Protocol(_) => "protocol_error",
            ApiError::Invalid(_) => "invalid_request",
        }
    }
    pub fn message(&self) -> String {
        match self {
            ApiError::Unreachable(m) => format!("the PVE endpoint cannot be reached: {m}"),
            ApiError::Timeout => "the PVE endpoint did not answer in time".to_string(),
            ApiError::TlsUntrusted { .. } => "the server certificate is not trusted".to_string(),
            ApiError::CertChanged { .. } => "the server certificate differs from the confirmed one".to_string(),
            ApiError::LoginFailed => "the PVE login was refused".to_string(),
            ApiError::TfaRequired => "this account needs a second factor, which Remote Hub does not support".to_string(),
            ApiError::NoPermission(m) => format!("the account lacks a privilege: {m}"),
            ApiError::Http { status, message } => format!("PVE answered {status}: {message}"),
            ApiError::Protocol(m) => format!("unexpected PVE answer: {m}"),
            ApiError::Invalid(m) => (*m).to_string(),
        }
    }
    pub fn fingerprint(&self) -> Option<String> {
        match self {
            ApiError::TlsUntrusted { fingerprint } | ApiError::CertChanged { fingerprint } => fingerprint.clone(),
            _ => None,
        }
    }
}

/// Percent-encode everything but RFC 3986 unreserved characters.
pub fn urlenc(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

pub fn form_body(pairs: &[(&str, &str)]) -> String {
    pairs.iter().map(|(k, v)| format!("{}={}", urlenc(k), urlenc(v))).collect::<Vec<_>>().join("&")
}

/// A host the engine will connect to: a DNS name or an IP literal, nothing that could carry a path or port.
pub fn valid_host(host: &str) -> bool {
    if host.is_empty() || host.len() > 253 {
        return false;
    }
    host.parse::<std::net::IpAddr>().is_ok() || host.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'.')
}

/// A PVE node name: letters, digits and hyphens (a DNS label), so it is safe inside a path.
pub fn valid_node(node: &str) -> bool {
    !node.is_empty() && node.len() <= 63 && node.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

pub fn valid_vmid(vmid: u32) -> bool {
    (100..=999_999_999).contains(&vmid)
}

#[derive(Clone)]
pub enum Session {
    Ticket { ticket: Secret, csrf: Secret },
    Token { header: Secret },
}

impl std::fmt::Debug for Session {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Session(<redacted>)")
    }
}

impl Session {
    /// Headers that authenticate one request. The CSRF token is for requests that change state.
    pub fn headers(&self, writes: bool) -> Vec<(&'static str, String)> {
        match self {
            Session::Ticket { ticket, csrf } => {
                let mut h = vec![("Cookie", format!("PVEAuthCookie={}", urlenc(ticket.expose())))];
                if writes {
                    h.push(("CSRFPreventionToken", csrf.expose().to_string()));
                }
                h
            }
            Session::Token { header } => vec![("Authorization", format!("PVEAPIToken={}", header.expose()))],
        }
    }
}

pub struct Client {
    endpoint: Endpoint,
    config: Arc<rustls::ClientConfig>,
    seen: Presented,
    pinned: bool,
}

type Tls = TlsStream<TcpStream>;

impl Client {
    pub fn new(endpoint: &Endpoint, trust: &Trust) -> Result<Client, ApiError> {
        if !valid_host(&endpoint.host) || endpoint.port == 0 {
            return Err(ApiError::Invalid("the PVE host or port is not valid"));
        }
        let (config, seen) = client_config(trust).map_err(|e| ApiError::Invalid(e.0))?;
        Ok(Client { endpoint: endpoint.clone(), config, seen, pinned: matches!(trust, Trust::Pin { .. }) })
    }

    fn authority(&self) -> String {
        if self.endpoint.host.contains(':') {
            format!("[{}]:{}", self.endpoint.host, self.endpoint.port)
        } else {
            format!("{}:{}", self.endpoint.host, self.endpoint.port)
        }
    }

    /// TCP + TLS to `port` on the endpoint's host.
    async fn connect_tls(&self, port: u16) -> Result<Tls, ApiError> {
        let tcp = tokio::time::timeout(CONNECT_TIMEOUT, TcpStream::connect((self.endpoint.host.as_str(), port)))
            .await
            .map_err(|_| ApiError::Timeout)?
            .map_err(|e| ApiError::Unreachable(e.kind().to_string()))?;
        let _ = tcp.set_nodelay(true);
        let name = ServerName::try_from(self.endpoint.host.clone()).map_err(|_| ApiError::Invalid("the PVE host is not valid"))?;
        let connector = tokio_rustls::TlsConnector::from(self.config.clone());
        match tokio::time::timeout(CONNECT_TIMEOUT, connector.connect(name, tcp)).await {
            Err(_) => Err(ApiError::Timeout),
            Ok(Ok(tls)) => Ok(tls),
            Ok(Err(e)) if is_certificate_failure(&e) => {
                let fingerprint = self.seen.get();
                Err(if self.pinned { ApiError::CertChanged { fingerprint } } else { ApiError::TlsUntrusted { fingerprint } })
            }
            Ok(Err(e)) => Err(ApiError::Unreachable(format!("tls: {}", e.kind()))),
        }
    }

    /// One request; returns the HTTP status and the JSON `data` member.
    pub async fn request(
        &self,
        method: Method,
        path: &str,
        headers: Vec<(&'static str, String)>,
        form: Option<String>,
    ) -> Result<Value, ApiError> {
        tokio::time::timeout(REQUEST_TIMEOUT, self.request_inner(method, path, headers, form)).await.map_err(|_| ApiError::Timeout)?
    }

    async fn request_inner(
        &self,
        method: Method,
        path: &str,
        headers: Vec<(&'static str, String)>,
        form: Option<String>,
    ) -> Result<Value, ApiError> {
        let tls = self.connect_tls(self.endpoint.port).await?;
        let (mut sender, conn) = hyper::client::conn::http1::handshake(TokioIo::new(tls))
            .await
            .map_err(|e| ApiError::Unreachable(format!("http: {e}")))?;
        let conn_task = tokio::spawn(conn);
        let mut builder = hyper::Request::builder()
            .method(method)
            .uri(path)
            .header("Host", self.authority())
            .header("Connection", "close")
            .header("User-Agent", "remote-hub-pve/1")
            .header("Accept", "application/json");
        for (k, v) in &headers {
            builder = builder.header(*k, v.as_str());
        }
        let body = match form {
            Some(f) => {
                builder = builder.header("Content-Type", "application/x-www-form-urlencoded");
                Full::new(Bytes::from(f))
            }
            None => Full::new(Bytes::new()),
        };
        let req = builder.body(body).map_err(|_| ApiError::Invalid("the request is not valid"))?;
        let resp = sender.send_request(req).await.map_err(|e| ApiError::Unreachable(format!("http: {e}")))?;
        let status = resp.status().as_u16();
        let bytes = Limited::new(resp.into_body(), MAX_RESPONSE)
            .collect()
            .await
            .map_err(|_| ApiError::Protocol("response too large or cut off".to_string()))?
            .to_bytes();
        conn_task.abort();
        let json: Option<Value> = serde_json::from_slice(&bytes).ok();
        let server_message = || {
            let m = json
                .as_ref()
                .and_then(|j| j.get("message").and_then(Value::as_str))
                .map(str::to_string)
                .unwrap_or_else(|| String::from_utf8_lossy(&bytes[..bytes.len().min(200)]).to_string());
            m.chars().filter(|c| !c.is_control()).take(200).collect::<String>()
        };
        match status {
            200 => {
                let json = json.ok_or_else(|| ApiError::Protocol("the answer is not JSON".to_string()))?;
                json.get("data").cloned().ok_or_else(|| ApiError::Protocol("the answer has no data member".to_string()))
            }
            401 => Err(ApiError::LoginFailed),
            403 => Err(ApiError::NoPermission(server_message())),
            _ => Err(ApiError::Http { status, message: server_message() }),
        }
    }

    /// Log in (ticket) or accept the token as is. No second login attempt is ever made after a refusal.
    pub async fn authenticate(&self, auth: &PveAuth) -> Result<Session, ApiError> {
        match auth {
            PveAuth::Token { token_id, secret } => {
                if token_id.is_empty() || token_id.chars().any(|c| c.is_control() || c == ' ') {
                    return Err(ApiError::Invalid("the API token id is not valid"));
                }
                Ok(Session::Token { header: Secret::new(format!("{}={}", token_id, secret.expose())) })
            }
            PveAuth::Ticket { username, password } => {
                let body = form_body(&[("username", username), ("password", password.expose())]);
                let data = self.request(Method::POST, "/api2/json/access/ticket", vec![], Some(body)).await?;
                if data.get("NeedTFA").and_then(Value::as_i64) == Some(1) {
                    return Err(ApiError::TfaRequired);
                }
                let ticket = data.get("ticket").and_then(Value::as_str).ok_or_else(|| ApiError::Protocol("no ticket".to_string()))?;
                if ticket.starts_with("!tfa!") {
                    return Err(ApiError::TfaRequired);
                }
                let csrf = data
                    .get("CSRFPreventionToken")
                    .and_then(Value::as_str)
                    .ok_or_else(|| ApiError::Protocol("no CSRF token".to_string()))?;
                Ok(Session::Ticket { ticket: Secret::new(ticket), csrf: Secret::new(csrf) })
            }
        }
    }

    pub async fn get(&self, session: &Session, path: &str) -> Result<Value, ApiError> {
        self.request(Method::GET, path, session.headers(false), None).await
    }

    pub async fn post(&self, session: &Session, path: &str, form: &[(&str, &str)]) -> Result<Value, ApiError> {
        self.request(Method::POST, path, session.headers(true), Some(form_body(form))).await
    }

    pub async fn version(&self, session: &Session) -> Result<Option<String>, ApiError> {
        let data = self.get(session, "/api2/json/version").await?;
        Ok(data.get("version").and_then(Value::as_str).map(str::to_string))
    }

    pub async fn nodes(&self, session: &Session) -> Result<Vec<NodeInfo>, ApiError> {
        let data = self.get(session, "/api2/json/nodes").await?;
        let list = data.as_array().ok_or_else(|| ApiError::Protocol("nodes is not a list".to_string()))?;
        Ok(list
            .iter()
            .filter_map(|n| {
                Some(NodeInfo {
                    node: n.get("node")?.as_str()?.to_string(),
                    status: n.get("status").and_then(Value::as_str).unwrap_or("unknown").to_string(),
                })
            })
            .collect())
    }

    pub async fn guests(&self, session: &Session) -> Result<Vec<GuestInfo>, ApiError> {
        let data = self.get(session, "/api2/json/cluster/resources?type=vm").await?;
        let list = data.as_array().ok_or_else(|| ApiError::Protocol("resources is not a list".to_string()))?;
        Ok(parse_guests(list))
    }

    /// Whether the account holds any guest privilege anywhere (distinguishes "no guests" from "may not see them").
    pub async fn has_guest_privileges(&self, session: &Session) -> Result<bool, ApiError> {
        let data = self.get(session, "/api2/json/access/permissions").await?;
        Ok(permissions_allow_guests(&data))
    }

    /// `POST …/termproxy`; returns (user, ticket, port).
    pub async fn termproxy(&self, session: &Session, path: &str) -> Result<TermProxy, ApiError> {
        let data = self.post(session, path, &[]).await?;
        let user = data.get("user").and_then(Value::as_str).ok_or_else(|| ApiError::Protocol("termproxy: no user".to_string()))?;
        let ticket = data.get("ticket").and_then(Value::as_str).ok_or_else(|| ApiError::Protocol("termproxy: no ticket".to_string()))?;
        let port = data
            .get("port")
            .and_then(|p| p.as_u64().or_else(|| p.as_str().and_then(|s| s.parse().ok())))
            .filter(|p| (1..=65535).contains(p))
            .ok_or_else(|| ApiError::Protocol("termproxy: no valid port".to_string()))?;
        Ok(TermProxy { user: user.to_string(), ticket: Secret::new(ticket), port: port as u16 })
    }

    /// The websocket of a console, over the same strict TLS, authenticated like the REST calls.
    pub async fn websocket(&self, session: &Session, path_and_query: &str) -> Result<WebSocketStream<Tls>, ApiError> {
        use tokio_tungstenite::tungstenite::client::IntoClientRequest;
        use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
        let tls = self.connect_tls(self.endpoint.port).await?;
        let uri = format!("wss://{}{}", self.authority(), path_and_query);
        let mut request = uri.into_client_request().map_err(|_| ApiError::Invalid("the console address is not valid"))?;
        for (k, v) in session.headers(false) {
            request.headers_mut().insert(k, v.parse().map_err(|_| ApiError::Invalid("a header is not valid"))?);
        }
        let config = WebSocketConfig::default().max_message_size(Some(1 << 20)).max_frame_size(Some(1 << 20));
        let handshake = tokio_tungstenite::client_async_with_config(request, tls, Some(config));
        match tokio::time::timeout(CONNECT_TIMEOUT, handshake).await {
            Err(_) => Err(ApiError::Timeout),
            Ok(Ok((ws, _))) => Ok(ws),
            Ok(Err(tokio_tungstenite::tungstenite::Error::Http(resp))) => Err(match resp.status().as_u16() {
                401 => ApiError::LoginFailed,
                403 => ApiError::NoPermission("the websocket was refused".to_string()),
                status => ApiError::Http { status, message: "the console websocket was refused".to_string() },
            }),
            Ok(Err(e)) => Err(ApiError::Unreachable(format!("websocket: {}", e.to_string().chars().take(120).collect::<String>()))),
        }
    }
}

pub struct TermProxy {
    pub user: String,
    pub ticket: Secret,
    pub port: u16,
}

pub fn parse_guests(list: &[Value]) -> Vec<GuestInfo> {
    let mut out = Vec::new();
    for r in list {
        let Some(kind) = r.get("type").and_then(Value::as_str).filter(|t| *t == "qemu" || *t == "lxc") else { continue };
        let (Some(vmid), Some(node)) = (r.get("vmid").and_then(Value::as_u64), r.get("node").and_then(Value::as_str)) else { continue };
        let Ok(vmid) = u32::try_from(vmid) else { continue };
        out.push(GuestInfo {
            vmid,
            name: r.get("name").and_then(Value::as_str).unwrap_or("").to_string(),
            kind: kind.to_string(),
            node: node.to_string(),
            status: r.get("status").and_then(Value::as_str).unwrap_or("unknown").to_string(),
            template: r.get("template").and_then(Value::as_i64).unwrap_or(0) == 1,
        });
    }
    out.sort_by(|a, b| (a.vmid, &a.kind).cmp(&(b.vmid, &b.kind)));
    out
}

/// `GET /access/permissions` maps a path to its privileges. Any guest privilege on `/` or under `/vms` counts.
pub fn permissions_allow_guests(data: &Value) -> bool {
    let Some(map) = data.as_object() else { return false };
    let wanted = ["VM.Audit", "VM.Console"];
    map.iter().any(|(path, privs)| {
        (path == "/" || path == "/vms" || path.starts_with("/vms/") || path.starts_with("/pool/"))
            && privs
                .as_object()
                .is_some_and(|p| wanted.iter().any(|w| p.get(*w).and_then(Value::as_i64).unwrap_or(0) == 1))
    })
}

/// For tests and the manager: the console paths, built only from validated parts.
pub fn termproxy_path(node: &str, vmid: Option<u32>) -> Result<String, ApiError> {
    if !valid_node(node) {
        return Err(ApiError::Invalid("the node name is not valid"));
    }
    match vmid {
        None => Ok(format!("/api2/json/nodes/{node}/termproxy")),
        Some(v) if valid_vmid(v) => Ok(format!("/api2/json/nodes/{node}/lxc/{v}/termproxy")),
        Some(_) => Err(ApiError::Invalid("the guest id is not valid")),
    }
}

pub fn websocket_path(node: &str, vmid: Option<u32>, port: u16, ticket: &str) -> Result<String, ApiError> {
    let base = termproxy_path(node, vmid)?.replace("/termproxy", "/vncwebsocket");
    Ok(format!("{base}?port={port}&vncticket={}", urlenc(ticket)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn urlenc_keeps_unreserved_and_escapes_the_rest() {
        assert_eq!(urlenc("PVEVNC:abc+/=~-_."), "PVEVNC%3Aabc%2B%2F%3D~-_.");
        assert_eq!(urlenc("é"), "%C3%A9");
    }

    #[test]
    fn form_body_encodes_both_sides() {
        assert_eq!(form_body(&[("username", "remotehub@pve"), ("password", "a b&c")]), "username=remotehub%40pve&password=a%20b%26c");
    }

    #[test]
    fn host_and_node_validation() {
        assert!(valid_host("pve.example.test"));
        assert!(valid_host("192.168.1.2"));
        assert!(valid_host("fe80::1"));
        assert!(!valid_host("a/b"));
        assert!(!valid_host("a:8006"));
        assert!(!valid_host(""));
        assert!(valid_node("pve-1"));
        assert!(!valid_node("../x"));
        assert!(!valid_node("a b"));
        assert!(!valid_node(""));
        assert!(valid_vmid(100));
        assert!(!valid_vmid(99));
    }

    #[test]
    fn console_paths_are_built_from_validated_parts() {
        assert_eq!(termproxy_path("n1", None).unwrap(), "/api2/json/nodes/n1/termproxy");
        assert_eq!(termproxy_path("n1", Some(101)).unwrap(), "/api2/json/nodes/n1/lxc/101/termproxy");
        assert!(termproxy_path("n1/../x", Some(101)).is_err());
        assert!(termproxy_path("n1", Some(5)).is_err());
        assert_eq!(
            websocket_path("n1", Some(101), 5901, "PVEVNC:a+b").unwrap(),
            "/api2/json/nodes/n1/lxc/101/vncwebsocket?port=5901&vncticket=PVEVNC%3Aa%2Bb"
        );
    }

    #[test]
    fn session_headers_carry_csrf_only_for_writes_and_never_print() {
        let s = Session::Ticket { ticket: Secret::new("PVE:u@pve:AB::cd=="), csrf: Secret::new("CSRF1") };
        assert_eq!(s.headers(false), vec![("Cookie", "PVEAuthCookie=PVE%3Au%40pve%3AAB%3A%3Acd%3D%3D".to_string())]);
        assert_eq!(s.headers(true).len(), 2);
        assert_eq!(s.headers(true)[1], ("CSRFPreventionToken", "CSRF1".to_string()));
        assert_eq!(format!("{s:?}"), "Session(<redacted>)");
        let t = Session::Token { header: Secret::new("u@pve!t=uuid") };
        assert_eq!(t.headers(true), vec![("Authorization", "PVEAPIToken=u@pve!t=uuid".to_string())]);
    }

    #[test]
    fn guests_keep_only_qemu_and_lxc_sorted_with_the_template_flag() {
        let list = vec![
            json!({"id":"lxc/101","type":"lxc","vmid":101,"name":"web","node":"n2","status":"running"}),
            json!({"id":"qemu/100","type":"qemu","vmid":100,"name":"db","node":"n1","status":"stopped","template":1}),
            json!({"id":"storage/n1/local","type":"storage"}),
            json!({"id":"qemu/x","type":"qemu","vmid":"bad"}),
        ];
        let g = parse_guests(&list);
        assert_eq!(g.len(), 2);
        assert_eq!((g[0].vmid, g[0].kind.as_str(), g[0].node.as_str(), g[0].template), (100, "qemu", "n1", true));
        assert_eq!((g[1].vmid, g[1].name.as_str(), g[1].status.as_str()), (101, "web", "running"));
    }

    #[test]
    fn permissions_decide_between_empty_and_forbidden() {
        assert!(permissions_allow_guests(&json!({"/":{"VM.Audit":1}})));
        assert!(permissions_allow_guests(&json!({"/vms/100":{"VM.Console":1}})));
        assert!(!permissions_allow_guests(&json!({"/":{"Sys.Audit":1}, "/storage":{"VM.Audit":1}})));
        assert!(!permissions_allow_guests(&json!({"/":{"VM.Audit":0}})));
        assert!(!permissions_allow_guests(&json!(null)));
    }
}
