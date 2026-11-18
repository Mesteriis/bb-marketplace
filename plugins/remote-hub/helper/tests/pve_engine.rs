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
    let fake = start_fake(default_state()).await;
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
    let fake = start_fake(default_state()).await;
    let auth = PveAuth::Token { token_id: TOKEN_ID.into(), secret: Secret::new(TOKEN_SECRET) };
    let events = targets(&fake, auth, ca_trust()).await;
    assert!(matches!(&events[..], [PveEvent::Targets { guests, .. }] if guests.len() == 3), "{events:?}");
    assert_eq!(fake.state.lock().unwrap().logins, 0);
}

#[tokio::test]
async fn a_wrong_password_is_login_failed_after_exactly_one_attempt() {
    let fake = start_fake(default_state()).await;
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
    let fake = start_fake(st).await;
    let events = targets(&fake, ticket_auth(), ca_trust()).await;
    assert_eq!(error_of(&events).0, "login_failed");
    assert_eq!(fake.state.lock().unwrap().logins, 1);
}

#[tokio::test]
async fn a_realm_with_a_second_factor_is_reported_not_attempted() {
    let mut st = default_state();
    st.tfa = true;
    let fake = start_fake(st).await;
    let events = targets(&fake, ticket_auth(), ca_trust()).await;
    assert_eq!(error_of(&events).0, "tfa_required");
}

#[tokio::test]
async fn no_guest_privileges_is_no_permission_but_no_guests_with_privileges_is_just_empty() {
    let mut st = default_state();
    st.no_guest_privileges = true;
    let fake = start_fake(st).await;
    assert_eq!(error_of(&targets(&fake, ticket_auth(), ca_trust()).await).0, "no_permission");

    let mut st = default_state();
    st.guests.clear();
    let fake = start_fake(st).await;
    let events = targets(&fake, ticket_auth(), ca_trust()).await;
    assert!(matches!(&events[..], [PveEvent::Targets { guests, nodes, .. }] if guests.is_empty() && nodes.len() == 2), "{events:?}");
}

#[tokio::test]
async fn system_trust_refuses_the_fixture_certificate_and_reports_its_fingerprint() {
    let fake = start_fake(default_state()).await;
    let (code, fp) = error_of(&targets(&fake, ticket_auth(), Trust::System).await);
    assert_eq!(code, "tls_untrusted");
    assert_eq!(fp.as_deref(), Some(LEAF_FP));
    assert_eq!(fake.state.lock().unwrap().logins, 0, "no secret may be sent over an untrusted connection");
}

#[tokio::test]
async fn a_pinned_certificate_is_accepted_and_a_different_pin_is_cert_changed() {
    let fake = start_fake(default_state()).await;
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
    let fake = start_fake(default_state()).await;
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
    let fake = start_fake(default_state()).await;
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
    let fake = start_fake(st).await;
    let mut d = start_engine(&open(fake.port, ticket_auth(), ca_trust(), lxc("pve1", 101))).await;
    let (events, _) = d.all().await;
    assert!(matches!(&events[0], PveEvent::Error { code, .. } if code == "no_permission"), "{events:?}");
    assert_eq!(events[1], PveEvent::Closed { reason: "error".into() });
    assert_eq!(d.engine.await.unwrap(), 1);
    assert_eq!(fake.state.lock().unwrap().ws_open, 0);
}

#[tokio::test]
async fn a_token_reaches_discovery_but_not_a_console_that_needs_a_ticket() {
    let fake = start_fake(default_state()).await;
    let auth = PveAuth::Token { token_id: TOKEN_ID.into(), secret: Secret::new(TOKEN_SECRET) };
    let mut d = start_engine(&open(fake.port, auth, ca_trust(), lxc("pve1", 101))).await;
    let (events, _) = d.all().await;
    assert!(matches!(&events[0], PveEvent::Error { code, .. } if code == "login_failed"), "{events:?}");
}

