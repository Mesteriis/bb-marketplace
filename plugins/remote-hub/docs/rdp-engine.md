# Remote Hub — RDP engine (stage 2b, B0 design record)

This is the "before code" record required by B0. It pins the exact IronRDP
crates, names the API called for each step, quotes the TLS defaults of the
pinned source with `file:line`, and records licences. **The engine code that
consumes these crates is not yet implemented**; `helper/Cargo.toml` is unchanged
and no IronRDP dependency has been added. Pinning (`=x.y.z` in Cargo.toml,
`Cargo.lock`, `THIRD_PARTY_NOTICES.md`) lands together with the engine so the
tree never carries unused native deps.

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
| tokio | =1.x | async runtime for the engine process | MIT |
| x509-cert | =0.3 | parse the server cert for fingerprint/fields | Apache-2.0 OR MIT |
| sha2 | =0.11 | SHA-256 fingerprint | MIT OR Apache-2.0 |
| png | =0.18 | screenshot encoder | MIT OR Apache-2.0 |

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

The sequence is driven with `ironrdp-tokio` + `ironrdp-connector`
(mirrors `ironrdp-client-0.1.0/src/rdp.rs`):

1. `connecting`: `TcpStream::connect((host, port))`, then
   `ironrdp_tokio::TokioFramed::new(stream)`.
2. `ironrdp_tokio::connect_begin(&mut framed, &mut connector)` — X.224
   negotiation up to the point where the transport must upgrade to TLS.
3. `tls`: `ironrdp_tls::upgrade_with_certificate_validation_callback_for_endpoint(
   stream, server_name, endpoint, callback)` — strict chain+hostname validation
   with a callback that reports a failed cert (B3). `cert_prompt` is emitted
   from inside this callback; it may wait up to 60 s for
   `rdp_cert_decision`, then `cert_rejected`.
4. `ironrdp_tls::extract_tls_server_public_key(&tls_cert)` — the server public
   key CredSSP needs.
5. `authenticating`: `ironrdp_tokio::connect_finalize(upgraded, connector,
   &mut framed, &mut ReqwestNetworkClient::new(), destination, server_public_key,
   kerberos_config)` — security + licensing + capabilities + CredSSP/NLA when
   negotiated, then connection activation.
6. `desktop_ready`: after `connect_finalize` returns `ConnectionResult`, build
   the active stage and apply the first non-empty graphics update (§4).

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

TLS transport is `tokio-rustls 0.26` → `rustls 0.23`, crypto provider
`aws_lc_rs` or `ring` (feature choice). One thing to fix before release:
`src/rustls_verifier.rs:28` sets `config.key_log = Arc::new(KeyLogFile::new())`
(SSLKEYLOGFILE) unconditionally; the engine must build its own `ClientConfig`
without that line, or the build must not honour SSLKEYLOGFILE.

So B3 is satisfiable with the pinned crate as written: use
`upgrade_with_certificate_validation_callback_for_endpoint` (Strict + callback),
compute the SHA-256 fingerprint of the presented leaf, and gate the callback's
`true` on the `rdp_cert_decision` naming that same fingerprint. There is no
global skip switch to add — the dangerous variant exists but is simply never
called.

## 4. Active stage, framebuffer and updates (B5)

- `DecodedImage::new(PixelFormat::RgbA32, width, height)` allocates the RGBA8
  framebuffer (ironrdp-session 0.13.0 `image::DecodedImage`).
- `ActiveStageBuilder { static_channels, user_channel_id, io_channel_id,
  message_channel_id, share_id, compression_type, enable_server_pointer,
  pointer_software_rendering }.build()` → active stage.
- Read loop: `reader.read_pdu()` → `active_stage.process(&mut image, action,
  &payload)` → `Vec<ActiveStageOutput>`.
- `ActiveStageOutput::GraphicsUpdate(_region)` means the framebuffer changed;
  the engine copies the dirty region out of `image` (RGBA8 rows) and publishes
  it as a view update. `ActiveStageOutput::Terminate(reason)` ends the session.
- First video path: plain bitmap updates (`ironrdp-graphics`), no RemoteFX,
  no native deps. `desktop_ready` fires only after the first non-empty
  `GraphicsUpdate` has been applied (B2).

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

Mouse moves are coalesced to the latest position while the engine is busy
(B6); input arrives as validated control messages over the socketpair (§6).

## 6. Process model (B1)

Each RDP session runs in its own engine process: the helper re-execs itself as
`remote-hub-helper --rdp-engine`, absolute path of the current executable,
allowlisted env, no shell, one `socketpair` fd passed through the existing fd
allowlist. The main helper stays single-threaded and poll-driven; the engine
process runs a tokio runtime. All parameters (including the password) travel as
length-prefixed frames over the socketpair — never argv, never env, never a
file. The password exists only in the connect RPC payload, the socketpair frame
and engine memory (B4). Engine death closes only its session with
`engine_exited`. This design is chosen over in-process threads because the
engine needs a tokio runtime, a TLS/certificate callback that may block on the
cert prompt, and independent crash/teardown — isolation the single-threaded
poll loop must not give up.

## 7. Screenshot (B7)

`rdp_screenshot {handle}` encodes the SAME RGBA8 framebuffer the views get with
the `png` crate (pinned 0.18) and returns `{frameId, width, height, timestamp,
png}`. Refused before `desktop_ready`.

## 8. Status (stage 2b-1)

Implemented in the helper (Rust): the `--rdp-engine` process (B1,
`helper/src/rdp/engine.rs`, `manager.rs`), the strict-TLS connect path with the
certificate callback (B2/B3), the framebuffer + chunked updates + screenshot
(B5/B7), and input encoding (B6). The RDP reaper reaps only its own engine
pids (`waitpid(pid, WNOHANG)`), never `waitpid(-1)`, so it cannot steal PTY
children from the SessionManager reaper.

Verified against a real xrdp container (Docker, `tests/integration/rdp-Dockerfile`
+ `rdp-docker.py`): strict validation → `cert_prompt` with the correct SHA-256
fingerprint; accept once → `desktop_ready` + PNG screenshot; a different
`expectedFingerprint` → `cert_changed`; killing the container during
`desktop_ready` → `network_error`. Keyboard/mouse/session-persistence cases are
skipped there: the xrdp sesman X session does not start (xorgxrdp back-connection
fails with "bad header length 0" / "X.224 CR-TPDU failed"), which is a test
harness issue, not an engine issue.

Still to do (later sub-stages): the TS service/RPC/socket wiring and fake-engine
tests (2b-2) and the canvas UI (2b-3). Windows NLA/CredSSP is implemented
through IronRDP but not verifiable here; see `docs/rdp-windows-check.md`.
