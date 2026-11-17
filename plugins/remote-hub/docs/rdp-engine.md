# Remote Hub — RDP engine (stage 2b)

Design record and as-built description of the RDP engine. The engine is
implemented (stage 2b-1, repaired after two independent reviews); this file
says what the code does today. Where it records a limit or a deviation it says
so explicitly.

## 1. Pinned crate set

IronRDP does not use one version number: each crate moves independently. The
coherent latest set (verified against crates.io on 2026-11-17) is:

| Crate | Version | Role | Licence |
| --- | --- | --- | --- |
| ironrdp-connector | =0.12.0 | connection sequence (X.224, MCS, security, licensing, activation) | MIT OR Apache-2.0 |
| ironrdp-tokio | =0.12.0 | async framing + `connect_begin`/`connect_finalize` glue | MIT OR Apache-2.0 |
| ironrdp-tls | =0.3.0 | TLS upgrade + cert validation + callback | MIT OR Apache-2.0 |
| ironrdp-session | =0.13.0 | active stage, fast-path, graphics output | MIT OR Apache-2.0 |
| ironrdp-pdu | =0.11.0 | PDU + input event types (`MousePdu`, `PointerFlags`, `KeyboardFlags`) | MIT OR Apache-2.0 |
| ironrdp-graphics | =0.11.0 | image decode (`PixelFormat`) | MIT OR Apache-2.0 |
| ironrdp-input | =0.9.0 | keyboard/mouse state → `FastPathInputEvent` | MIT OR Apache-2.0 |
| ironrdp-core | =0.3.1 | `WriteBuf`, codec traits | MIT OR Apache-2.0 |
| ironrdp-svc | =0.10.0 | static/dynamic channel plumbing | MIT OR Apache-2.0 |
| tokio | =1.54.1 | async runtime for the engine process | MIT |
| x509-cert | =0.3.0 | parse the server cert for fields | Apache-2.0 OR MIT |
| sha2 | =0.11.1 | SHA-256 fingerprint | MIT OR Apache-2.0 |
| png | =0.18.1 | screenshot encoder | MIT OR Apache-2.0 |

Every direct dependency in `helper/Cargo.toml` is an exact `=x.y.z` pin (libc
=0.2.191, serde =1.0.229, serde_json =1.0.154, and the rows above), so `Cargo.lock`
plus the manifest fix the whole tree. Dev-only: rustls =0.23.46, tokio-rustls
=0.26.6 (fake RDP server and test CA client).

Transitive IronRDP crates the above pull in: ironrdp-error 0.2, ironrdp-dvc
0.10, ironrdp-displaycontrol 0.10, ironrdp-bulk 0.2, ironrdp-egfx 0.5. All are
`MIT OR Apache-2.0`. `rust-version = "1.94"`; the toolchain here is 1.97.0.

The reference client `ironrdp-client` 0.1.0 pins an *older* set (connector
0.10, session 0.11, tls 0.2, pdu 0.9). I pin the latest coherent set above
instead, because its `ironrdp-tls` 0.3.0 is the version that added the
strict+certificate-callback API (see §3) that B3 requires; the older set's
tls crate lacks it.

## 2. Connection sequence (B2 state machine)

States: `connecting` → `tls` → (`cert_prompt`) → `authenticating` →
`desktop_ready` → `closed`.

The sequence lives in `helper/src/rdp/connect.rs` and is driven with
`ironrdp-tokio` + `ironrdp-connector` (mirrors `ironrdp-client-0.1.0/src/rdp.rs`).
Each phase has its own budget (`Timeouts`): TCP + X.224 15 s, TLS 15 s
(excluding the time the user spends deciding), authentication/finalize 15 s;
the certificate prompt waits up to 60 s on its own; after the connect sequence a
session that never paints leaves `authenticating` with `timeout` after 30 s
(`first_paint`). Worst cases without a prompt: 15 + 15 + 15 = 45 s to the end
of the connect sequence, 75 s to the first paint; with a prompt add the time
the user takes, at most 60 s (an unanswered prompt is `cert_rejected`). A
handshake that completes after its budget is a `timeout` as well. Loading the system root
certificates happens INSIDE the TLS handshake (the pinned ironrdp-tls does it
when it builds the client config), so a slow or cold root store is charged to
the TLS budget and, past 15 s, ends the session as `timeout` — a real product
bound, not a test artefact. The TLS budget is measured on an injectable `Clock`
(`connect.rs`, `Meter`): production uses `SystemClock`; tests use a manual
clock so no test depends on handshake speed.

