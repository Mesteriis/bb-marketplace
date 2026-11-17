//! The RDP connection sequence of the engine: TCP + X.224, TLS with strict
//! validation and the certificate decision, then authentication.
//!
//! Security rules enforced here (stage 2b contract B3/B4):
//! * nothing identifying leaves before TLS: the X.224 routing cookie is the
//!   fixed `remote-hub`, never the username (the password is only sent inside
//!   the encrypted Client Info PDU / CredSSP after the certificate decision);
//! * the SHA-256 of the peer leaf certificate is computed after EVERY TLS
//!   handshake, reported to the helper, and compared with `expectedFingerprint`
//!   BEFORE `connect_finalize`, whether or not the certificate validated (the
//!   pinned `ironrdp-tls` calls its callback only on validation failure);
//! * the connect budget is time-boxed per phase (TCP+X.224, TLS, finalize,
//!   15 s each); the certificate prompt waits up to its own 60 s and is not
//!   charged to the TLS budget. Loading the system roots happens inside the TLS
//!   handshake and IS charged to it (bound: `Timeouts::tls`, then `timeout`).
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::task::Poll;
use std::sync::mpsc::{Receiver, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use ironrdp_connector::sspi::generator::NetworkRequest;
use ironrdp_connector::{
    ClientConnector, Config, ConnectionResult, ConnectorError, ConnectorErrorKind, ConnectorResult, Credentials,
    DesktopSize, ServerName,
};
use ironrdp_pdu::nego::NegoRequestData;
use ironrdp_tls::{extract_tls_server_public_key, upgrade_with_certificate_validation_callback_for_endpoint, CertificateValidationCallback};
use ironrdp_tokio::{connect_begin, connect_finalize, mark_as_upgraded, split_tokio_framed, TokioFramed};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::net::TcpStream;

use super::cert::{fingerprint_matches, fingerprint_sha256, parse_cert_fields, CertFields};
use super::engine_io::{Cancel, Decision, Out};
use super::mapping::{self, Phase};
use super::protocol::EngineEvent;
use super::reasons::RdpClosedReason;
use crate::secret::Secret;

/// The product string sent as the RDP client name (never the target host).
pub const CLIENT_NAME: &str = "remote-hub";
/// The non-identifying X.224 routing cookie value.
pub const ROUTING_COOKIE: &str = "remote-hub";

/// A monotonic clock the TLS time budget is measured on. Production uses
/// `SystemClock`; a test injects a manual clock so no test depends on how fast
/// the machine completes a handshake.
pub trait Clock: Send + Sync {
    /// Time since an arbitrary fixed origin.
    fn now(&self) -> Duration;
}

pub struct SystemClock {
    origin: Instant,
}

impl SystemClock {
    pub fn new() -> Self {
        SystemClock { origin: Instant::now() }
    }
}

impl Default for SystemClock {
    fn default() -> Self {
        Self::new()
    }
}

impl Clock for SystemClock {
    fn now(&self) -> Duration {
        self.origin.elapsed()
    }
}

/// The TLS phase budget: elapsed time on `clock` since the phase started, MINUS
/// the time the user spent deciding on a certificate.
struct Meter {
    clock: Arc<dyn Clock>,
    started: Duration,
    budget: Duration,
    prompt_spent: Mutex<Duration>,
}

impl Meter {
    fn new(clock: Arc<dyn Clock>, budget: Duration) -> Self {
        let started = clock.now();
        Meter { clock, started, budget, prompt_spent: Mutex::new(Duration::ZERO) }
    }

    fn add_prompt_time(&self, spent: Duration) {
        *self.prompt_spent.lock().unwrap() += spent;
    }

    fn active(&self) -> Duration {
        let spent = *self.prompt_spent.lock().unwrap();
        self.clock.now().saturating_sub(self.started).saturating_sub(spent)
    }

    fn exceeded(&self) -> bool {
        self.active() >= self.budget
    }
}

/// How often an idle TLS handshake re-checks its budget.
const BUDGET_TICK: Duration = Duration::from_millis(50);

#[derive(Debug, Clone, Copy)]
pub struct Timeouts {
    /// TCP connect + X.224 negotiation.
    pub connect: Duration,
    /// The TLS handshake, INCLUDING loading the system root certificates (done
    /// inside the handshake by the pinned ironrdp-tls) but excluding the time
    /// the user spends deciding on a certificate.
    pub tls: Duration,
    /// How long the certificate prompt waits for a decision.
    pub prompt: Duration,
    /// Security exchange, licensing, capabilities, activation.
    pub finalize: Duration,
}

impl Default for Timeouts {
    fn default() -> Self {
        Timeouts {
            connect: Duration::from_secs(15),
            tls: Duration::from_secs(15),
            prompt: Duration::from_secs(60),
            finalize: Duration::from_secs(15),
        }
    }
}

pub struct Params {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub password: Secret,
    pub domain: Option<String>,
    pub width: u32,
    pub height: u32,
    pub expected_fingerprint: Option<String>,
}

pub trait AsyncReadWrite: AsyncRead + AsyncWrite + Unpin + Send + Sync {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send + Sync> AsyncReadWrite for T {}

pub type BoxStream = Box<dyn AsyncReadWrite>;
pub type FramedRead = TokioFramed<tokio::io::ReadHalf<BoxStream>>;
pub type FramedWrite = TokioFramed<tokio::io::WriteHalf<BoxStream>>;

pub struct TlsOutcome {
    pub stream: BoxStream,
    /// DER of the peer leaf certificate exactly as presented.
    pub leaf_der: Vec<u8>,
    /// The server public key CredSSP binds to.
    pub public_key: Vec<u8>,
}

pub type UpgradeFuture = Pin<Box<dyn Future<Output = std::io::Result<TlsOutcome>> + Send>>;

/// The TLS step, behind a seam so tests can present a certificate that
/// validates against a test root.
pub trait TlsUpgrader: Send + Sync {
    fn upgrade(&self, tcp: TcpStream, host: String, callback: CertificateValidationCallback) -> UpgradeFuture;
}

/// Strict validation against the system roots; `callback` runs only when
/// validation fails.
pub struct SystemTls;

impl TlsUpgrader for SystemTls {
    fn upgrade(&self, tcp: TcpStream, host: String, callback: CertificateValidationCallback) -> UpgradeFuture {
        Box::pin(async move {
            let (tls, cert) =
                upgrade_with_certificate_validation_callback_for_endpoint(tcp, &host, &host, callback).await?;
            let leaf_der = tls
                .get_ref()
                .1
                .peer_certificates()
                .and_then(|certs| certs.first())
                .map(|c| c.as_ref().to_vec())
                .ok_or_else(|| std::io::Error::other("peer certificate is missing"))?;
            let public_key = extract_tls_server_public_key(&cert)
                .ok_or_else(|| std::io::Error::other("server certificate has no public key"))?
                .to_vec();
            Ok(TlsOutcome { stream: Box::new(tls), leaf_der, public_key })
        })
    }
}

/// Kerberos KDC proxying is not supported: every network request fails.
pub struct NoopNetworkClient;

impl ironrdp_tokio::NetworkClient for NoopNetworkClient {
    fn send(&mut self, _request: &NetworkRequest) -> impl Future<Output = ConnectorResult<Vec<u8>>> {
        async move {
            Err(ConnectorError::new(
                "kdc proxy",
                ConnectorErrorKind::Reason("no network client; Kerberos KDC proxying is not implemented".into()),
            ))
        }
    }
}

pub struct Connected {
    pub reader: FramedRead,
    pub writer: FramedWrite,
    pub connection: ConnectionResult,
}

pub fn connector_config(p: &Params) -> Config {
    Config {
        desktop_size: DesktopSize { width: p.width as u16, height: p.height as u16 },
        monitor_layout: None,
        desktop_scale_factor: 0,
        desktop_physical_size: None,
        desktop_orientation: None,
        device_scale_factor: None,
        monitor_extended_layout: None,
        relative_mouse_input: false,
        enable_tls: true,
        enable_credssp: true,
        enable_standard_rdp_security: false,
        credentials: Credentials::UsernamePassword {
            username: p.username.clone(),
            password: p.password.expose().to_string(),
        },
        domain: p.domain.clone(),
        client_build: 2600,
        client_name: CLIENT_NAME.to_string(),
        keyboard_type: ironrdp_pdu::gcc::KeyboardType::IBM_ENHANCED,
        keyboard_subtype: 0,
        keyboard_functional_keys_count: 12,
        keyboard_layout: 0x409,
        connection_type: ironrdp_pdu::gcc::ConnectionType::Lan,
        ime_file_name: String::new(),
        bitmap: None,
        dig_product_id: String::new(),
        client_dir: String::new(),
        alternate_shell: String::new(),
        work_dir: String::new(),
        remote_application_mode: false,
        rail_support_level: ironrdp_pdu::rdp::capability_sets::RailSupportLevel::empty(),
        platform: ironrdp_pdu::rdp::capability_sets::MajorPlatformType::UNSPECIFIED,
        hardware_id: None,
        // Without this IronRDP builds the X.224 cookie from the username and
        // sends it in clear before TLS.
        request_data: Some(NegoRequestData::cookie(ROUTING_COOKIE.to_string())),
        // Only sets INFO_AUTOLOGON in the Client Info PDU; the credentials are
        // sent there (after TLS) either way.
        autologon: true,
        enable_audio_playback: false,
        enable_audio_capture: false,
        performance_flags: ironrdp_pdu::rdp::client_info::PerformanceFlags::default(),
        license_cache: None,
        timezone_info: ironrdp_pdu::rdp::client_info::TimezoneInfo::default(),
        compression_type: None,
        enable_server_pointer: false,
        pointer_software_rendering: false,
        multitransport_flags: None,
        support_dyn_vc_gfx_protocol: false,
    }
}

pub enum DecisionOutcome {
    Accepted,
    Rejected,
    TimedOut,
    Cancelled(RdpClosedReason),
}

/// Wait for a decision naming `presented_fp`. A decision that names another
/// fingerprint is ignored (the helper refuses it before it gets here); only a
/// matching `once` / `session_trust` accepts, any other matching value rejects.
pub fn wait_for_decision(rx: &Receiver<Decision>, presented_fp: &str, timeout: Duration) -> DecisionOutcome {
    let deadline = Instant::now() + timeout;
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return DecisionOutcome::TimedOut;
        }
        match rx.recv_timeout(left) {
            Ok(Decision::Cert { fingerprint, accept }) => {
                if fingerprint_matches(presented_fp, &fingerprint) {
                    return if accept == "once" || accept == "session_trust" {
                        DecisionOutcome::Accepted
                    } else {
                        DecisionOutcome::Rejected
                    };
                }
            }
            Ok(Decision::Cancel(reason)) => return DecisionOutcome::Cancelled(reason),
            Err(RecvTimeoutError::Timeout) => return DecisionOutcome::TimedOut,
            Err(RecvTimeoutError::Disconnected) => return DecisionOutcome::Cancelled(RdpClosedReason::HelperShutdown),
        }
    }
}

