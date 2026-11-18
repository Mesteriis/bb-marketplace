# Proxmox VE consoles — research (stage 0)

Status of every statement: **[src]** read in the upstream source named next to it, **[live]** to verify on a real PVE
(nobody on this stage has one; the coordinator's live run decides), **[fix]** exercised by our fake PVE server only, which proves our
client against our reading of the source, not PVE itself.

Sources read (GitHub `proxmox/*`, branch `master`, downloaded 2026-11-18):
`pve-manager` `PVE/API2/Nodes.pm`, `debian/changelog` (top entry 9.2.32); `pve-container` `src/PVE/API2/LXC.pm`;
`qemu-server` `src/PVE/API2/Qemu.pm`; `pve-xtermjs` `termproxy/src/main.rs`, `cli.rs`;
`pve-access-control` `src/PVE/API2/{AccessControl,Role,ACL,User}.pm`, `src/PVE/AccessControl.pm`;
`pve-http-server` `src/PVE/APIServer/AnyEvent.pm`; noVNC `v1.6.0` `core/rfb.js`, `core/websock.js`.
**8.x is not read from source here** (only `master`, i.e. 9.x); where 8.x may differ it is marked [live].

## 1. Console matrix

All REST paths are under `https://<host>:8006/api2/json`. Every create call is `POST` with form-encoded body.

| Console | Create call | Params | Returns | Privilege | API token | Websocket |
|---|---|---|---|---|---|---|
| Node shell | `POST /nodes/{node}/termproxy` | `cmd`, `cmd-opts` (default `login`; anything but `login` needs `root@pam`) | `user`, `ticket`, `port`, `upid` | `Sys.Console` on `/nodes/{node}` [src Nodes.pm:1401] | **9.0.13+**: `termproxy` and `vncwebsocket` accept a token, but the shell still needs a local PAM login [src changelog 9.0.13]. Older: ticket only [live] | `GET /nodes/{node}/vncwebsocket?port=P&vncticket=T` |
| LXC terminal | `POST /nodes/{node}/lxc/{vmid}/termproxy` | none | `user`, `ticket`, `port`, `upid` | `VM.Console` on `/vms/{vmid}` [src LXC.pm:1175] | token support for the guest `termproxy` is **not in the changelog line** (it names the node shell) → treat as ticket-only until [live] | `GET /nodes/{node}/lxc/{vmid}/vncwebsocket?port&vncticket` |
| QEMU graphics | `POST /nodes/{node}/qemu/{vmid}/vncproxy` | `websocket=1` | `user`, `ticket`, `password`, `cert`, `port`, `upid` | `VM.Console` on `/vms/{vmid}` [src Qemu.pm:3091] | as above: ticket-only until [live] | `GET /nodes/{node}/qemu/{vmid}/vncwebsocket?port&vncticket` |
| QEMU serial | `POST /nodes/{node}/qemu/{vmid}/termproxy` (`serial=serialN`) | `serial` | as termproxy | `VM.Console` | as above | same socket, **terminal framing** (§1.2) |

Notes from source:

- **The port is returned, never fixed.** The websocket `port` parameter has `minimum 5900, maximum 5999` [src Nodes.pm:1493]; we pass
  what the create call returned and never assume a number.
- **`vncticket` is not the VNC password.** For QEMU `vncproxy` with `websocket=1` PVE generates a separate `password`; the value stored for the
  proxy is `"<password>:<ticket>"` [src Qemu.pm:3156-3160], but the `ticket` field of the answer is the plain ticket (the engine's fake and tests use it
  this way; confirm on the live run). The RFB handshake uses `password`; the websocket query uses `ticket`. Never assume the two are equal.
- **Authentication of the websocket request itself**: the HTTPS `GET …/vncwebsocket` is an ordinary API request, so it needs the
  same authentication as REST (the `PVEAuthCookie` cookie from a ticket login, or on 9.0.13+ the `Authorization: PVEAPIToken=…` header), and the
  `vncticket` query parameter is checked on top of it (`verify_vnc_ticket(vncticket, user, authpath, port)`) [src Nodes.pm:1530]. The ticket is bound
  to user, path (`/nodes/{n}` or `/vms/{id}`) and port.
- **Nodes other than the one we talk to**: the call is proxied by pveproxy to the target `{node}`; the create call must name the node that currently holds the guest.
  A guest that moved requires re-resolving the node before opening (stage 1 does this from `cluster/resources`).
- PVE returns HTTP 401 for authentication, 403 for privilege (`Permission check failed`), 500 with a message for other failures (for example
  `no such VM`/`Configuration file does not exist`). Unauthorised answers are delayed by 3 s server-side [src AnyEvent.pm:1066].

### 1.1 Terminal websocket protocol (node shell, LXC, serial) [src pve-xtermjs main.rs]

After the HTTP upgrade the stream carries (all inside websocket binary/text messages; the PVE web proxy relays them to `termproxy`):

1. **Client → server, first message**: `"<user>:<ticket>\n"` where `user` is the `user` field returned by the create call and `ticket` the
   returned `ticket` (read_ticket_line splits at the first `:`). It must arrive within 10 s.
2. **Server → client**: `OK` (two bytes) once `termproxy` authenticated the pair via `POST /access/vncticket`; then raw terminal bytes (UTF-8) from the PTY.
3. **Client → server data**: `0:<len>:<bytes>` (`len` is the decimal byte count of `<bytes>`). The parser reads one type digit, the colon, then the number up to the next colon.
4. **Resize**: `1:<cols>:<rows>:`.
5. **Keep-alive**: `2` (type 2, ping; ignored by `termproxy`; the web client sends it about every 30 s [live: interval]). Any unknown type byte is skipped.
6. Initial size is 80x20; the client sends a resize right after `OK`.

Do not assume the stream is raw bytes in either direction: without the ticket line and the `0:` framing nothing reaches the shell.
The idle timeout of `termproxy` itself is not in the code read (the 10 s limits cover accept and ticket only) [live].
Node shell as a non-root user starts `/bin/login`: the owner types the Linux user and password into the terminal (a PVE property, shown as is) [src Nodes.pm:1184-1220].
Node `termproxy` cannot be used as `root@pam` token because the shell needs PAM, per the changelog line above.

### 1.2 QEMU graphics (RFB over websocket)

The websocket carries plain RFB: noVNC speaks it directly (no ticket line, no framing). After the websocket handshake the VNC
handshake runs on `password` (VNC authentication, DES challenge) [src Qemu.pm:3156; noVNC rfb.js]. The `cert` field is the cluster root CA PEM (informational).
Serial (`vga: serialN`) uses `vncterm`/`qm terminal` and the terminal framing of §1.1 over the same websocket; we add it only for VMs that already have it and do not change any VM
configuration.

### 1.3 What must NOT be assumed

- a fixed VNC port; a VNC password equal to the ticket; that token auth works for every console; that create success means a working console
  (verify to first output / first frame); that the node we queried is the node holding the guest.

## 2. Ticket login (`@pve` user)

- `POST /access/ticket` with `username=<user@realm>` and `password=<password>` [src AccessControl.pm:109-176]. Answer `data`:
  `ticket`, `CSRFPreventionToken`, `username`, `cap`, and `clustername`.
- Use: send `Cookie: PVEAuthCookie=<ticket>` on every request, plus header `CSRFPreventionToken: <token>` on every non-GET request (POST/PUT/DELETE).
- Lifetime: **2 hours** (`$ticket_lifetime = 3600 * 2`) [src AccessControl.pm:59]; renewing = `POST /access/ticket` again with the **old ticket as `password`**
  for the same `username` (the server accepts a still-valid ticket as password). The auth key rotates every 24 hours [src :61], so a ticket can become invalid earlier.
- TOTP/second factor: when the realm requires it the response carries `NeedTFA: 1` and a ticket of the form `!tfa!…`; the client then completes it with
  `POST /access/tfa` (field `tfa-challenge` and the code in `password`; `otp` is the older field and must not be combined with `tfa-challenge` [src :138]).
  Stage 0/1 reports `tfa_required` and stops; the `remotehub@pve` user we create has no second factor, so the flow is not needed for mode 1. [live: the exact `/access/tfa` body]
- The 401 for a wrong password is delayed server-side by 3 s; we never retry a login after a 401.

## 3. Onboarding mode 1: a restricted user

Admin needs `Sys.Modify` on `/access` (create role), `User.Modify` (create user) and `Permissions.Modify` on the ACL path (ACL calls live at `/access/acl`) (`root@pam` has all). [src Role.pm:80; ACL.pm]

| Step | Call | Idempotence |
|---|---|---|
| 1 role | `POST /access/roles` `roleid=RemoteHubConsole`, `privs=VM.Audit,VM.Console,Sys.Audit,Sys.Console` | `GET /access/roles/RemoteHubConsole` first; exists with these privs → skip; exists with other privs → `PUT /access/roles/RemoteHubConsole privs=… append=0` after the owner confirmed the diff |
| 2 user | `POST /access/users` `userid=remotehub@pve`, `password=<generated>`, `comment=Managed by BB Remote Hub` (the marker that proves ownership) | `GET /access/users/<user>` first; exists without the marker → `name_taken`, nothing written; exists with the marker → rotate with `PUT /access/password` (`userid`, `password`; 8..64 characters; admin needs `Realm.AllocateUser` and `User.Modify` on a group of the user) [src AccessControl.pm:403-440]; the keychain keeps only the newest |
| 3 ACL | `PUT /access/acl` `path=/` (or `/pool/<id>`), `roles=RemoteHubConsole`, `users=remotehub@pve`, `propagate=1` | The ACL update is idempotent by itself |

Privilege names exist in `PVE::AccessControl` for master: `VM.Console` (:1154), `VM.Audit` (:1162), `Sys.Console` (:1173), `Sys.Audit` (:1177) [src]; 8.x [live].
`root@pam`'s password and a role id beginning with `PVE` are never used: role ids starting with `PVE` are refused [src Role.pm:100].
The generated password is 32 random characters from a URL-safe alphabet, from the OS random source, held in a `Secret` and stored in the Keychain only.
Removal by the owner: `pveum user delete remotehub@pve`, then `pveum role delete RemoteHubConsole` (the ACL entry disappears with the user); the profile in Remote Hub is deleted separately.
Both are shown in the editor after creation.
A user without the marker is never touched (`name_taken`; the owner picks another `name@pve`). A role with other privileges is `role_differs` and is replaced only after a separate confirmation. Plan and apply are bound by a single-use digest of the observed state (`plan_changed` if the server moved); the new password is saved to the Keychain before the ACL write; per-step outcomes are reported. See `docs/security.md`.

## 4. Dependencies for the PVE engine process

Candidates, versions checked on crates.io on 2026-11-18:

| Piece | Pick | Why | Licence |
|---|---|---|---|
| WebSocket | `tokio-tungstenite` 0.30.0 over `tungstenite` 0.30.0 | the established client; handshake, masking, ping/pong, close, fragmentation done; no hand-rolled protocol | MIT / MIT OR Apache-2.0 |
| HTTP/1.1 client for REST | `hyper` 1.x `client::conn::http1` + `hyper-util` `TokioIo` + `http-body-util` | small, no connection pool/redirect machinery; we want one request per connection with our own TLS verifier | MIT |
| TLS | `tokio-rustls` 0.26.6 + `rustls` 0.23.46 (already in the tree, `ring`) | existing; custom `ServerCertVerifier` for fingerprint pinning | MIT/Apache-2.0 |

Rejected: `reqwest` (pulls a large tree for features we do not need and makes custom verification awkward), a hand-written HTTP or websocket client.
Final versions are the ones in `helper/Cargo.toml` and recorded in `THIRD_PARTY_NOTICES.md`.

## 5. Feeding noVNC from our stream socket (stage 2, verified in noVNC v1.6.0)

`new RFB(target, urlOrChannel, options)`: a non-string second argument is `_rawChannel`, attached through `WebSock.attach(rawChannel)` [src rfb.js:109-113,562].
`websock.js` requires the object to behave as a websocket: settable `binaryType`, `onmessage`, `onopen`, `onclose`, `onerror`, a `readyState`
(`"connecting" | "open" | "closing" | "closed"`), `send(Uint8Array)` and `close()` [src websock.js:42-47,254-301].
The UI wraps our stream socket in such an object; the helper relays raw RFB bytes both ways. The RFB password is delivered to the UI's session only (`credentials` event), never in a URL.

## 6. Open questions for the live run (stage 1 coordinator)

1. Does a token reach `…/lxc/{vmid}/termproxy` and `…/qemu/{vmid}/vncproxy` on the installed version? (We implement ticket login first; token is accepted for REST discovery.)
2. Ticket renewal: does `POST /access/ticket` with the old ticket as `password` work on this version? (we re-login with the stored password instead; no behaviour depends on it.)
3. Ping interval and idle timeout on the shell socket.
4. 8.x differences in the privilege list and in the token rule.

## 7. Implementation (stages 0 and 1)

Where things live:

| Piece | Path |
|---|---|
| Engine process (`--pve-engine`, fd 3, tokio current-thread) | `helper/src/pve/engine.rs` |
| REST client (hyper http1, one connection per request, strict TLS) and the websocket connect | `helper/src/pve/api.rs` |
| TLS trust: system roots, one supplied CA, or one pinned leaf; the presented fingerprint is recorded | `helper/src/pve/tls.rs` |
| Terminal framing (`user:ticket\n`, `OK`, `0:len:`, `1:cols:rows:`, `2`) | `helper/src/pve/term.rs` |
| Engine IPC types (`PveCommand`, `PveEvent`, frames) | `helper/src/pve/protocol.rs` |
| Helper-side manager (spawn, reap, kill after 3 s grace) | `helper/src/pve/manager.rs` |
| Wire requests to engine `Open`; engine frames to wire responses | `helper/src/pve/glue.rs` |
| Fake PVE server for tests | `helper/tests/common/pve_fake.rs` |

Wire (protocol 3): `session.open_pve`, `pve.targets` (requests); `session.opened` with `kind: "pve"`, `pve.state`, `pve.error`,
`pve.targets_result`, `pve.failed`, console bytes as ordinary stream frames and `session.closed` (answers). The secret is either
`password` (use once) or `credentialRef` (the helper resolves it from the Keychain and checks that it was saved for exactly this
`pve` host, port and user or token id: `Bind::is_pve_endpoint`); it travels only in the one `Open` frame on the socketpair to the engine, never in
argv or environment (the engine's environment is empty).

Behaviour decided here:

- **No retry after a refusal.** A 401 on login, an expired ticket or a refused ticket line each produce one `login_failed`; the
  fake PVE counts logins and tests assert exactly one.
- **No secret before trust.** A login is sent only after the TLS handshake passed; with system trust or a CA the fixture
  certificate is refused (`tls_untrusted`, with the fingerprint to confirm); with a pin a different certificate is `cert_changed`.
  There is no insecure mode in the Rust type or in the TS schema.
- **Discovery distinguishes empty from forbidden.** An empty guest list is checked against `GET /access/permissions`: no
  `VM.Audit`/`VM.Console` anywhere is `no_permission`, otherwise the list is simply empty.
- **API token**: discovery works with it; guest consoles are treated as ticket-only (the fake PVE answers 401 to a token on
  `termproxy`, as stated in §1 pending the live run).
- **Close**: `session.close` asks the engine to close the websocket and answers when the engine ended; an engine that does not end in
  3 s is killed. Helper exit kills every engine. A helper that dies makes the engine see EOF and end.
- **Flow control**: console bytes are bounded by the helper's outbox room (the engine socket backs up and, through TCP, the console);
  `session.credit` for a PVE console is acknowledged and unused. Keep-alive ping every 30 s (1..=120 configurable per open).
- Waits are bounded: TCP/TLS connect 10 s, request 20 s, websocket handshake 10 s, `OK` 12 s.

### Stage 1: profile, discovery, onboarding

- **Profile**: protocol `pve` in `src/core/profile.ts` (host and port are the API endpoint, default 8006; `username` is `name@realm`
  or, for `authType: "token"`, `name@realm!token`; `pveTrust` is `system` | `ca` | `pin`, null meaning the system roots). Migration
  `PROFILE_PVE_MIGRATIONS` appends the `pve_trust` column at the end of the ordered list; guest links live in `pve_guest_links`. The saved
  secret is an ordinary credential bound to `{protocol: "pve", host, port, user}`. Export of profiles carries no secret (there is none in a profile).
- **Discovery** (`src/core/pve-targets.ts`, RPC `pve_targets`): one view per connection with `outcome` ∈ ok, empty, no_permission, login_failed,
  unreachable, tls_untrusted, cert_changed, tfa_required, no_credential, error. One failing connection never hides the others (each is asked on its own
  and a throw becomes `error` for that connection). The last good list is served stale (with `ageSeconds`) only after `unreachable` or `error`,
  never after a login, permission or certificate refusal. A guest's identity is `<profile id>/<vmid>`; the node is a location and is re-read on
  every refresh (the engine's `cluster/resources` answer), so a moved guest shows its new node and equal VMIDs of two connections never meet.
  Cached lists live in memory (a restart drops them).
- **Onboarding** (RPCs `pve_onboard_plan`, `pve_onboard_apply`, `pve_onboard_connect`): see §3 and `docs/security.md`.
- **Console availability** per guest is computed from its state (a stopped guest or a template has none, with the reason); the buttons are disabled in this
  build because console sessions are stage 2. There are no power controls anywhere.
- **Agent tool** `remote_pve_targets` (observe level) in `src/core/agent-pve-tools.ts`.
- **Link to SSH/RDP**: the owner picks a saved SSH or RDP profile per guest (`pve_guest_link_set`); nothing is guessed from an address or the guest agent.

Tests: `helper/tests/pve_engine.rs` (28, engine in-process against the fake PVE), `helper/tests/pve_process.rs` (10, through the real helper binary,
including a temporary keychain), unit tests beside each module, `src/core/pve-protocol.test.ts`. None of this touches a real PVE.