#[tokio::test]
async fn an_unknown_node_or_guest_is_an_api_error_with_the_servers_words() {
    let fake = start_fake(default_state()).await;
    for (node, vmid, needle) in [("nope", 101u32, "hostname lookup"), ("pve1", 999, "does not exist")] {
        let mut d = start_engine(&open(fake.port, ticket_auth(), ca_trust(), lxc(node, vmid))).await;
        let (events, _) = d.all().await;
        match &events[0] {
            PveEvent::Error { code, message, .. } => {
                assert_eq!(code, "api_error");
                // Only the status: what the server said is never passed on.
                assert_eq!(message, "PVE answered 500", "{needle}");
            }
            other => panic!("{other:?}"),
        }
    }
}

#[tokio::test]
async fn a_refused_ticket_line_is_login_failed() {
    let mut st = default_state();
    st.refuse_ticket_line = true;
    let fake = start_fake(st).await;
    let mut d = start_engine(&open(fake.port, ticket_auth(), ca_trust(), lxc("pve1", 101))).await;
    let (events, _) = d.all().await;
    assert!(matches!(&events[0], PveEvent::Error { code, .. } if code == "login_failed"), "{events:?}");
}

#[tokio::test]
async fn the_remote_end_closing_is_reported_as_remote_closed() {
    let fake = start_fake(default_state()).await;
    let mut d = start_engine(&open(fake.port, ticket_auth(), ca_trust(), lxc("pve1", 101))).await;
    d.until_state("open").await;
    d.input(b"exit\r").await;
    let (events, _) = d.all().await;
    assert_eq!(events, vec![PveEvent::Closed { reason: "remote_closed".into() }]);
}