/// After the TLS handshake: fingerprint the leaf, report it, and enforce the
/// expected fingerprint before anything is sent. Returns the fingerprint.
pub fn check_presented_certificate(
    out: &Out,
    leaf_der: &[u8],
    validated: bool,
    expected: Option<&str>,
) -> Result<String, RdpClosedReason> {
    let fingerprint = fingerprint_sha256(leaf_der);
    out.send(&EngineEvent::Certificate { fingerprint: fingerprint.clone(), validated })
        .map_err(|_| RdpClosedReason::HelperShutdown)?;
    if let Some(expected) = expected {
        if !fingerprint_matches(&fingerprint, expected) {
            return Err(RdpClosedReason::CertChanged);
        }
    }
    Ok(fingerprint)
}

/// Run `fut` unless the session is cancelled first.
async fn cancellable<T>(cancel: &Cancel, fut: impl Future<Output = T>) -> Result<T, RdpClosedReason> {
    tokio::select! {
        r = fut => Ok(r),
        reason = cancel.wait() => Err(reason),
    }
}

/// Run `fut` within `budget`, or fail with `timeout`; cancellable.
async fn phase<T>(cancel: &Cancel, budget: Duration, fut: impl Future<Output = T>) -> Result<T, RdpClosedReason> {
    match cancellable(cancel, tokio::time::timeout(budget, fut)).await? {
        Ok(v) => Ok(v),
        Err(_) => Err(RdpClosedReason::Timeout),
    }
}