1. `connecting`: `TcpStream::connect((host, port))`, then
   `ironrdp_tokio::TokioFramed::new(stream)`.
2. `ironrdp_tokio::connect_begin(&mut framed, &mut connector)` — X.224
   negotiation up to the TLS upgrade. **Nothing identifying is sent here**: the
   connector `request_data` is the fixed cookie `remote-hub`; without it IronRDP
   would build the routing cookie from the username and send it in clear.
3. `tls`: `ironrdp_tls::upgrade_with_certificate_validation_callback_for_endpoint(
   stream, server_name, endpoint, callback)` (behind the `TlsUpgrader` seam) —
   strict chain+hostname validation. `cert_prompt` is emitted from inside the
   callback, which blocks (`block_in_place`) up to 60 s for `rdp.cert_decision`,
   then `cert_rejected`. The prompt carries the real host and port, the
   fingerprint, subject/issuer/validity, a stable reason code
   (`untrusted_root`, `hostname_mismatch`, `expired`, `other`) and the library
   text only as `detail`.
4. After EVERY handshake (validated or not): the SHA-256 of the peer leaf is
   computed, reported as `rdp.certificate {fingerprint, validated}`, and compared
   with `expectedFingerprint` BEFORE `connect_finalize`; a mismatch is closed
   `cert_changed` and nothing is sent. This is needed because the pinned
   `ironrdp-tls` calls the callback only when strict validation FAILS — a
   certificate that validates never reaches it. Then
   `ironrdp_tls::extract_tls_server_public_key(&tls_cert)` gives the key CredSSP
   needs.
5. `authenticating`: `ironrdp_tokio::connect_finalize(upgraded, connector,
   &mut framed, &mut NoopNetworkClient, destination, server_public_key, None)` —
   security + licensing + capabilities + CredSSP/NLA when negotiated, then
   connection activation. **Kerberos is not supported**: `NoopNetworkClient`
   (the stand-in for IronRDP's reqwest-based client, which would add an HTTP
   stack) fails every network request, so KDC proxying is unavailable and NLA
   uses NTLM. `autologon: true` only sets `INFO_AUTOLOGON` in the Client Info
   PDU; the username/password travel in that PDU (encrypted, after TLS) or in
   CredSSP either way.
6. `desktop_ready`: after `connect_finalize` returns `ConnectionResult`, build
   the active stage; `rdp.desktop` is emitted when the first graphics update has
   been applied (§4).

Closed reasons are the literals `auth_failed`, `cert_rejected`, `cert_changed`,
`tls_error`, `protocol_error`, `network_error`, `timeout`, `killed_by_close`,
`engine_exited`, `helper_shutdown` and — added in the repair round —
`server_disconnected` (an orderly server-side end of the session, which is not a
protocol error). Mapping rules (`mapping.rs`, literal-tested): a server that
refuses TLS/HYBRID → `tls_error`; a CredSSP public-key echo/hash mismatch →
`tls_error` (a possible man in the middle, never `auth_failed`, never retried);
other CredSSP/`AccessDenied` failures → `auth_failed`; I/O failures →
`network_error`; anything else → `protocol_error`. `client_name` is the fixed
string `remote-hub`, never the target host.

