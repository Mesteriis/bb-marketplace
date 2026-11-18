//! The PVE engine against the fake PVE (tests/common/pve_fake.rs): login (ticket and token), discovery,
//! the terminal protocol to first output, echoed input, resize, keep-alive and close, and every refusal.
//! The engine runs in-process on a socketpair: no fork, no real server.
#[path = "common/pve_fake.rs"]
mod pve_fake;

use std::time::Duration;

use pve_fake::*;
use remote_hub_helper::pve::engine::serve;
use remote_hub_helper::pve::protocol::*;
use remote_hub_helper::secret::Secret;
use tokio::io::AsyncWriteExt;
use tokio::net::UnixStream;

const LEAF_FP: &str = "B6:88:41:D8:62:DD:80:8C:E2:A8:39:E1:26:D1:66:00:9D:51:54:09:DD:16:E2:A7:CB:DF:0D:3B:E1:1D:43:2E";
const CA_FP: &str = "36:28:12:20:8A:0A:3D:00:92:3E:DB:13:8A:D2:BF:2F:AF:AE:CC:82:6B:4E:BD:24:81:4E:6A:25:F0:35:CD:99";

#[derive(Debug)]
enum Got {
    Event(PveEvent),
    Data(Vec<u8>),
    Eof,
}

struct Drive {
    wr: tokio::net::unix::OwnedWriteHalf,
    rd: tokio::net::unix::OwnedReadHalf,
    engine: tokio::task::JoinHandle<i32>,
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn ticket_auth() -> PveAuth {
    PveAuth::Ticket { username: USER.into(), password: Secret::new(PASSWORD) }
}

fn ca_trust() -> Trust {
    Trust::Ca { der_hex: hex(CA_DER) }
}

fn open(port: u16, auth: PveAuth, trust: Trust, op: PveOp) -> PveCommand {
    PveCommand::Open { endpoint: Endpoint { host: "127.0.0.1".into(), port }, auth, trust, op, keepalive_secs: None }
}

fn lxc(node: &str, vmid: u32) -> PveOp {
    PveOp::Terminal { target: ConsoleTarget::Lxc { node: node.into(), vmid }, cols: 80, rows: 24 }
}

async fn start_engine(cmd: &PveCommand) -> Drive {
    let (a, b) = UnixStream::pair().unwrap();
    let engine = tokio::spawn(serve(b));
    let (rd, mut wr) = a.into_split();
    wr.write_all(&encode_control(cmd)).await.unwrap();
    Drive { wr, rd, engine }
}

impl Drive {
    async fn next(&mut self) -> Got {
        let frame = tokio::time::timeout(Duration::from_secs(15), read_frame(&mut self.rd)).await.expect("engine silent for 15 s").unwrap();
        match frame {
            None => Got::Eof,
            Some(b) if b[0] == FRAME_DATA => Got::Data(b[1..].to_vec()),
            Some(b) => Got::Event(serde_json::from_slice(&b[1..]).unwrap()),
        }
    }
    /// Events (not states) until Eof, with the console bytes joined.
    async fn all(&mut self) -> (Vec<PveEvent>, Vec<u8>) {
        let (mut events, mut data) = (vec![], vec![]);
        loop {
            match self.next().await {
                Got::Eof => return (events, data),
                Got::Event(PveEvent::State { .. }) => {}
                Got::Event(e) => events.push(e),
                Got::Data(d) => data.extend(d),
            }
        }
    }
    async fn until_state(&mut self, state: &str) {
        loop {
            match self.next().await {
                Got::Event(PveEvent::State { state: s }) if s == state => return,
                Got::Eof => panic!("ended before state {state}"),
                _ => {}
            }
        }
    }
    async fn read_data(&mut self, want: &[u8]) {
        let mut got = Vec::new();
        while !got.ends_with(want) {
            match self.next().await {
                Got::Data(d) => got.extend(d),
                Got::Eof => panic!("ended; got {:?}", String::from_utf8_lossy(&got)),
                _ => {}
            }
        }
    }
    async fn send(&mut self, cmd: &PveCommand) {
        self.wr.write_all(&encode_control(cmd)).await.unwrap();
    }
    async fn input(&mut self, bytes: &[u8]) {
        self.wr.write_all(&encode_data(bytes)).await.unwrap();
    }
}

async fn targets(fake: &Fake, auth: PveAuth, trust: Trust) -> Vec<PveEvent> {
    let mut d = start_engine(&open(fake.port, auth, trust, PveOp::Targets)).await;
    let (events, _) = d.all().await;
    d.engine.await.unwrap();
    events
}

fn error_of(events: &[PveEvent]) -> (String, Option<String>) {
    match events {
        [PveEvent::Error { code, fingerprint, .. }] => (code.clone(), fingerprint.clone()),
        other => panic!("expected one error, got {other:?}"),
    }
}

#[tokio::test]
async fn targets_by_ticket_list_nodes_guests_and_version() {
    let fake = start(default_state()).await;
    let events = targets(&fake, ticket_auth(), ca_trust()).await;
    let [PveEvent::Targets { version, nodes, guests }] = &events[..] else { panic!("{events:?}") };
    assert_eq!(version.as_deref(), Some("9.0.3"));
    assert_eq!(nodes, &vec![NodeInfo { node: "pve1".into(), status: "online".into() }, NodeInfo { node: "pve2".into(), status: "online".into() }]);
    assert_eq!(
        guests,
        &vec![
            GuestInfo { vmid: 100, name: "db".into(), kind: "qemu".into(), node: "pve1".into(), status: "running".into(), template: false },
            GuestInfo { vmid: 101, name: "web".into(), kind: "lxc".into(), node: "pve1".into(), status: "running".into(), template: false },
            GuestInfo { vmid: 102, name: "old".into(), kind: "lxc".into(), node: "pve2".into(), status: "stopped".into(), template: false },
        ]
    );
    assert_eq!(fake.state.lock().unwrap().logins, 1);
}

#[tokio::test]
async fn targets_by_api_token_need_no_login() {
    let fake = start(default_state()).await;
    let auth = PveAuth::Token { token_id: TOKEN_ID.into(), secret: Secret::new(TOKEN_SECRET) };
    let events = targets(&fake, auth, ca_trust()).await;
    assert!(matches!(&events[..], [PveEvent::Targets { guests, .. }] if guests.len() == 3), "{events:?}");
    assert_eq!(fake.state.lock().unwrap().logins, 0);
}

#[tokio::test]
async fn a_wrong_password_is_login_failed_after_exactly_one_attempt() {
    let fake = start(default_state()).await;
    let auth = PveAuth::Ticket { username: USER.into(), password: Secret::new("wrong-PW-1") };
    let events = targets(&fake, auth, ca_trust()).await;
    assert_eq!(error_of(&events).0, "login_failed");
    assert_eq!(fake.state.lock().unwrap().logins, 1, "a refused login must not be retried");
    assert!(!format!("{events:?}").contains("wrong-PW-1"));
}

#[tokio::test]
async fn an_expired_ticket_is_login_failed_not_a_retry_loop() {
    let mut st = default_state();
    st.expire_tickets = true;
    let fake = start(st).await;
    let events = targets(&fake, ticket_auth(), ca_trust()).await;
    assert_eq!(error_of(&events).0, "login_failed");
    assert_eq!(fake.state.lock().unwrap().logins, 1);
}

#[tokio::test]
async fn a_realm_with_a_second_factor_is_reported_not_attempted() {
    let mut st = default_state();
    st.tfa = true;
    let fake = start(st).await;
    let events = targets(&fake, ticket_auth(), ca_trust()).await;
    assert_eq!(error_of(&events).0, "tfa_required");
}

#[tokio::test]
async fn no_guest_privileges_is_no_permission_but_no_guests_with_privileges_is_just_empty() {
    let mut st = default_state();
    st.no_guest_privileges = true;
    let fake = start(st).await;
    assert_eq!(error_of(&targets(&fake, ticket_auth(), ca_trust()).await).0, "no_permission");

    let mut st = default_state();
    st.guests.clear();
    let fake = start(st).await;
    let events = targets(&fake, ticket_auth(), ca_trust()).await;
    assert!(matches!(&events[..], [PveEvent::Targets { guests, nodes, .. }] if guests.is_empty() && nodes.len() == 2), "{events:?}");
}

#[tokio::test]
async fn system_trust_refuses_the_fixture_certificate_and_reports_its_fingerprint() {
    let fake = start(default_state()).await;
    let (code, fp) = error_of(&targets(&fake, ticket_auth(), Trust::System).await);
    assert_eq!(code, "tls_untrusted");
    assert_eq!(fp.as_deref(), Some(LEAF_FP));
    assert_eq!(fake.state.lock().unwrap().logins, 0, "no secret may be sent over an untrusted connection");
}

#[tokio::test]
async fn a_pinned_certificate_is_accepted_and_a_different_pin_is_cert_changed() {
    let fake = start(default_state()).await;
    let ok = targets(&fake, ticket_auth(), Trust::Pin { fingerprint: LEAF_FP.into() }).await;
    assert!(matches!(&ok[..], [PveEvent::Targets { .. }]), "{ok:?}");
    let (code, fp) = error_of(&targets(&fake, ticket_auth(), Trust::Pin { fingerprint: CA_FP.into() }).await);
    assert_eq!(code, "cert_changed");
    assert_eq!(fp.as_deref(), Some(LEAF_FP));
    assert_eq!(fake.state.lock().unwrap().logins, 1, "only the matching pin may carry a login");
}

#[tokio::test]
async fn an_endpoint_that_does_not_answer_is_unreachable() {
    let port = {
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        l.local_addr().unwrap().port()
    };
    let mut d = start_engine(&open(port, ticket_auth(), ca_trust(), PveOp::Targets)).await;
    let (events, _) = d.all().await;
    assert_eq!(error_of(&events).0, "unreachable");
}

#[tokio::test]
async fn a_host_with_a_path_is_refused_before_any_connection() {
    let (a, b) = UnixStream::pair().unwrap();
    let engine = tokio::spawn(serve(b));
    let (mut rd, mut wr) = a.into_split();
    let cmd = PveCommand::Open {
        endpoint: Endpoint { host: "127.0.0.1/../x".into(), port: 8006 },
        auth: ticket_auth(),
        trust: ca_trust(),
        op: PveOp::Targets,
        keepalive_secs: None,
    };
    wr.write_all(&encode_control(&cmd)).await.unwrap();
    let body = read_frame(&mut rd).await.unwrap().unwrap();
    let e: PveEvent = serde_json::from_slice(&body[1..]).unwrap();
    assert!(matches!(e, PveEvent::Error { ref code, .. } if code == "invalid_request"), "{e:?}");
    engine.await.unwrap();
}

#[tokio::test]
async fn an_lxc_terminal_reaches_first_output_echoes_input_resizes_and_closes() {
    let fake = start(default_state()).await;
    let mut d = start_engine(&open(fake.port, ticket_auth(), ca_trust(), lxc("pve1", 101))).await;
    d.until_state("open").await;
    d.read_data(b"root@ct101:~# ").await;
    d.input("ls é\r".as_bytes()).await;
    d.read_data("ls é\r".as_bytes()).await;
    d.send(&PveCommand::Resize { cols: 100, rows: 30 }).await;
    d.input(b"x").await;
    d.read_data(b"x").await;
    d.send(&PveCommand::Close).await;
    let (events, _) = d.all().await;
    assert_eq!(events, vec![PveEvent::Closed { reason: "closed_by_user".into() }]);
    assert_eq!(d.engine.await.unwrap(), 0);
    let st = fake.state.lock().unwrap();
    assert_eq!(st.ws_input, "ls é\rx".as_bytes());
    assert_eq!(st.resizes, vec![(80, 24), (100, 30)]);
    assert_eq!(st.ticket_lines.len(), 1);
    let line = &st.ticket_lines[0];
    assert!(line.starts_with("remotehub@pve:PVEVNC:") && line.ends_with('\n'), "{line:?}");
    // The two authenticated POSTs went to the guest's termproxy, not the node's.
    assert!(st.requests.contains(&"POST /api2/json/nodes/pve1/lxc/101/termproxy".to_string()));
    assert!(st.requests.contains(&"GET /api2/json/nodes/pve1/lxc/101/vncwebsocket".to_string()));
}

#[tokio::test]
async fn the_node_shell_uses_the_node_termproxy() {
    let fake = start(default_state()).await;
    let op = PveOp::Terminal { target: ConsoleTarget::Node { node: "pve2".into() }, cols: 120, rows: 40 };
    let mut d = start_engine(&open(fake.port, ticket_auth(), ca_trust(), op)).await;
    d.until_state("open").await;
    d.read_data(b"root@ct101:~# ").await;
    d.send(&PveCommand::Close).await;
    d.all().await;
    let st = fake.state.lock().unwrap();
    assert!(st.requests.contains(&"POST /api2/json/nodes/pve2/termproxy".to_string()));
    assert_eq!(st.resizes, vec![(120, 40)]);
}

#[tokio::test]
async fn a_console_the_account_may_not_open_is_no_permission() {
    let mut st = default_state();
    st.forbid_console = true;
    let fake = start(st).await;
    let mut d = start_engine(&open(fake.port, ticket_auth(), ca_trust(), lxc("pve1", 101))).await;
    let (events, _) = d.all().await;
    assert!(matches!(&events[0], PveEvent::Error { code, .. } if code == "no_permission"), "{events:?}");
    assert_eq!(events[1], PveEvent::Closed { reason: "error".into() });
    assert_eq!(d.engine.await.unwrap(), 1);
    assert_eq!(fake.state.lock().unwrap().ws_open, 0);
}

#[tokio::test]
async fn a_token_reaches_discovery_but_not_a_console_that_needs_a_ticket() {
    let fake = start(default_state()).await;
    let auth = PveAuth::Token { token_id: TOKEN_ID.into(), secret: Secret::new(TOKEN_SECRET) };
    let mut d = start_engine(&open(fake.port, auth, ca_trust(), lxc("pve1", 101))).await;
    let (events, _) = d.all().await;
    assert!(matches!(&events[0], PveEvent::Error { code, .. } if code == "login_failed"), "{events:?}");
}

#[tokio::test]
async fn an_unknown_node_or_guest_is_an_api_error_with_the_servers_words() {
    let fake = start(default_state()).await;
    for (node, vmid, needle) in [("nope", 101u32, "hostname lookup"), ("pve1", 999, "does not exist")] {
        let mut d = start_engine(&open(fake.port, ticket_auth(), ca_trust(), lxc(node, vmid))).await;
        let (events, _) = d.all().await;
        match &events[0] {
            PveEvent::Error { code, message, .. } => {
                assert_eq!(code, "api_error");
                assert!(message.contains(needle), "{message}");
            }
            other => panic!("{other:?}"),
        }
    }
}

#[tokio::test]
async fn a_refused_ticket_line_is_login_failed() {
    let mut st = default_state();
    st.refuse_ticket_line = true;
    let fake = start(st).await;
    let mut d = start_engine(&open(fake.port, ticket_auth(), ca_trust(), lxc("pve1", 101))).await;
    let (events, _) = d.all().await;
    assert!(matches!(&events[0], PveEvent::Error { code, .. } if code == "login_failed"), "{events:?}");
}

#[tokio::test]
async fn the_remote_end_closing_is_reported_as_remote_closed() {
    let fake = start(default_state()).await;
    let mut d = start_engine(&open(fake.port, ticket_auth(), ca_trust(), lxc("pve1", 101))).await;
    d.until_state("open").await;
    d.input(b"exit\r").await;
    let (events, _) = d.all().await;
    assert_eq!(events, vec![PveEvent::Closed { reason: "remote_closed".into() }]);
}

#[tokio::test]
async fn keepalive_pings_reach_the_console() {
    let fake = start(default_state()).await;
    let cmd = PveCommand::Open {
        endpoint: Endpoint { host: "127.0.0.1".into(), port: fake.port },
        auth: ticket_auth(),
        trust: ca_trust(),
        op: lxc("pve1", 101),
        keepalive_secs: Some(1),
    };
    let mut d = start_engine(&cmd).await;
    d.until_state("open").await;
    tokio::time::sleep(Duration::from_millis(2500)).await;
    d.send(&PveCommand::Close).await;
    d.all().await;
    assert!(fake.state.lock().unwrap().pings >= 1, "no ping in 2.5 s with a 1 s interval");
}

#[tokio::test]
async fn closing_while_waiting_for_the_console_ends_at_once() {
    let mut st = default_state();
    st.delay_ok_ms = 5000;
    let fake = start(st).await;
    let mut d = start_engine(&open(fake.port, ticket_auth(), ca_trust(), lxc("pve1", 101))).await;
    d.until_state("waiting_for_console").await;
    let t = std::time::Instant::now();
    d.send(&PveCommand::Close).await;
    let (events, _) = d.all().await;
    assert_eq!(events, vec![PveEvent::Closed { reason: "closed_by_user".into() }]);
    assert!(t.elapsed() < Duration::from_secs(2));
}

#[tokio::test]
async fn the_helper_going_away_ends_the_engine_and_closes_the_console() {
    let fake = start(default_state()).await;
    let Drive { wr, rd, engine } = start_engine(&open(fake.port, ticket_auth(), ca_trust(), lxc("pve1", 101))).await;
    let mut d = Drive { wr, rd, engine };
    d.until_state("open").await;
    let Drive { wr, rd, engine } = d;
    drop(wr);
    drop(rd);
    tokio::time::timeout(Duration::from_secs(10), engine).await.expect("engine outlived the helper").unwrap();
    for _ in 0..50 {
        if fake.state.lock().unwrap().ws_closed >= 1 {
            return;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    panic!("the console websocket stayed open");
}

#[tokio::test]
async fn the_password_never_appears_in_any_event() {
    let fake = start(default_state()).await;
    let mut d = start_engine(&open(fake.port, ticket_auth(), ca_trust(), lxc("pve1", 101))).await;
    let mut seen = String::new();
    loop {
        match d.next().await {
            Got::Event(PveEvent::State { state }) if state == "open" => break,
            Got::Event(e) => seen.push_str(&format!("{e:?}")),
            _ => {}
        }
    }
    assert!(!seen.contains(PASSWORD), "{seen}");
}