struct PromptContext {
    out: Arc<Out>,
    decisions: Mutex<Receiver<Decision>>,
    host: String,
    port: u16,
    expected: Option<String>,
    prompt_timeout: Duration,
    forced: Mutex<Option<RdpClosedReason>>,
    /// The TLS budget; the callback credits the time the user spent deciding.
    meter: Meter,
    /// Set when strict validation failed (the callback ran).
    invoked: AtomicBool,
}

fn handle_validation_failure(ctx: &PromptContext, der: &[u8], error: &str) -> bool {
    ctx.invoked.store(true, Ordering::SeqCst);
    let presented = fingerprint_sha256(der);
    if let Some(expected) = &ctx.expected {
        // A pinned certificate that fails validation is accepted only when it
        // is exactly the pinned one.
        if fingerprint_matches(&presented, expected) {
            return true;
        }
        *ctx.forced.lock().unwrap() = Some(RdpClosedReason::CertChanged);
        return false;
    }
    // The prompt clock starts BEFORE the prompt is announced: once the user can
    // see it they may decide at any moment, and all of that time is theirs.
    let started = ctx.meter.clock.now();
    let fields = parse_cert_fields(der).unwrap_or(CertFields {
        subject: String::new(),
        issuer: String::new(),
        not_before: String::new(),
        not_after: String::new(),
    });
    let sent = ctx.out.state("cert_prompt").and_then(|_| {
        ctx.out.send(&EngineEvent::CertPrompt {
            host: ctx.host.clone(),
            port: ctx.port,
            fingerprint: presented.clone(),
            subject: fields.subject,
            issuer: fields.issuer,
            not_before: fields.not_before,
            not_after: fields.not_after,
            reason: mapping::cert_reason_code(error).to_string(),
            detail: Some(error.to_string()),
        })
    });
    if sent.is_err() {
        *ctx.forced.lock().unwrap() = Some(RdpClosedReason::HelperShutdown);
        return false;
    }
    // The wait blocks this thread; `block_in_place` hands the runtime's other
    // work to another worker while it does.
    let outcome = tokio::task::block_in_place(|| {
        let rx = ctx.decisions.lock().unwrap();
        wait_for_decision(&rx, &presented, ctx.prompt_timeout)
    });
    ctx.meter.add_prompt_time(ctx.meter.clock.now().saturating_sub(started));
    match outcome {
        DecisionOutcome::Accepted => true,
        DecisionOutcome::Rejected | DecisionOutcome::TimedOut => {
            *ctx.forced.lock().unwrap() = Some(RdpClosedReason::CertRejected);
            false
        }
        DecisionOutcome::Cancelled(reason) => {
            *ctx.forced.lock().unwrap() = Some(reason);
            false
        }
    }
}

/// The TLS handshake under its budget (`Meter`): the budget does not run while
/// the user decides on a certificate. It is re-checked after every poll that
/// leaves the handshake waiting, and on a short tick while it is idle.
async fn tls_phase(
    ctx: &Arc<PromptContext>,
    cancel: &Cancel,
    tls: &dyn TlsUpgrader,
    tcp: TcpStream,
) -> Result<std::io::Result<TlsOutcome>, RdpClosedReason> {
    let callback_ctx = ctx.clone();
    let callback: CertificateValidationCallback =
        Arc::new(move |der, _endpoint, error| handle_validation_failure(&callback_ctx, der, error));
    let upgrade = tls.upgrade(tcp, ctx.host.clone(), callback);
    tokio::pin!(upgrade);
    loop {
        let guarded = std::future::poll_fn(|cx| match upgrade.as_mut().poll(cx) {
            Poll::Ready(r) => Poll::Ready(Some(r)),
            Poll::Pending if ctx.meter.exceeded() => Poll::Ready(None),
            Poll::Pending => Poll::Pending,
        });
        tokio::select! {
            r = guarded => return r.ok_or(RdpClosedReason::Timeout),
            reason = cancel.wait() => return Err(reason),
            _ = tokio::time::sleep(BUDGET_TICK) => {
                if ctx.meter.exceeded() {
                    return Err(RdpClosedReason::Timeout);
                }
            }
        }
    }
}

fn helper_gone<T>(r: std::io::Result<T>) -> Result<T, RdpClosedReason> {
    r.map_err(|_| RdpClosedReason::HelperShutdown)
}