Connector `Config` (ironrdp-connector 0.12.0 `src/lib.rs:150`) carries
`desktop_size`, `credentials: Credentials::UsernamePassword { username, password }`
(`src/lib.rs:120`), `domain: Option<String>` (`src/lib.rs:249`),
`enable_tls`, `enable_credssp` (NLA/CredSSP) and `enable_standard_rdp_security`.
B4 sets `enable_credssp = true` and `enable_tls = true` so NLA is offered and a
non-NLA server (xrdp) falls back to plain TLS security; standard RDP security
stays `false`.

## 3. TLS defaults of the pinned source (B3)

`ironrdp-tls 0.3.0` ships an **insecure default** that must not be inherited:

- `src/lib.rs:73-74` — the `CertificateValidation` enum's default variant is
  `#[default] DangerouslyAcceptInvalidCertificate` ("Accept any peer certificate
  and server name ... vulnerable to on-path attacks").
- `src/rustls.rs:11-15` — the plain `upgrade()` function calls
  `upgrade_with_certificate_validation(stream, server_name, CertificateValidation::default())`,
  i.e. the dangerous policy by default.

The strict path is the only one the engine may use:

- `src/rustls.rs:84` —
  `upgrade_with_certificate_validation_callback_for_endpoint` builds the client
  with `CertificateValidation::Strict` and `Some(callback)`.
- `src/rustls_verifier.rs:45-52` — `Strict` maps to
  `rustls::client::WebPkiServerVerifier::builder(Arc::new(platform_root_certificates()?))`.
- `src/rustls_verifier.rs:64-73` — `platform_root_certificates()` loads
  `rustls_native_certs::load_native_certs()` (the macOS system roots) and
  errors if no usable root is present.
- `src/rustls_verifier.rs:38-42` — "a certificate-validation callback requires
  strict validation" (callback + dangerous policy is refused).
- `src/rustls_verifier.rs:89-134` — `CallbackVerifier` wraps the strict verifier:
  on failure it invokes `CertificateValidationCallback` (`Arc<dyn Fn(&[u8], &str,
  &str) -> bool>`, `src/lib.rs:59`) with the leaf DER, endpoint and error; a
  `true` return accepts that cert for this handshake only.

TLS transport is `tokio-rustls 0.26` → `rustls 0.23`, crypto provider `ring`
(the only one linked; `aws-lc-rs` is in the lockfile but not built).
`src/rustls_verifier.rs:28` sets `config.key_log = Arc::new(KeyLogFile::new())`
unconditionally, which honours `SSLKEYLOGFILE` from the process environment. The
engine therefore always execs with an EMPTY environment (`manager::engine_env()`
is what `open` passes as `envp`; tested against `ps eww` of the real engine, with
`SSLKEYLOGFILE` set in the helper).

System roots with an empty environment: `rustls-native-certs 0.8.5` uses
Security.framework on macOS. Checked in a scratch binary: `env -i`, `env -u HOME`
and the normal environment all load 161 certificates with 0 errors on this Mac,
and the engine (empty env) validates strictly in the Docker run (xrdp's
self-signed certificate is reported as `untrusted_root`, not as a missing
store). Not verified: a corporate CA that is trusted only in the *user*
keychain domain — the count was identical with and without `HOME`, so this Mac
gave no evidence either way; if it does not load, the symptom is an
`untrusted_root` prompt for a certificate the user already trusts (a false
prompt, never a false accept). On non-macOS platforms `SSL_CERT_FILE` /
`SSL_CERT_DIR` would be ignored for the same reason.

So B3 is satisfiable with the pinned crate as written: use
`upgrade_with_certificate_validation_callback_for_endpoint` (Strict + callback),
compute the SHA-256 fingerprint of the presented leaf, and gate the callback's
`true` on the `rdp_cert_decision` naming that same fingerprint. There is no
global skip switch to add — the dangerous variant exists but is simply never
called.

## 4. Active stage, framebuffer and updates (B5)

- `DecodedImage::new(PixelFormat::RgbA32, width, height)` is the decode target;
  the engine copies only the dirty rectangle of each `GraphicsUpdate` into its
  own RGBA8 `Framebuffer` (`apply_from_image`, checked arithmetic).
- `ActiveStageBuilder { … }.build()` → active stage. Read loop:
  `reader.read_pdu()` → `active_stage.process(…)` → `Vec<ActiveStageOutput>`,
  multiplexed with the helper's commands and the cancel signal in one
  `tokio::select!` (a screenshot or ack therefore wakes an idle desktop).
- `ActiveStageOutput::Terminate(reason)` ends the session as
  `server_disconnected`.
- **Pacing (`pump.rs`, wired through `engine::Desk`)**: the engine sends only the
  dirty region, never the whole frame; at most ONE update is in flight; further
  regions coalesce into one pending region (taken from the framebuffer at send
  time, latest pixels win) until the consumer acks it with
  `rdp.update_ack {sessionId, frameId}` (helper request → `Ack` command). A
  stale ack (any frame id but the one in flight) releases nothing. An update
  larger than one wire frame is split into chunks sharing a `frameId`; every
  frame on either hop is at most 1 048 576 bytes **including all headers**
  (`rows_per_chunk`; at width 512 that is 511 rows, 1 046 569 bytes).
- **Helper bounds**: engine fds are polled and read only while the outbox has
  room for a whole update frame, with a per-turn frame/byte budget, so a client
  that stops reading stdout holds the engine back instead of growing the helper;
  a session whose transport ended leaves the poll set. The helper validates every
  engine frame (length, kind, JSON, pixel byte length `w*h*4`, rectangle inside a
  framebuffer ≤ 3840×2160, no overflow); any violation closes THAT session with
  `protocol_error` (engine killed and reaped, no resync attempt). Input is
  refused past 256 KiB of pending helper→engine bytes (`rdp_input_overflow`;
  the same cap covers acks and screenshot requests; a certificate decision and
  close always pass). `rdp.input` and `rdp.update_ack` before `desktop_ready` are
  refused with `not_ready`; acks coalesce to the newest `frameId`; at most 4
  screenshot requests are outstanding per session (`screenshot_busy`). The
  engine's reader thread never blocks on its own command channel (4096 entries):
  an overflow ends the session as `protocol_error`, so a close, a certificate
  decision or the helper's EOF is always read. Engine control frames are capped at
  4 MiB (the client's frame limit); every engine frame counts against the per-turn
  byte budget.
- `desktop_ready` (`rdp.desktop`) fires only after the first non-empty
  `GraphicsUpdate` has been applied (B2).
- First video path: plain bitmap updates (`ironrdp-graphics`), no native deps.

## 5. Input (B6)

`ironrdp-pdu 0.11.0` `src/input/fast_path.rs:115`:

- `FastPathInputEvent::KeyboardEvent(KeyboardFlags, u8)` — scancode key;
  `KeyboardFlags` (`src/input/fast_path.rs:250`) has `RELEASE`, `EXTENDED`,
  `EXTENDED1`. This carries the set-1 make code + extended flag produced by
  `src/core/rdp-keys.ts`.
- `FastPathInputEvent::UnicodeKeyboardEvent(KeyboardFlags, u16)` — text input
  for characters without a scancode.
- `FastPathInputEvent::MouseEvent(MousePdu { flags: PointerFlags,
  number_of_wheel_rotation_units, x_position, y_position })`
  (`src/input/mouse.rs:6`); `PointerFlags` (`src/input/mouse.rs:115`) has
  `MOVE`, `LEFT_BUTTON`, `RIGHT_BUTTON`, `MIDDLE_BUTTON_OR_WHEEL`, `DOWN`,
  `VERTICAL_WHEEL`, `HORIZONTAL_WHEEL`, `WHEEL_NEGATIVE`. Wheel rotation is a
  9-bit two's-complement value in `-256..=255`.

`ironrdp-input 0.9.0` adds a stateful layer: `Scancode::from_u8(extended, code)`
(`src/lib.rs:78`), `Operation::{KeyPressed, KeyReleased}` (`src/lib.rs:149-150`)
and `Database::apply(...) -> SmallVec<[FastPathInputEvent; 2]>`
(`src/lib.rs:217`), plus `release_all()` (`src/lib.rs:359`) for the "keys held
when focus is lost are released" rule.

Mouse moves are coalesced to the latest position (runs of moves collapse,
across queued batches, ordering with clicks and keys preserved). A rejected
event does not drop the rest of its batch: the engine reports
`rdp.input_rejected {applied, rejected: [{index, code}]}` with `stale_geometry`,
`out_of_bounds`, `invalid_scancode` or `invalid_button`. Accepted scancodes are
0x01–0x58 plus 0x5B, 0x5C, 0x5D (Windows/menu keys) when extended — exactly
`src/core/rdp-keys.ts`. Unicode text is a press and a release per UTF-16 unit
(characters above U+FFFF as a surrogate pair). `rdp.input`, `rdp.cert_decision`,
`rdp.update_ack` and `rdp.screenshot` for an unknown session answer
`session_not_found`. `rdp.open` refuses a desktop outside 1..=3840 × 1..=2160
with `rdp_invalid_geometry` before any engine starts. Screenshot answers are
matched to requests in FIFO order; an answer with no outstanding request is
dropped (there is no request id 0), and a session that ends with requests still
outstanding answers each of them with `session_closed` before its own close.
Session ids come from one allocator that is never reused: after 2³² − 1 ids it
refuses to open (`session_open_failed` / `rdp_open_failed`) instead of wrapping.

## 6. Process model (B1)

**Invariant: the main helper is single-threaded.** The engine is spawned with
`fork` + prebuilt, allocation-free child code + `execve`, which is sound only
because the helper has exactly one thread (see docs/architecture.md §2; a
`test-hooks` build asserts it at every fork, and `rdp_process.rs`
`g14_the_helper_stays_single_threaded_across_forks` checks it). All threads and
the tokio runtime live in the engine process, which never forks.

Each RDP session runs in its own engine process: the helper re-execs itself as
`remote-hub-helper --rdp-engine` (absolute path of the current executable, fixed
argv, **empty environment**, no shell) with one `socketpair` as fd 3. Everything
between `fork` and `exec` is precomputed (fd close list, argv, envp, signal
reset): the child allocates nothing. fds 0, 1 and 2 are `/dev/null` (the
helper's RPC stdin and its stderr never reach the engine). The main helper stays
single-threaded and poll-driven; the engine runs a tokio runtime plus one reader
thread. All parameters (including the password) travel as length-prefixed frames
over the socketpair — never argv, never env, never a file. The password exists
only in the connect RPC payload, the socketpair frame and engine memory; it
travels in a `Secret` wrapper whose `Debug` prints `<redacted>`. **It is not
zeroized** (the connector owns it as a plain `String`; core dumps and swap are
out of scope).

- One session-id allocator is shared by PTY and RDP sessions, so a wire
  `sessionId` names exactly one session.
- Reaping is by owned pid in both managers (`waitpid(pid)`, never `-1`);
  `engine_pid` is cleared the instant the child is reaped and a reaped pid is
  never signalled; blocking waits retry on EINTR. `session.closed` for an engine
  carries its exit code or signal, and is held until the engine is reaped (an
  engine that outlives its closed socket by 2 s is killed).
- The first terminal reason wins (a Closed event followed by EOF keeps its
  reason).
- When the helper dies hard the engine sees EOF on fd 3, ends its session and
  exits; every write error toward the helper is fatal for the engine.
- Engine death (crash, kill) closes only its session with `engine_exited`.
- **Closed-reason precedence** (helper, `RdpManager`): a `Closed{reason}` event
  the engine wrote and the helper read wins; otherwise `engine_exited` (the engine
  ended by itself: EOF, an exit seen by `reap()`, or found already exited by an
  explicit close); otherwise `killed_by_close` (the client's close had to kill a
  live engine). The helper never records `engine_exited` before it has read what
  is readable: a failed write only drops the unsent bytes, `reap()` leaves an open
  transport to the poll loop, and an explicit close drains the socket first. A
  reaped engine's transport that has not reported EOF `EOF_GRACE` (2 s) after the
  engine ended is ended by the next `reap()` after draining.

## 7. Screenshot (B7)

`rdp_screenshot {handle}` encodes the SAME RGBA8 framebuffer the views get with
the `png` crate (pinned 0.18) and returns `{frameId, width, height, timestamp,
png}`. Refused before `desktop_ready` (`not_ready`). The PNG travels as base64
inside one control frame, which must stay under the 4 MiB wire limit: a
screenshot whose base64 exceeds 3.5 MiB is refused with `screenshot_too_large`
(a 1920×1080 desktop with photographic content is ≈ 3 MiB; 3840×2160 with
detailed content exceeds the cap). Streaming a larger PNG as chunks needs a
client-protocol addition and is deferred to 2b-2. `encode_response` replaces any
response over the wire limit with `response_too_large`, so the client never
sees a frame it would have to treat as fatal.

## 8. Status (stage 2b-1, after the repair round)

Implemented in the helper (Rust): the `--rdp-engine` process (`engine.rs`,
`connect.rs`, `engine_io.rs`, `pump.rs`, `manager.rs`), the strict-TLS connect
path with the certificate decision and the post-handshake pin check, the
ack-paced framebuffer updates and PNG screenshot, input encoding, and the
closed-reason mapping. `test-hooks` builds additionally contain synthetic
engines (`REMOTE_HUB_RDP_FAKE_ENGINE=ack|flood`, `rdp/fake_engine.rs`) used by
`helper/tests/rdp_process.rs`; a release helper never reads that variable.

Verified against a real xrdp container (`tests/integration/rdp-Dockerfile` +
`rdp-docker.py`): case 1 (cert prompt, exact state trace, real endpoint),
case 2 (accept once → desktop, screenshot 800×600, > 16 distinct pixel values),
case 3 (typed `hello-rdp\n`), case 4 (pointer `x:200 y:150`, click logged by
xev), case 9 (session survives `session.close`), case 6 (mismatching
`expectedFingerprint` → `cert_changed`, trace `[connecting, tls]`), case 7
(`network_error` within 10 s, engine gone).

Not covered, with reasons:

- Case 5 (wrong password → `auth_failed`): xrdp with TLS-only security does not
  authenticate at the RDP protocol level — a wrong password reaches
  `desktop_ready` and fails in xrdp's own PAM login (state trace
  `connecting, tls, cert_prompt, authenticating`; xrdp-sesman log
  `pam_authenticate failed`). The mapping of CredSSP/`AccessDenied` failures to
  `auth_failed` is covered by literal unit tests; Windows NLA by
  `docs/rdp-windows-check.md`.
- Case 6b (a trusted certificate replaced → prompt with reason `cert_changed`)
  and case 8 (two views of one session): the trust store and the views live in
  the TS service, wired in 2b-2.
- Kerberos / KDC proxying is unsupported (`NoopNetworkClient`).
- Windows NLA/CredSSP is implemented through IronRDP but cannot be verified
  here; see `docs/rdp-windows-check.md`.

Still to do (later sub-stages): the TS service/RPC/socket wiring and fake-engine
tests (2b-2) and the canvas UI (2b-3). The TS side must accept the helper
messages added in the repair round: `rdp.certificate`, `rdp.input_rejected`,
`rdp.update_ack` (request), the cert-prompt `reason` code + `detail`, the
`server_disconnected` closed reason and the errors `not_ready`,
`fingerprint_mismatch`, `no_pending_prompt`, `rdp_input_overflow`,
`screenshot_busy`, `screenshot_too_large`, `rdp_invalid_geometry`, `response_too_large`,
`session_closed`.