#[tokio::test]
async fn keepalive_pings_reach_the_console() {
    let fake = start_fake(default_state()).await;
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
    let fake = start_fake(st).await;
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
    let fake = start_fake(default_state()).await;
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
    let fake = start_fake(default_state()).await;
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

// ---- onboarding mode 1: provisioning ----

const OUR_USER: &str = "remotehub@pve";

fn admin_auth() -> PveAuth {
    PveAuth::Ticket { username: ADMIN.into(), password: Secret::new(ADMIN_PASSWORD) }
}

#[derive(Clone)]
struct Prov {
    dry_run: bool,
    acl_path: String,
    user_id: String,
    replace_role: bool,
    digest: Option<String>,
    save_ok: bool,
}

fn dry() -> Prov {
    Prov { dry_run: true, acl_path: "/".into(), user_id: OUR_USER.into(), replace_role: false, digest: None, save_ok: true }
}

fn apply(digest: &str) -> Prov {
    Prov { dry_run: false, digest: Some(digest.to_string()), ..dry() }
}

struct Run {
    events: Vec<PveEvent>,
    password: Option<String>,
    acl_written_when_password_arrived: Option<bool>,
}

/// Plays the helper: runs one provisioning job and answers the engine's "save the new password" request.
async fn run_job(fake: &Fake, auth: PveAuth, p: Prov) -> Run {
    let op = PveOp::Provision { dry_run: p.dry_run, acl_path: p.acl_path.clone(), user_id: p.user_id.clone(), replace_role: p.replace_role, plan_digest: p.digest.clone() };
    let mut d = start_engine(&open(fake.port, auth, ca_trust(), op)).await;
    let mut run = Run { events: vec![], password: None, acl_written_when_password_arrived: None };
    loop {
        match d.next().await {
            Got::Eof => break,
            Got::Event(PveEvent::State { .. }) | Got::Data(_) => {}
            Got::Event(PveEvent::NewPassword { password }) => {
                run.acl_written_when_password_arrived = Some(fake.state.lock().unwrap().access_writes.iter().any(|w| w.contains("/acl")));
                run.password = Some(password.expose().to_string());
                d.send(&PveCommand::SaveAck { ok: p.save_ok }).await;
            }
            Got::Event(e) => run.events.push(e),
        }
    }
    d.engine.await.unwrap();
    run
}

fn digest_of(run: &Run) -> String {
    match &run.events[..] {
        [PveEvent::Plan { digest, .. }] => digest.clone(),
        other => panic!("not a plan: {other:?}"),
    }
}

fn steps(role: &str, user: &str, acl: &str) -> ProvisionSteps {
    ProvisionSteps { role: role.into(), user: user.into(), acl: acl.into() }
}

fn error_code(run: &Run) -> (String, Option<ProvisionSteps>) {
    match &run.events[..] {
        [PveEvent::Error { code, steps, .. }] => (code.clone(), steps.clone()),
        other => panic!("expected one error, got {other:?}"),
    }
}

fn writes(fake: &Fake) -> Vec<String> {
    fake.state.lock().unwrap().access_writes.clone()
}

#[tokio::test]
async fn a_dry_run_reports_the_plan_with_its_digest_and_writes_nothing() {
    let fake = start_fake(provision_state()).await;
    let run = run_job(&fake, admin_auth(), dry()).await;
    let [PveEvent::Plan { role, user, acl, user_id, role_privs, extras, digest }] = &run.events[..] else { panic!("{:?}", run.events) };
    assert_eq!((role.as_str(), user.as_str(), acl.as_str(), user_id.as_str()), ("create", "create", "create", OUR_USER));
    assert_eq!(role_privs, &None);
    assert_eq!(extras, &UserExtras::default());
    assert_eq!(digest.len(), 64);
    assert!(writes(&fake).is_empty());
    // The same state and the same context give the same digest.
    assert_eq!(&digest_of(&run_job(&fake, admin_auth(), dry()).await), digest);
}

#[tokio::test]
async fn an_apply_without_the_confirmed_plan_is_refused_before_any_write() {
    let fake = start_fake(provision_state()).await;
    let run = run_job(&fake, admin_auth(), Prov { dry_run: false, ..dry() }).await;
    assert_eq!(error_code(&run), ("plan_required".to_string(), Some(steps("not_attempted", "not_attempted", "not_attempted"))));
    assert!(writes(&fake).is_empty());
}

#[tokio::test]
async fn applying_the_confirmed_plan_creates_a_marked_user_and_the_password_is_saved_before_the_acl_write() {
    let fake = start_fake(provision_state()).await;
    let digest = digest_of(&run_job(&fake, admin_auth(), dry()).await);
    let run = run_job(&fake, admin_auth(), apply(&digest)).await;
    assert_eq!(run.events, vec![PveEvent::Provisioned { steps: steps("done", "done", "done") }]);
    let password = run.password.clone().expect("a new password was announced");
    assert_eq!(password.len(), 32);
    assert_eq!(run.acl_written_when_password_arrived, Some(false), "the password must reach the helper before the ACL write");
    let st = fake.state.lock().unwrap();
    assert_eq!(st.access_writes, vec!["POST /api2/json/access/roles", "POST /api2/json/access/users", "PUT /api2/json/access/acl"]);
    assert_eq!(st.user_meta.get(OUR_USER).map(|m| m.0.as_str()), Some("Managed by BB Remote Hub"));
    assert!(st.roles.contains(&("RemoteHubConsole".to_string(), "Sys.Audit,Sys.Console,VM.Audit,VM.Console".to_string())));
    assert_eq!(st.acl, vec![("/".to_string(), "RemoteHubConsole".to_string(), OUR_USER.to_string())]);
    assert_eq!(st.users.get(OUR_USER), Some(&password));
}

#[tokio::test]
async fn the_created_user_can_sign_in_and_discover() {
    let fake = start_fake(provision_state()).await;
    let digest = digest_of(&run_job(&fake, admin_auth(), dry()).await);
    let run = run_job(&fake, admin_auth(), apply(&digest)).await;
    let auth = PveAuth::Ticket { username: OUR_USER.into(), password: Secret::new(run.password.unwrap()) };
    let found = targets(&fake, auth, ca_trust()).await;
    assert!(matches!(&found[..], [PveEvent::Targets { guests, .. }] if guests.len() == 3), "{found:?}");
}

#[tokio::test]
async fn a_server_that_changed_after_the_plan_was_shown_is_refused_before_the_first_write() {
    // A user appears (another machine ran the setup) between the review and the apply.
    let fake = start_fake(provision_state()).await;
    let digest = digest_of(&run_job(&fake, admin_auth(), dry()).await);
    {
        let mut st = fake.state.lock().unwrap();
        st.users.insert(OUR_USER.into(), "Someone-Else-1".into());
        st.user_meta.insert(OUR_USER.into(), ("Managed by BB Remote Hub".into(), vec![], vec![]));
    }
    let run = run_job(&fake, admin_auth(), apply(&digest)).await;
    assert_eq!(error_code(&run), ("plan_changed".to_string(), Some(steps("not_attempted", "not_attempted", "not_attempted"))));
    assert!(writes(&fake).is_empty());
    assert_eq!(fake.state.lock().unwrap().users.get(OUR_USER), Some(&"Someone-Else-1".to_string()), "the other machine's password must survive");

    // A role that appeared in the meantime is drift too.
    let fake = start_fake(provision_state()).await;
    let digest = digest_of(&run_job(&fake, admin_auth(), dry()).await);
    fake.state.lock().unwrap().roles.push(("RemoteHubConsole".into(), "VM.Audit".into()));
    assert_eq!(error_code(&run_job(&fake, admin_auth(), apply(&digest)).await).0, "plan_changed");
    assert!(writes(&fake).is_empty());
}

#[tokio::test]
async fn an_acl_entry_added_after_the_plan_is_drift_too() {
    let fake = start_fake(provision_state()).await;
    let digest = digest_of(&run_job(&fake, admin_auth(), dry()).await);
    fake.state.lock().unwrap().acl.push(("/".into(), "PVEAuditor".into(), "someone@pve".into()));
    assert_eq!(error_code(&run_job(&fake, admin_auth(), apply(&digest)).await).0, "plan_changed");
}

#[tokio::test]
async fn a_user_that_is_not_ours_is_name_taken_and_nothing_is_written() {
    // default_state has remotehub@pve without the marker: an unrelated account with our name.
    let fake = start_fake(default_state()).await;
    let run = run_job(&fake, admin_auth(), dry()).await;
    let [PveEvent::Plan { user, digest, .. }] = &run.events[..] else { panic!("{:?}", run.events) };
    assert_eq!(user, "name_taken");
    let digest = digest.clone();
    let applied = run_job(&fake, admin_auth(), apply(&digest)).await;
    assert_eq!(error_code(&applied).0, "name_taken");
    assert!(writes(&fake).is_empty());
    assert_eq!(fake.state.lock().unwrap().users.get(OUR_USER), Some(&PASSWORD.to_string()), "the unrelated account keeps its password");
}

#[tokio::test]
async fn another_user_name_can_be_chosen_and_must_be_in_the_pve_realm() {
    let fake = start_fake(default_state()).await;
    let mut p = dry();
    p.user_id = "rh-lab@pve".into();
    let digest = digest_of(&run_job(&fake, admin_auth(), p.clone()).await);
    let mut a = apply(&digest);
    a.user_id = "rh-lab@pve".into();
    let run = run_job(&fake, admin_auth(), a).await;
    assert_eq!(run.events, vec![PveEvent::Provisioned { steps: steps("done", "done", "done") }]);
    assert!(fake.state.lock().unwrap().users.contains_key("rh-lab@pve"));
    for bad in ["root@pam", "x", "a b@pve", "@pve"] {
        let mut p = dry();
        p.user_id = bad.into();
        assert_eq!(error_code(&run_job(&fake, admin_auth(), p).await).0, "invalid_request", "{bad}");
    }
}

#[tokio::test]
async fn a_differing_role_is_refused_until_replacing_it_is_confirmed_separately() {
    let mut st = provision_state();
    st.roles.push(("RemoteHubConsole".into(), "VM.Audit".into()));
    let fake = start_fake(st).await;
    let run = run_job(&fake, admin_auth(), dry()).await;
    let [PveEvent::Plan { role, role_privs, digest, .. }] = &run.events[..] else { panic!() };
    assert_eq!((role.as_str(), role_privs.as_deref()), ("differs", Some("VM.Audit")));
    let digest = digest.clone();
    assert_eq!(error_code(&run_job(&fake, admin_auth(), apply(&digest)).await).0, "role_differs");
    assert!(writes(&fake).is_empty());
    let mut a = apply(&digest);
    a.replace_role = true;
    let run = run_job(&fake, admin_auth(), a).await;
    assert_eq!(run.events, vec![PveEvent::Provisioned { steps: steps("done", "done", "done") }]);
    assert_eq!(writes(&fake)[0], "PUT /api2/json/access/roles/RemoteHubConsole");
}

#[tokio::test]
async fn a_managed_user_is_rotated_and_what_it_already_holds_is_shown_and_kept() {
    let fake = start_fake(provision_state()).await;
    let first = run_job(&fake, admin_auth(), apply(&digest_of(&run_job(&fake, admin_auth(), dry()).await))).await;
    {
        let mut st = fake.state.lock().unwrap();
        st.acl.push(("/".into(), "PVEAdmin".into(), OUR_USER.into()));
        st.acl.push(("/vms/100".into(), "PVEVMUser".into(), OUR_USER.into()));
        st.user_meta.insert(OUR_USER.into(), ("Managed by BB Remote Hub".into(), vec!["admins".into()], vec!["ci".into()]));
        st.access_writes.clear();
    }
    let plan = run_job(&fake, admin_auth(), dry()).await;
    let [PveEvent::Plan { role, user, acl, extras, digest, .. }] = &plan.events[..] else { panic!() };
    assert_eq!((role.as_str(), user.as_str(), acl.as_str()), ("keep", "rotate_password", "keep"));
    assert_eq!(extras.groups, vec!["admins"]);
    assert_eq!(extras.tokens, vec!["ci"]);
    assert_eq!(extras.acl, vec![AclGrant { path: "/".into(), role: "PVEAdmin".into() }, AclGrant { path: "/vms/100".into(), role: "PVEVMUser".into() }]);
    let digest = digest.clone();
    let second = run_job(&fake, admin_auth(), apply(&digest)).await;
    assert_eq!(second.events, vec![PveEvent::Provisioned { steps: steps("kept", "done", "kept") }]);
    assert_ne!(first.password, second.password);
    let st = fake.state.lock().unwrap();
    assert_eq!(st.access_writes, vec!["PUT /api2/json/access/password"]);
    assert_eq!(st.acl.len(), 3, "the user's other grants are never removed");
    assert_eq!(st.users.get(OUR_USER), second.password.as_ref());
}

#[tokio::test]
async fn a_digest_is_bound_to_the_admin_and_to_the_endpoint_context() {
    let fake = start_fake(provision_state()).await;
    let as_admin = digest_of(&run_job(&fake, admin_auth(), dry()).await);
    fake.state.lock().unwrap().users.insert("other-admin@pam".into(), "Other-PW-1234".into());
    let other = PveAuth::Ticket { username: "other-admin@pam".into(), password: Secret::new("Other-PW-1234") };
    let other_digest = digest_of(&run_job(&fake, other, dry()).await);
    assert_ne!(as_admin, other_digest);
}

#[tokio::test]
async fn when_user_creation_fails_after_the_role_step_the_steps_say_what_exists() {
    let mut st = provision_state();
    st.fail_user_create = true;
    let fake = start_fake(st).await;
    let digest = digest_of(&run_job(&fake, admin_auth(), dry()).await);
    let run = run_job(&fake, admin_auth(), apply(&digest)).await;
    assert_eq!(error_code(&run), ("api_error".to_string(), Some(steps("done", "failed", "not_attempted"))));
    assert!(run.password.is_none(), "no password exists when the user was not created");
    let st = fake.state.lock().unwrap();
    assert!(st.roles.iter().any(|(r, _)| r == "RemoteHubConsole"), "the role was created and stays");
    assert!(!st.users.contains_key(OUR_USER));
}

#[tokio::test]
async fn when_the_acl_fails_after_the_user_step_the_password_was_already_handed_over() {
    let mut st = provision_state();
    st.fail_acl_put = true;
    let fake = start_fake(st).await;
    let digest = digest_of(&run_job(&fake, admin_auth(), dry()).await);
    let run = run_job(&fake, admin_auth(), apply(&digest)).await;
    assert_eq!(error_code(&run), ("api_error".to_string(), Some(steps("done", "done", "failed"))));
    let password = run.password.clone().expect("the password was announced before the ACL write");
    assert_eq!(fake.state.lock().unwrap().users.get(OUR_USER), Some(&password), "the password announced is the one active on the server");
}

#[tokio::test]
async fn a_failed_keychain_save_stops_before_the_acl_write() {
    let fake = start_fake(provision_state()).await;
    let digest = digest_of(&run_job(&fake, admin_auth(), dry()).await);
    let mut p = apply(&digest);
    p.save_ok = false;
    let run = run_job(&fake, admin_auth(), p).await;
    assert_eq!(error_code(&run), ("credential_save_failed".to_string(), Some(steps("done", "done", "not_attempted"))));
    assert!(!writes(&fake).iter().any(|w| w.contains("/acl")));
}

#[tokio::test]
async fn an_account_without_admin_rights_changes_nothing() {
    let mut st = provision_state();
    st.users.insert("plain@pve".into(), "Plain-PW-1234".into());
    let fake = start_fake(st).await;
    let plain = PveAuth::Ticket { username: "plain@pve".into(), password: Secret::new("Plain-PW-1234") };
    let digest = digest_of(&run_job(&fake, plain.clone(), dry()).await);
    let run = run_job(&fake, plain, apply(&digest)).await;
    assert_eq!(error_code(&run), ("no_permission".to_string(), Some(steps("failed", "not_attempted", "not_attempted"))));
    assert!(writes(&fake).is_empty());
}

#[tokio::test]
async fn a_wrong_admin_password_or_a_bad_acl_path_or_user_never_writes() {
    let fake = start_fake(provision_state()).await;
    let bad = PveAuth::Ticket { username: ADMIN.into(), password: Secret::new("nope-nope-1") };
    assert_eq!(error_code(&run_job(&fake, bad, dry()).await).0, "login_failed");
    let mut p = dry();
    p.acl_path = "/vms/100".into();
    assert_eq!(error_code(&run_job(&fake, admin_auth(), p).await).0, "invalid_request");
    assert!(writes(&fake).is_empty());
    assert_eq!(fake.state.lock().unwrap().logins, 1, "an invalid path must be refused before any login");
}

#[tokio::test]
async fn cutting_a_provision_off_while_a_write_is_in_flight_reports_it_unknown_and_writes_nothing_more() {
    let mut st = provision_state();
    st.stall_acl_ms = 1500;
    let fake = start_fake(st).await;
    let digest = digest_of(&run_job(&fake, admin_auth(), dry()).await);
    let op = PveOp::Provision { dry_run: false, acl_path: "/".into(), user_id: OUR_USER.into(), replace_role: false, plan_digest: Some(digest) };
    let mut d = start_engine(&open(fake.port, admin_auth(), ca_trust(), op)).await;
    let mut seen = vec![];
    loop {
        match d.next().await {
            Got::Event(PveEvent::NewPassword { .. }) => {
                d.send(&PveCommand::SaveAck { ok: true }).await;
                tokio::time::sleep(Duration::from_millis(300)).await; // the ACL write is now in flight, stalled by the server
                d.send(&PveCommand::Close).await;
            }
            Got::Event(PveEvent::State { .. }) | Got::Data(_) => {}
            Got::Event(e) => seen.push(e),
            Got::Eof => break,
        }
    }
    assert!(matches!(&seen[..], [PveEvent::Error { code, steps: Some(s), .. }] if code == "cancelled" && s == &steps("done", "done", "unknown")), "{seen:?}");
}

#[tokio::test]
async fn losing_the_helper_cancels_the_job_at_once_and_no_later_step_is_written() {
    let mut st = provision_state();
    st.stall_user_ms = 1500;
    let fake = start_fake(st).await;
    let digest = digest_of(&run_job(&fake, admin_auth(), dry()).await);
    let op = PveOp::Provision { dry_run: false, acl_path: "/".into(), user_id: OUR_USER.into(), replace_role: false, plan_digest: Some(digest) };
    let Drive { wr, rd, engine } = start_engine(&open(fake.port, admin_auth(), ca_trust(), op)).await;
    tokio::time::sleep(Duration::from_millis(400)).await; // the user write is in flight, stalled by the server
    drop(wr);
    drop(rd);
    let started = std::time::Instant::now();
    let code = tokio::time::timeout(Duration::from_secs(5), engine).await.expect("the engine outlived the helper").unwrap();
    assert_eq!(code, 3);
    assert!(started.elapsed() < Duration::from_secs(1), "cancellation must not wait for the 60 s deadline");
    tokio::time::sleep(Duration::from_millis(1800)).await;
    assert!(!writes(&fake).iter().any(|w| w.contains("/acl")), "no step after the cut may be written: {:?}", writes(&fake));
}

#[tokio::test]
async fn an_endpoint_that_echoes_what_it_was_sent_never_gets_it_back_to_the_client() {
    // Sentinels: the admin and user passwords, an API token secret, and what a ticket session carries.
    let mut st = default_state();
    st.echo_secrets = true;
    let fake = start_fake(st).await;
    let mut all = String::new();
    // Discovery by ticket (the login itself answers 500 with an echo), and by token (the echo carries the header).
    all.push_str(&format!("{:?}", targets(&fake, ticket_auth(), ca_trust()).await));
    let token = PveAuth::Token { token_id: TOKEN_ID.into(), secret: Secret::new(TOKEN_SECRET) };
    all.push_str(&format!("{:?}", targets(&fake, token, ca_trust()).await));
    all.push_str(&format!("{:?}", run_job(&fake, admin_auth(), dry()).await.events));
    for sentinel in [PASSWORD, ADMIN_PASSWORD, TOKEN_SECRET, "CSRF-FAKE", "PVEAuthCookie", "PVEAPIToken"] {
        assert!(!all.contains(sentinel), "{sentinel} came back in {all}");
    }
    assert!(all.contains("PVE answered 500"), "{all}");
}

#[tokio::test]
async fn an_echoing_answer_after_a_good_login_carries_no_ticket_or_csrf_token() {
    let mut st = default_state();
    st.echo_after_login = true;
    let fake = start_fake(st).await;
    let events = targets(&fake, ticket_auth(), ca_trust()).await;
    let text = format!("{events:?}");
    for sentinel in ["CSRF-FAKE", "PVEAuthCookie", "PVE%3A", "fake+sig", PASSWORD] {
        assert!(!text.contains(sentinel), "{sentinel} in {text}");
    }
    assert_eq!(error_of(&events).0, "api_error");
    assert!(text.contains("PVE answered 500"));
    drop(fake);
}