/// The whole connection sequence. On `Err` the caller reports the reason as
/// the session's closed reason.
pub async fn connect_sequence(
    params: Params,
    timeouts: Timeouts,
    out: Arc<Out>,
    decisions: Receiver<Decision>,
    cancel: Arc<Cancel>,
    clock: Arc<dyn Clock>,
    tls: &dyn TlsUpgrader,
) -> Result<Connected, RdpClosedReason> {
    helper_gone(out.state("connecting"))?;

    // Phase 1: TCP + X.224 (nothing identifying: cookie is fixed).
    let begin = phase(&cancel, timeouts.connect, async {
        let tcp = TcpStream::connect((params.host.as_str(), params.port))
            .await
            .map_err(|_| RdpClosedReason::NetworkError)?;
        let client_addr = tcp.local_addr().map_err(|_| RdpClosedReason::NetworkError)?;
        let mut connector = ClientConnector::new(connector_config(&params), client_addr);
        let mut framed = TokioFramed::new(tcp);
        let should_upgrade = connect_begin(&mut framed, &mut connector)
            .await
            .map_err(|e| mapping::map_connector_error(Phase::Negotiate, &e))?;
        let (tcp, leftover) = framed.into_inner();
        Ok::<_, RdpClosedReason>((tcp, leftover, connector, should_upgrade))
    })
    .await??;
    let (tcp, leftover, mut connector, should_upgrade) = begin;

    // Phase 2: TLS. Credentials have not left the process.
    helper_gone(out.state("tls"))?;
    let ctx = Arc::new(PromptContext {
        out: out.clone(),
        decisions: Mutex::new(decisions),
        host: params.host.clone(),
        port: params.port,
        expected: params.expected_fingerprint.clone(),
        prompt_timeout: timeouts.prompt,
        forced: Mutex::new(None),
        meter: Meter::new(clock, timeouts.tls),
        invoked: AtomicBool::new(false),
    });
    let upgraded = tls_phase(&ctx, &cancel, tls, tcp).await?;
    let outcome = match upgraded {
        Ok(o) => o,
        Err(_) => {
            let forced = *ctx.forced.lock().unwrap();
            return Err(forced.unwrap_or(RdpClosedReason::TlsError));
        }
    };
    let validated = !ctx.invoked.load(Ordering::SeqCst);
    // Every handshake: report, and enforce the pin, before anything is sent.
    check_presented_certificate(&out, &outcome.leaf_der, validated, params.expected_fingerprint.as_deref())?;

    // Phase 3: authenticate.
    helper_gone(out.state("authenticating"))?;
    let upgraded_token = mark_as_upgraded(should_upgrade, &mut connector);
    let mut framed = TokioFramed::new_with_leftover(outcome.stream, leftover);
    let host = params.host.clone();
    let public_key = outcome.public_key;
    let connection = phase(&cancel, timeouts.finalize, async {
        let result = connect_finalize(
            upgraded_token,
            connector,
            &mut framed,
            &mut NoopNetworkClient,
            ServerName::from(host.as_str()),
            public_key,
            None,
        )
        .await
        .map_err(|e| mapping::map_connector_error(Phase::Finalize, &e))?;
        result.into_connected().map_err(|e| mapping::map_connector_error(Phase::Finalize, &e))
    })
    .await??;
    let (reader, writer) = split_tokio_framed(framed);
    Ok(Connected { reader, writer, connection })
}

#[cfg(test)]
mod tests {
    //! No test here depends on how fast the machine runs: the TLS budget is
    //! measured on a manual clock the test advances explicitly, and every
    //! "wait for X" is an event (a condition variable on the collected engine
    //! events), not a sleep. Real-time values that remain are the prompt wait
    //! (a `recv_timeout` whose outcome is the same at any speed) and hang
    //! guards.
    use super::*;
    use std::sync::atomic::AtomicU64;
    use std::sync::mpsc::{channel, Sender};
    use std::sync::Condvar;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    const CA_DER: &[u8] = include_bytes!("../../tests/fixtures/tls-ca.der");
    const LEAF_DER: &[u8] = include_bytes!("../../tests/fixtures/tls-leaf.der");
    const LEAF_KEY: &[u8] = include_bytes!("../../tests/fixtures/tls-leaf-key.pkcs8.der");
    /// `openssl x509 -in leaf.pem -noout -fingerprint -sha256` of the fixture.
    const LEAF_FP: &str = "B6:88:41:D8:62:DD:80:8C:E2:A8:39:E1:26:D1:66:00:9D:51:54:09:DD:16:E2:A7:CB:DF:0D:3B:E1:1D:43:2E";
    const OTHER_FP: &str = "AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA";

    /// A clock that only moves when a test says so.
    struct ManualClock(AtomicU64);

    impl ManualClock {
        fn new() -> Arc<Self> {
            Arc::new(ManualClock(AtomicU64::new(0)))
        }
        fn advance(&self, by: Duration) {
            self.0.fetch_add(by.as_millis() as u64, Ordering::SeqCst);
        }
    }

    impl Clock for ManualClock {
        fn now(&self) -> Duration {
            Duration::from_millis(self.0.load(Ordering::SeqCst))
        }
    }

    /// Server-side TLS config presenting the fixture leaf.
    fn server_tls(tls12_only: bool) -> tokio_rustls::TlsAcceptor {
        use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};
        let provider = Arc::new(rustls::crypto::ring::default_provider());
        let versions: &[&'static rustls::SupportedProtocolVersion] =
            if tls12_only { &[&rustls::version::TLS12] } else { rustls::ALL_VERSIONS };
        let config = rustls::ServerConfig::builder_with_provider(provider)
            .with_protocol_versions(versions)
            .unwrap()
            .with_no_client_auth()
            .with_single_cert(
                vec![CertificateDer::from(LEAF_DER.to_vec())],
                PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(LEAF_KEY.to_vec())),
            )
            .unwrap();
        tokio_rustls::TlsAcceptor::from(Arc::new(config))
    }

    /// A TLS client that trusts the fixture CA, so the fixture leaf VALIDATES
    /// and the certificate callback never runs.
    struct TestCaTls;

    impl TlsUpgrader for TestCaTls {
        fn upgrade(&self, tcp: TcpStream, host: String, _callback: CertificateValidationCallback) -> UpgradeFuture {
            Box::pin(async move {
                use rustls::pki_types::{CertificateDer, ServerName};
                use x509_cert::der::Decode as _;
                let mut roots = rustls::RootCertStore::empty();
                roots.add(CertificateDer::from(CA_DER.to_vec())).unwrap();
                let provider = Arc::new(rustls::crypto::ring::default_provider());
                let config = rustls::ClientConfig::builder_with_provider(provider)
                    .with_safe_default_protocol_versions()
                    .unwrap()
                    .with_root_certificates(roots)
                    .with_no_client_auth();
                let name = ServerName::try_from(host).unwrap();
                let tls = tokio_rustls::TlsConnector::from(Arc::new(config)).connect(name, tcp).await?;
                let leaf_der = tls.get_ref().1.peer_certificates().unwrap()[0].as_ref().to_vec();
                let cert = x509_cert::Certificate::from_der(&leaf_der).map_err(std::io::Error::other)?;
                let public_key = extract_tls_server_public_key(&cert).unwrap().to_vec();
                Ok(TlsOutcome { stream: Box::new(tls), leaf_der, public_key })
            })
        }
    }

    #[derive(Clone, Copy)]
    enum Server {
        /// Read the X.224 request, then say nothing.
        Silent,
        /// Answer the request selecting TLS, then run a TLS handshake with the
        /// fixture leaf and read until the client goes away.
        Tls,
        /// As `Tls`, but TLS 1.2 only. Its client handshake waits for the
        /// server after verifying the certificate, so the handshake is still
        /// pending when the callback returns (what Windows servers do).
        Tls12,
    }

    /// Spawns the fake server; returns its port and the bytes the client sent
    /// before any TLS.
    fn spawn_server(rt: &tokio::runtime::Runtime, mode: Server) -> (u16, Arc<(Mutex<Vec<u8>>, Condvar)>) {
        let listener = rt.block_on(tokio::net::TcpListener::bind("127.0.0.1:0")).unwrap();
        let port = listener.local_addr().unwrap().port();
        let captured = Arc::new((Mutex::new(Vec::new()), Condvar::new()));
        let cap = captured.clone();
        rt.spawn(async move {
            let Ok((mut sock, _)) = listener.accept().await else { return };
            // X.224 Connection Request: TPKT header (03 00, length BE) + body.
            let mut hdr = [0u8; 4];
            if sock.read_exact(&mut hdr).await.is_err() {
                return;
            }
            let len = u16::from_be_bytes([hdr[2], hdr[3]]) as usize;
            let mut body = vec![0u8; len.saturating_sub(4)];
            if sock.read_exact(&mut body).await.is_err() {
                return;
            }
            {
                let mut got = cap.0.lock().unwrap();
                got.extend_from_slice(&hdr);
                got.extend_from_slice(&body);
                cap.1.notify_all();
            }
            match mode {
                Server::Silent => tokio::time::sleep(Duration::from_secs(60)).await,
                Server::Tls | Server::Tls12 => {
                    // X.224 Connection Confirm selecting PROTOCOL_SSL (1):
                    // TPKT(19) + LI 14 + CC + RDP_NEG_RSP{type 2, len 8, SSL}.
                    let confirm: [u8; 19] =
                        [3, 0, 0, 19, 14, 0xD0, 0, 0, 0, 0, 0, 2, 0, 8, 0, 1, 0, 0, 0];
                    if sock.write_all(&confirm).await.is_err() {
                        return;
                    }
                    if let Ok(mut tls) = server_tls(matches!(mode, Server::Tls12)).accept(sock).await {
                        let mut sink = [0u8; 4096];
                        while matches!(tls.read(&mut sink).await, Ok(n) if n > 0) {}
                    }
                }
            }
        });
        (port, captured)
    }

    /// Engine events as the helper would see them, collected from the socket.
    #[derive(Clone)]
    struct Collector {
        events: Arc<(Mutex<Vec<EngineEvent>>, Condvar)>,
        ended: Arc<(Mutex<bool>, Condvar)>,
    }

    impl Collector {
        fn start(mut peer: std::os::unix::net::UnixStream) -> Collector {
            let events = Arc::new((Mutex::new(Vec::new()), Condvar::new()));
            let ended = Arc::new((Mutex::new(false), Condvar::new()));
            let shared = events.clone();
            let done = ended.clone();
            std::thread::spawn(move || {
                while let Ok(Some(body)) = super::super::engine_io::read_frame(&mut peer) {
                    if body.first() == Some(&crate::rdp::protocol::FRAME_CONTROL) {
                        if let Ok(ev) = serde_json::from_slice::<EngineEvent>(&body[1..]) {
                            shared.0.lock().unwrap().push(ev);
                            shared.1.notify_all();
                        }
                    }
                }
                *done.0.lock().unwrap() = true;
                done.1.notify_all();
            });
            Collector { events, ended }
        }

        /// Block until an event matches. The limit is a hang guard only.
        fn wait_for(&self, pred: impl Fn(&EngineEvent) -> bool) -> EngineEvent {
            let (lock, cv) = &*self.events;
            let deadline = Instant::now() + Duration::from_secs(30);
            let mut guard = lock.lock().unwrap();
            loop {
                if let Some(e) = guard.iter().find(|e| pred(e)) {
                    return e.clone();
                }
                let left = deadline.saturating_duration_since(Instant::now());
                assert!(
                    !left.is_zero(),
                    "hang guard: the awaited engine event never arrived; events so far: {:?}",
                    *guard
                );
                guard = cv.wait_timeout(guard, left).unwrap().0;
            }
        }

        /// Wait until every writer is gone and every event has been read, so
        /// the trace is complete.
        fn finish(&self) {
            let (lock, cv) = &*self.ended;
            let deadline = Instant::now() + Duration::from_secs(30);
            let mut ended = lock.lock().unwrap();
            while !*ended {
                let left = deadline.saturating_duration_since(Instant::now());
                assert!(!left.is_zero(), "hang guard: the engine's event stream never ended");
                ended = cv.wait_timeout(ended, left).unwrap().0;
            }
        }

        fn states(&self) -> Vec<String> {
            self.events
                .0
                .lock()
                .unwrap()
                .iter()
                .filter_map(|e| match e {
                    EngineEvent::State { state } => Some(state.clone()),
                    _ => None,
                })
                .collect()
        }

        fn all(&self) -> Vec<EngineEvent> {
            self.events.0.lock().unwrap().clone()
        }
    }

    fn params(port: u16, expected: Option<&str>) -> Params {
        Params {
            host: "127.0.0.1".to_string(),
            port,
            username: "tester-user".to_string(),
            password: Secret::new("S3cr3t-MARK-91"),
            domain: None,
            width: 800,
            height: 600,
            expected_fingerprint: expected.map(|s| s.to_string()),
        }
    }

    /// Generous phase budgets: only the tests that are ABOUT a timeout shorten one.
    fn budgets(prompt_ms: u64) -> Timeouts {
        Timeouts {
            connect: Duration::from_secs(120),
            tls: Duration::from_secs(15),
            prompt: Duration::from_millis(prompt_ms),
            finalize: Duration::from_secs(120),
        }
    }

    /// What a test's driver thread can see and do while the engine connects.
    struct Ctl {
        decisions: Sender<Decision>,
        collector: Collector,
        cancel: Arc<Cancel>,
        clock: Arc<ManualClock>,
        captured: Arc<(Mutex<Vec<u8>>, Condvar)>,
    }

    impl Ctl {
        fn prompt(&self) -> EngineEvent {
            self.collector.wait_for(|e| matches!(e, EngineEvent::CertPrompt { .. }))
        }

        /// Block until the server has seen the X.224 request.
        fn wait_request_seen(&self) {
            let (lock, cv) = &*self.captured;
            let mut got = lock.lock().unwrap();
            while got.is_empty() {
                got = cv.wait_timeout(got, Duration::from_secs(30)).unwrap().0;
            }
        }
    }

    struct Outcome {
        result: Result<(), RdpClosedReason>,
        collector: Collector,
        captured: Arc<(Mutex<Vec<u8>>, Condvar)>,
    }

    /// Run one connect against a fake server. `user` drives the decision side.
    fn run(
        mode: Server,
        expected: Option<&str>,
        timeouts: Timeouts,
        tls: &dyn TlsUpgrader,
        user: impl FnOnce(Ctl) + Send + 'static,
    ) -> Outcome {
        let rt = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().unwrap();
        let (port, captured) = spawn_server(&rt, mode);
        let (engine_end, peer) = std::os::unix::net::UnixStream::pair().unwrap();
        let out = Arc::new(Out::new(engine_end));
        let collector = Collector::start(peer);
        let (dec_tx, dec_rx) = channel();
        let cancel = Arc::new(Cancel::new());
        let clock = ManualClock::new();
        let ctl = Ctl {
            decisions: dec_tx.clone(),
            collector: collector.clone(),
            cancel: cancel.clone(),
            clock: clock.clone(),
            captured: captured.clone(),
        };
        let helper = std::thread::spawn(move || user(ctl));
        // The 30 s limit is a hang guard: no outcome here depends on it.
        let result = rt
            .block_on(async {
                tokio::time::timeout(
                    Duration::from_secs(30),
                    connect_sequence(params(port, expected), timeouts, out, dec_rx, cancel, clock, tls),
                )
                .await
                .expect("hang guard: connect_sequence did not finish")
            })
            .map(|_| ());
        let _ = helper.join();
        drop(dec_tx);
        rt.shutdown_background();
        collector.finish();
        Outcome { result, collector, captured }
    }

    /// G2: the username and password never leave before TLS; the routing
    /// cookie is the fixed product string. The session is cancelled once the
    /// server has the request (no timeout involved).
    #[test]
    fn nothing_identifying_is_sent_before_tls() {
        let out = run(Server::Silent, None, budgets(1000), &SystemTls, |ctl| {
            ctl.wait_request_seen();
            ctl.cancel.trigger(RdpClosedReason::KilledByClose);
        });
        assert_eq!(out.result.err(), Some(RdpClosedReason::KilledByClose));
        let sent = out.captured.0.lock().unwrap().clone();
        assert!(!sent.is_empty(), "the server saw no X.224 request");
        let text = String::from_utf8_lossy(&sent).to_string();
        assert!(!text.contains("tester-user"), "username in the pre-TLS request: {text:?}");
        assert!(!text.contains("S3cr3t-MARK-91"), "password in the pre-TLS request: {text:?}");
        assert!(text.contains("Cookie: mstshash=remote-hub\r\n"), "unexpected cookie: {text:?}");
    }

    /// G1: a certificate that VALIDATES (the callback never runs) but differs
    /// from `expectedFingerprint` is `cert_changed`, reported with its real
    /// fingerprint, and the sequence never reaches `authenticating`.
    #[test]
    fn a_validating_certificate_with_another_fingerprint_is_cert_changed() {
        let out = run(Server::Tls, Some(OTHER_FP), budgets(1000), &TestCaTls, |_| {});
        assert_eq!(out.result.err(), Some(RdpClosedReason::CertChanged));
        let states = out.collector.states();
        assert_eq!(states, vec!["connecting", "tls"], "credentials must not be reachable: {states:?}");
        let events = out.collector.all();
        assert!(
            events.contains(&EngineEvent::Certificate { fingerprint: LEAF_FP.to_string(), validated: true }),
            "the presented fingerprint was not reported: {events:?}"
        );
    }

    /// G1: the same validating certificate with the MATCHING fingerprint is
    /// reported (validated) and proceeds to authentication.
    #[test]
    fn a_validating_certificate_with_the_expected_fingerprint_proceeds() {
        let expected = LEAF_FP.to_lowercase().replace(':', "");
        let out = run(Server::Tls, Some(&expected), budgets(1000), &TestCaTls, |ctl| {
            // Reaching `authenticating` is the assertion; end the session there.
            ctl.collector.wait_for(|e| matches!(e, EngineEvent::State { state } if state == "authenticating"));
            ctl.cancel.trigger(RdpClosedReason::KilledByClose);
        });
        let states = out.collector.states();
        assert!(states.contains(&"authenticating".to_string()), "{states:?}");
        assert!(!states.contains(&"cert_prompt".to_string()));
        assert!(out
            .collector
            .all()
            .contains(&EngineEvent::Certificate { fingerprint: LEAF_FP.to_string(), validated: true }));
    }

    /// G3 + G4: the user decides far AFTER the TLS budget (20 s on the test
    /// clock against a 15 s budget); a decision naming another fingerprint is
    /// ignored (the prompt stays pending); the matching one connects. The prompt
    /// carries the real endpoint and a stable code.
    #[test]
    fn a_late_decision_still_connects_and_a_wrong_fingerprint_is_ignored() {
        let out = run(Server::Tls12, None, budgets(60_000), &SystemTls, |ctl| {
            let EngineEvent::CertPrompt { host, port, fingerprint, reason, detail, .. } = ctl.prompt() else { unreachable!() };
            assert_eq!(host, "127.0.0.1");
            assert!(port > 0);
            assert_eq!(fingerprint, LEAF_FP);
            assert_eq!(reason, "untrusted_root");
            assert!(detail.unwrap_or_default().contains("UnknownIssuer"));
            ctl.decisions.send(Decision::Cert { fingerprint: OTHER_FP.to_string(), accept: "once".to_string() }).unwrap();
            // The user takes 20 s: longer than the whole 15 s TLS budget.
            ctl.clock.advance(Duration::from_secs(20));
            ctl.decisions.send(Decision::Cert { fingerprint: fingerprint.clone(), accept: "once".to_string() }).unwrap();
            ctl.collector.wait_for(|e| matches!(e, EngineEvent::State { state } if state == "authenticating"));
            ctl.cancel.trigger(RdpClosedReason::KilledByClose);
        });
        let states = out.collector.states();
        assert!(
            states.contains(&"authenticating".to_string()),
            "the prompt time was charged to the TLS budget: {states:?} / {:?}",
            out.result.err()
        );
        assert!(out.collector.all().contains(&EngineEvent::Certificate { fingerprint: LEAF_FP.to_string(), validated: false }));
    }

    /// A TLS step that never finishes.
    struct StuckTls;

    impl TlsUpgrader for StuckTls {
        fn upgrade(&self, _tcp: TcpStream, _host: String, _callback: CertificateValidationCallback) -> UpgradeFuture {
            Box::pin(std::future::pending())
        }
    }

    /// The TLS budget does run while the handshake is slow and nobody is
    /// deciding: 14 s on the test clock is within budget, 16 s is `timeout`.
    #[test]
    fn the_tls_budget_runs_out_without_a_prompt() {
        let out = run(Server::Tls, None, budgets(60_000), &StuckTls, |ctl| {
            ctl.collector.wait_for(|e| matches!(e, EngineEvent::State { state } if state == "tls"));
            ctl.clock.advance(Duration::from_secs(14));
            // Still within budget: the session is alive, so cancel would be
            // the only way out. Prove it by waiting for a real tick, then push
            // the clock over the line.
            std::thread::sleep(Duration::from_millis(150));
            assert!(ctl.cancel.reason().is_none());
            ctl.clock.advance(Duration::from_secs(2));
        });
        assert_eq!(out.result.err(), Some(RdpClosedReason::Timeout));
    }

    /// A clock that notes whether the certificate prompt had already been written
    /// to the helper's socket at the moment it was read.
    struct PeekClock {
        peer: std::os::unix::net::UnixStream,
        reads: AtomicU64,
        /// Whether the prompt frame was in the socket at read number 2: read 1 is
        /// `Meter::new`, read 2 is the callback starting its prompt clock, read 3
        /// (after the decision) legitimately follows the prompt.
        prompt_visible_at_start: AtomicBool,
    }

    impl Clock for PeekClock {
        fn now(&self) -> Duration {
            use std::os::fd::AsRawFd;
            let mut buf = vec![0u8; 65536];
            let n = unsafe {
                libc::recv(
                    self.peer.as_raw_fd(),
                    buf.as_mut_ptr() as *mut libc::c_void,
                    buf.len(),
                    libc::MSG_PEEK | libc::MSG_DONTWAIT,
                )
            };
            let read_no = self.reads.fetch_add(1, Ordering::SeqCst) + 1;
            if read_no == 2
                && n > 0
                && String::from_utf8_lossy(&buf[..n as usize]).contains("\"type\":\"cert_prompt\"")
            {
                self.prompt_visible_at_start.store(true, Ordering::SeqCst);
            }
            Duration::ZERO
        }
    }

    /// The prompt clock starts BEFORE the prompt can be seen. If it started
    /// after, a user who decided (and a test clock that advanced) in between would
    /// be charged to the TLS budget — the race behind a load-only failure of the
    /// late-decision test. Deterministic: the clock reports whether the prompt
    /// frame was already in the socket whenever the callback read it.
    #[test]
    fn the_prompt_clock_starts_before_the_prompt_is_announced() {
        let (engine_end, peer) = std::os::unix::net::UnixStream::pair().unwrap();
        let clock = Arc::new(PeekClock {
            peer,
            reads: AtomicU64::new(0),
            prompt_visible_at_start: AtomicBool::new(false),
        });
        let (dec_tx, dec_rx) = channel();
        let ctx = Arc::new(PromptContext {
            out: Arc::new(Out::new(engine_end)),
            decisions: Mutex::new(dec_rx),
            host: "127.0.0.1".to_string(),
            port: 3389,
            expected: None,
            prompt_timeout: Duration::from_secs(30),
            forced: Mutex::new(None),
            meter: Meter::new(clock.clone(), Duration::from_secs(15)),
            invoked: AtomicBool::new(false),
        });
        dec_tx.send(Decision::Cert { fingerprint: LEAF_FP.to_string(), accept: "once".to_string() }).unwrap();
        let rt = tokio::runtime::Builder::new_multi_thread().worker_threads(1).enable_all().build().unwrap();
        // block_in_place needs a runtime context.
        let accepted = rt.block_on(async { handle_validation_failure(&ctx, LEAF_DER, "invalid peer certificate: UnknownIssuer") });
        assert!(accepted);
        assert!(
            !clock.prompt_visible_at_start.load(Ordering::SeqCst),
            "the prompt clock started after the prompt frame was already written"
        );
        assert_eq!(clock.reads.load(Ordering::SeqCst), 3, "Meter::new, prompt start, prompt end");
    }

    #[test]
    fn meter_charges_active_time_only() {
        let clock = ManualClock::new();
        let meter = Meter::new(clock.clone(), Duration::from_secs(15));
        assert!(!meter.exceeded());
        clock.advance(Duration::from_secs(14));
        assert!(!meter.exceeded());
        clock.advance(Duration::from_secs(1));
        assert!(meter.exceeded(), "15 s of active time exhausts a 15 s budget");

        let clock = ManualClock::new();
        let meter = Meter::new(clock.clone(), Duration::from_secs(15));
        clock.advance(Duration::from_secs(20));
        meter.add_prompt_time(Duration::from_secs(20)); // the user decided for 20 s
        assert_eq!(meter.active(), Duration::ZERO);
        assert!(!meter.exceeded());
        clock.advance(Duration::from_secs(15));
        assert!(meter.exceeded(), "time after the prompt counts again");
    }

    #[test]
    fn rejecting_the_prompt_is_cert_rejected() {
        let out = run(Server::Tls, None, budgets(60_000), &SystemTls, |ctl| {
            let EngineEvent::CertPrompt { fingerprint, .. } = ctl.prompt() else { unreachable!() };
            ctl.decisions.send(Decision::Cert { fingerprint, accept: "reject".to_string() }).unwrap();
        });
        assert_eq!(out.result.err(), Some(RdpClosedReason::CertRejected));
        assert!(!out.collector.states().contains(&"authenticating".to_string()));
    }

    /// An unanswered prompt ends as `cert_rejected` after its own wait. The
    /// wait is a `recv_timeout` that starts when the prompt is shown, so the
    /// outcome does not depend on how long the handshake took to get there.
    #[test]
    fn an_unanswered_prompt_times_out_as_cert_rejected() {
        let out = run(Server::Tls, None, budgets(300), &SystemTls, |_| {});
        assert_eq!(out.result.err(), Some(RdpClosedReason::CertRejected));
    }

    #[test]
    fn closing_during_the_prompt_cancels_the_session() {
        let out = run(Server::Tls, None, budgets(60_000), &SystemTls, |ctl| {
            let _ = ctl.prompt();
            ctl.decisions.send(Decision::Cancel(RdpClosedReason::KilledByClose)).unwrap();
        });
        assert_eq!(out.result.err(), Some(RdpClosedReason::KilledByClose));
    }

    /// A phase that never completes ends as `timeout`: the server never
    /// answers the X.224 request, so the 300 ms connect budget runs out. The
    /// outcome is the same at any machine speed (there is nothing to finish).
    #[test]
    fn the_connect_phase_times_out() {
        let t = Timeouts { connect: Duration::from_millis(300), ..budgets(1000) };
        let out = run(Server::Silent, None, t, &SystemTls, |_| {});
        assert_eq!(out.result.err(), Some(RdpClosedReason::Timeout));
    }

    #[test]
    fn a_decision_must_name_the_presented_fingerprint() {
        let (tx, rx) = channel();
        tx.send(Decision::Cert { fingerprint: OTHER_FP.to_string(), accept: "once".to_string() }).unwrap();
        tx.send(Decision::Cert { fingerprint: "not-a-fingerprint".to_string(), accept: "once".to_string() }).unwrap();
        // Neither names the prompt's fingerprint: still waiting -> times out.
        assert!(matches!(wait_for_decision(&rx, LEAF_FP, Duration::from_millis(100)), DecisionOutcome::TimedOut));
        tx.send(Decision::Cert { fingerprint: LEAF_FP.to_lowercase(), accept: "session_trust".to_string() }).unwrap();
        assert!(matches!(wait_for_decision(&rx, LEAF_FP, Duration::from_secs(60)), DecisionOutcome::Accepted));
        tx.send(Decision::Cert { fingerprint: LEAF_FP.to_string(), accept: "maybe".to_string() }).unwrap();
        assert!(matches!(wait_for_decision(&rx, LEAF_FP, Duration::from_secs(60)), DecisionOutcome::Rejected));
        tx.send(Decision::Cancel(RdpClosedReason::HelperShutdown)).unwrap();
        assert!(matches!(
            wait_for_decision(&rx, LEAF_FP, Duration::from_secs(60)),
            DecisionOutcome::Cancelled(RdpClosedReason::HelperShutdown)
        ));
    }

    /// The fixed product string, never the target host.
    #[test]
    fn client_name_is_the_product_string() {
        let cfg = connector_config(&params(3389, None));
        assert_eq!(cfg.client_name, "remote-hub");
        assert!(cfg.autologon);
    }
}
