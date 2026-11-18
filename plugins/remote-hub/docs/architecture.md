# Remote Hub — architecture (stage 2a)

Layer split follows the repository root rules: `src/core` and `src/ui` are
host-free, `src/adapters/bb` owns host code, and `server.ts` / `app.tsx`
compose the adapters. Every SDK API below was checked against the installed
declarations in `node_modules/@get-bb/plugin-sdk/bundled-types/`.

## 1. How UI, RPC, agent tools and CLI are registered

- UI: `definePluginApp` (bb-plugin-sdk-app.d.ts:24069) and
  `app.slots.navPanel` (bb-plugin-sdk-app.d.ts:22590;
  `PluginNavPanelRegistration` at :20038). Verified in declarations.
- RPC: `defineRpcContract` (bb-plugin-sdk.d.ts:151) wraps the zod schemas from
  `src/core/rpc.ts`; `bb.rpc.register` (bb-plugin-sdk.d.ts:20511) binds the
  handlers. Verified in declarations and used by plugins/mail.
- Agent tools: `bb.agents.registerTool` (bb-plugin-sdk.d.ts:21240). Verified
  in declarations; not registered in this stage (no tools yet).
- CLI: `bb.cli.register` (bb-plugin-sdk.d.ts:20661) with
  `defineCli` (:27473) and `cliCommand` (:27450). Verified in declarations;
  not registered in this stage.

## 2. Where the Rust process runs and who owns sessions

- The Rust helper is spawned from `server.ts`, which runs in the BB server
  (a Node process): the `BbPluginApi` contract is "the `bb` object handed to
  a plugin's `server.ts` factory" (bb-plugin-sdk.d.ts:19734).
- The SDK host process API is `experimental_spawnHostProcess` /
  `experimental_execHostFile` from `@get-bb/plugin-sdk/process`
  (bb-plugin-sdk-process.d.ts:46-54); it returns Node's `ChildProcess`. The
  adapter uses it to launch the helper by absolute path. Verified in
  declarations and used by plugins/firstmate-crew.
- Sessions are owned by the helper's `SessionManager`
  (helper/src/sessions.rs), independent of the React mount: the UI can detach
  without ending a session.
- **The helper process is single-threaded, by design and as an invariant.** It
  forks PTY children (`sessions.rs`) and RDP engine children (`rdp/manager.rs`)
  and does a handful of async-signal-safe calls between `fork` and `execve`
  (fd close list, argv and envp prebuilt before the fork). That is only sound
  while no other thread exists: a forked child inherits locks and libc
  once-state from any thread that was mid-operation (macOS kills such a child
  inside `fork()` with "os_once_t is corrupt ... crashed on child side of fork
  pre-exec"). Do not add a thread, a thread-spawning dependency or an async
  runtime to the helper loop; put such work in a separate process (the RDP
  engine is exactly that: it runs tokio, and never forks). `helper/src/threads.rs`
  enforces it: in a `test-hooks` build every fork site asserts a thread count of
  one, and `helper/tests/rdp_process.rs` (`g14_…`) checks the helper has one
  thread at idle, with PTY and RDP sessions, and after they close. The same
  rule applies to tests: code that forks inside a multi-threaded test binary
  must exec (`std::process::Command`), never `fork()` and continue.

## 3. How commands, terminal data and RDP frames travel

- Control operations: length-prefixed JSON frames over stdio, versioned by a
  `hello` handshake (`PROTOCOL_VERSION = 1`); `src/core/protocol.ts` and
  `helper/src/protocol.rs` mirror each other.
- Terminal bytes: binary stream frames (`FRAME_KIND_STREAM`) with session id
  and sequence number. The SDK offers a binary-capable WebSocket —
  `bb.http.experimental_websocket` (bb-plugin-sdk.d.ts:20484) whose
  `ExperimentalPluginWebSocket.send` accepts `string | Uint8Array`
  (:20446-20448). Verified in declarations; wired in stage 2a through the
  /attach WebSocket route.
- The BB terminal API: `bb.sdk.terminals` (`PluginBbSdk.terminals`,
  bb-plugin-sdk.d.ts:19377) is a `TerminalsArea` (:18802) with
  `create/input/resize/output/list/close/rename/restart`.
  `TerminalsArea.create` (`TerminalCreateArgs` :18759) accepts
  `start?: { mode: "argv", argv: string[] }` (createTerminalRequestSchema
  :11458), input is `dataBase64` (:18779; terminalInputRequestSchema :11489)
  and output arrives as base64 `chunks` with `seq` (:18786;
  terminalOutputResponseSchema :11504). Verdict: BB owns the PTY (it launches a
  command via argv itself) and offers no way to attach an existing PTY master,
  so Remote Hub cannot hand its own `openpty` master to it; the chosen path is
  the plugin's own PTY transport rendered with xterm.js, not the BB terminal.
- Flow control and limits: per-session pending input is 262 144 UTF-8 bytes, enforced identically in TS and Rust;
  a single `session.input` above it is refused with
  `input_overflow`; per-session pending output is 256 KiB; the shared
  stdout outbox is 4 MiB (with a 512 KiB reserve so one control response always
  fits); the maximum control/stream frame body is 4 MiB; the stdin ingress
  buffer is 4 MiB + 4 (one whole maximum frame). The loop requests POLLIN on a
  PTY only while its pending output has room, reads stdin only while the outbox
  has room, polls stdout POLLOUT while the outbox is non-empty, and treats an
  EPIPE or any non-transient stdout error as fatal shutdown. `session.close`
  drains up to 512 KiB plus one 64 KiB read (the 256 KiB pending-output bound
  plus a final read), and drops the rest. The remaining limit is the single shared stdout
  pipe. Output is streamed per session over the plugin's own binary WebSocket;
  per-session credit flow control keeps one stalled consumer from stalling
  another.
- openpty retry: `openpty` is retried a bounded 8 times on transient
  errnos (EAGAIN/EINTR/ENXIO, positive or negative); the observed failure is a
  transient errno -6 (-ENXIO) from plain `openpty` on macOS under parallel
  load, cause not established.

## Stage 2a — one real SSH session

- Terminal path decision: Remote Hub uses its own PTY (helper `openpty`) plus
  xterm.js in the plugin tab. The BB terminal API is NOT used because it
  launches its own process by argv and offers no way to attach a foreign PTY
  master, which would make BB, not SessionManager, the owner of the session
  (bb-plugin-sdk.d.ts:18759, :18802, :19377). SessionManager in the helper owns
  every session regardless of React mount; detaching a view never ends it.
- Per-session flow control (credit): each session has a byte window granted by
  the client (`session.credit {sessionId, bytes}`); the helper never has more
  than the granted window of un-acked output in flight and stops reading that
  PTY when the window is exhausted. Echo sessions start with an unlimited
  window; SSH sessions start at zero. ONE bounded window per session, owned by
  src/core/credit.ts. granted is total credit ever granted; consumed is total
  live bytes received from the helper; each attached view tracks sentLive and
  acked (acked <= sentLive). The oldest attached view is the owner, and only
  the owner's ack produces a grant, clamped to sentLive - acked. Snapshot bytes
  are never live and never acked. The property actually guaranteed and tested
  is that the helper's unconsumed credit stays in [0, 262144]:
  0 <= granted - consumed <= 262144, and when the owner has acked everything,
  granted - consumed == 262144. The stronger sum
  granted - consumed + (owner.sentLive - owner.acked) <= 262144 does NOT hold at
  the moment a lagging non-owner is promoted. When the owner
  detaches, the oldest remaining view is promoted and
  granted the remaining window. When NO view is attached (first attach or a
  reattach after every view left), the new view becomes owner and the helper's
  unconsumed credit is topped back up to one window:
  grant = max(0, 262144 - (granted - consumed)). A renderer that never acks
  stalls its session after 262144 bytes: that is intended backpressure. An
  owner that never acks stalls the session even if another attached view acks;
  a slow non-owner view is bounded at 1 048 576 unacked live bytes
  (src/core/credit.ts SLOW_VIEW_BYTES): when a non-owner's sentLive - acked
  exceeds that bound the service detaches that view and closes its socket with
  code 4409 ("view too slow"); it may reattach and gets a fresh snapshot. The
  owner is never detached for slowness, and detaching a non-owner grants no
  credit, so the owner and the helper's credit window are unaffected.
- **Start gate for pty children (stage 2b-1 repair 5, K5).** On macOS the last close
  of a pty slave discards the output nobody has read yet (a session leader's exit
  waits a short while for it to be read, then discards it; the helper's own copy of
  the slave counts as a holder). The helper drops its copy of the slave right after
  forking; if it was descheduled in between, a short-lived child could write and
  exit first and the helper's later drop became the last close: the output was
  lost (a `v1_env_values_reach_execve_intact` failure, about 1 in 100-250 runs of
  the 3-parallel echo loop under load; with a 300 ms delay it failed 30 of 30).
  The child now blocks on a close-on-exec pipe before `setsid`/`exec`, and the
  parent closes the write end only after dropping the slave. If the parent dies
  the kernel closes the write end and the child proceeds (it then loses its
  terminal to the closed master, as before); both ends are closed on every error
  path and neither survives `exec`. The window is inside `open_session`.
- Reap grace constants (helper/src/sessions.rs): LINGER_GRACE is how long the
  helper waits for a descendant to release the PTY after the direct child exits
  (2 s) before reaping the process group. REAP_GRACE is how long an EOF/HUP with
  no reaped child is allowed before that child is treated as an orphan and
  SIGTERMed (1 s). Both are user-visible: a session whose child stays alive
  after closing its tty shows "running" with no possible output for up to
  REAP_GRACE, then is reaped and reports its real status. LINGER_GRACE delays
  the SessionClosed notification by up to 2 s when the PTY is never drained,
  for example an unattended session with zero credit whose descendant holds
  the PTY open.
- stdin hang-up guards: the read_now '|| hung_up' and 'hung_up && is_full ->
  mark_eof' branches in helper/src/ipc.rs are defensive and not covered by a
  test on darwin (poll does not report POLLHUP while stdin events are 0).
- Attach/detach semantics: one WebSocket per attached view, bound to a single
  session handle by a single-use attach token; closing the socket detaches the
  view but the session keeps running in the helper. service.attachStream takes
  the scrollback snapshot and subscribes synchronously (no await between), so a
  re-attach sends the snapshot first, then the buffered tail, then live bytes
  with no duplication or reordering.
- SSH config trust: without an explicit configFile the user's real ~/.ssh/config
  applies, including any StrictHostKeyChecking there. configFile, identityFile
  and knownHostsFile are provided by the RPC caller and passed as separate argv
  entries. configFile and identityFile may contain spaces (only control
  characters are rejected); knownHostsFile may not contain whitespace or be
  /dev/null, because ssh splits UserKnownHostsFile on whitespace and /dev/null
  would accept any host. The Rust validator is a policy mirror of the TS builder,
  not a sandbox: a caller who can choose -F <file> can make ssh run a
  ProxyCommand from that file.
- Binary WebSocket facts (bb-plugin-sdk.d.ts:20446-20484):
  `bb.http.experimental_websocket(path, handler, { auth })` registers a route in
  the `/http/` namespace; a GET upgrades only with `Upgrade: websocket`.
  `ExperimentalPluginWebSocket.send(data: string | Uint8Array)` is binary-capable
  and `onMessage` receives `string | Uint8Array`. `PluginHttpAuthMode` is
  `"local" | "none" | "token"`. The default auth mode is "local": Origin/Host
  must be a local BB app origin (bb-plugin-sdk.d.ts:20470), and
  experimental_websocket (bb-plugin-sdk.d.ts:20482) says its auth modes are
  identical to HTTP routes. Remote Hub relies on that default and adds its
  own single-use attach token plus per-session binding on top. Auth and origin
  checks are not exercised in a live BB server in this stage.
- RDP image frames: stage 2b-2, see the section "Stage 2b-2 — the RDP service layer" below.

## Stage 2b-2 — the RDP service layer

The helper's RDP engine (docs/rdp-engine.md) is reached from the page through
three RPCs and the same attach socket as SSH. The UI (stage 2b-3) is the
`RdpPage` / `RdpCanvas` / `RdpCertDialog` trio under `src/ui/`; the SSH | RDP
switch on the connect page picks between the two.

- **RPC** (`src/core/rpc.ts`): `rdp_open {target {host, port, username,
  password, domain?, expectedFingerprint?}, width, height}`, `rdp_cert_decision
  {handle, fingerprint, accept: once | session_trust | reject}`,
  `rdp_screenshot {handle}` (base64 PNG, chunked answers reassembled by
  `HelperProcess`). `session_list` entries gain kind `rdp` and an `rdp` record
  `{target, state, prompt, desktop, trace}`; the record never holds the password
  (it exists only in the RPC payload, the helper request frame and engine memory).
  Helper refusals keep their code in the RPC error text (`not_ready: …`).
- **Certificate trust** (`src/core/rdp-trust.ts`, in service memory only): the
  helper prompts for every certificate strict validation rejects. A fingerprint
  the user trusted for this BB run (`session_trust`) is answered `once`
  automatically; a DIFFERENT certificate on a host:port that has a trusted one is
  shown with reason `cert_changed` and is never auto-accepted; a decision must
  name the presented fingerprint (`fingerprint_mismatch` otherwise, nothing
  reaches the helper).
- **Updates and views** (`src/core/rdp-views.ts`): the helper has ONE consumer,
  the service, and sends one update at a time (all chunks share a `frameId`;
  `seq` is the band index inside that update and restarts at 0 for every update,
  so it is validated per frame, never as a global sequence). RDP has no byte
  credit; `credit.ts` stays SSH-only. The service multiplexes views without a
  per-view queue and without a TS framebuffer: a view with nothing in flight gets
  the whole update and is then "in flight"; a busy view is skipped and marked
  `needsFull`; a `needsFull` view only accepts an update that starts with a
  full-width band at (0, 0), and the service asks the helper for `rdp.refresh`
  (a full frame under a new frame id). The helper is acked on the FIRST ack of a
  frame by any receiver, at once when nobody can take the update, and when the
  last receiver detaches — so a view that never acks costs the others nothing.
  The helper queues a refresh BEHIND the frame in flight, so a view that attaches
  or resyncs while the current frame is un-acked releases that frame at once
  (the holders keep their in-flight mark and are skipped from then on): the
  newcomer's full frame arrives after one helper round trip, never after a
  silent view's ack.
- **Attach socket** (`rdp-socket.ts`): text events `attached` (state, prompt,
  desktop, endpoint), `state`, `cert_prompt`, `desktop`, `input_rejected`,
  `closed`, `error {code}`; binary frames = `{frameId u64, fbWidth, fbHeight, x,
  y, w, h, chunks u32 LE}` + RGBA rows (`chunks` = bands in the whole update; the
  view acks after drawing the LAST band, so the helper never sends the next
  update over bands still to come); from the view `ack {frameId}`, `input {events}`
  (fbWidth/fbHeight map to the helper's `geom_width/geom_height`; refused with
  `not_ready` before `desktop_ready`), `refresh`, `detach`. 4401 unknown token,
  4000 session ended (the stored reason is sent first), 4410 helper exited.
- **Screenshot memory**: a chunked answer is reassembled in the TS adapter: up to
  64 chunks x 768 KiB = 48 MiB of base64 per screenshot, at most 4 outstanding
  per session (the helper refuses a fifth with `screenshot_busy`), so at most
  about 192 MiB of base64 per session in the worst case; each pending request is
  dropped on `session.closed`, helper death or its 30 s timeout.
- **Known limits**: a stream the service finds out of step (a `seq` or `frameId`
  that does not follow) is dropped chunk by chunk, not turned into a session
  error (the helper validates every frame, so it is not expected); `screenshot_too_large`
  cannot occur at the largest desktop (64 chunks = 48 MiB of base64 against a
  ~44 MiB worst-case PNG).
- **Hidden pane**: the SSH | RDP switch hides the inactive page with `hidden`, it does not unmount it, so a hidden RDP canvas keeps drawing and acking frames (the session stays live and cheap to show again).
- **Close code 4410** is used for both "the helper exited" (reason `helper exited`) and "this session is not known any more" (reason `session_not_found`); the canvas tells them apart by the close reason.
- **Live probe**: `scripts/rdp-probe.ts` (not part of the bundle), see
  docs/rdp-windows-check.md.

## 4. Where metadata, secrets, keys and trust records live

- Metadata: `bb.storage` — `PluginStorage` (bb-plugin-sdk.d.ts:19830) with
  JSON `kv` (:19824) and a plugin-scoped SQLite `database()`
  (:19833-19845). Verified in declarations; unused in this stage.
- Settings and secrets: `bb.settings.define` (`PluginSettings` :19821);
  `secret: true` settings are stored in a 0600 file under
  `<dataDir>/plugins/<id>/secrets/`, never in the db or sent to the frontend
  (:19753, :19757). These are file-backed, not Keychain; the product spec
  requires macOS Keychain, which the Rust side will own in a later stage. Not
  verified as Keychain in declarations.
- Trust records (host keys, RDP certificates): later stages; no SDK API was
  found for them, so they will live in the plugin's own storage.

## 5. Placement modes

- Supported: BB server and execution host on the same Mac (the helper runs as
  a local child of the BB server). The helper integration tests in
  helper/tests/echo.rs verify the helper binary standalone over stdio; running
  the plugin inside a live BB server is NOT yet verified (the plugin has not
  been installed into a running BB).
- Separate BB server / execution host: the SDK has a host-entry mechanism —
  `experimental_defineHostEntry` (bb-plugin-sdk.d.ts:19726) and, on its RPC
  context, `experimental_retainWorker` (:19713). Verified in declarations;
  NOT verified as a transport for this product — a split server/host needs its
  own authenticated transport and is explicitly out of scope for this stage.

## Stage 3a — saved profiles

Profiles are metadata only (`src/core/profile.ts`): the schemas are strict, so a
secret-shaped field is refused, and the only link to a secret is `credentialRef`
(`rh-cred:v1:<executionHostId>:<uuid>`, validated and checked against the
profile's execution host; stage 3b resolves it). `ProfileBook`
(`src/core/profile-book.ts`) creates, updates, duplicates and deletes over a
`ProfileStore` port; `src/adapters/bb/profile-sqlite.ts` implements it on
`bb.storage.database()` with explicit columns (migration 0 = the `profiles`
table; append-only). An open from a profile passes `profileId` to `ssh_open` /
`rdp_open`; `ProfileBook.track` records the open time or the failure CODE (never
the message), and `session_list` shows the profile of each session, from which
the catalogue derives its status. The UI is `ProfileCatalogue`, `ProfileEditor`
and `useProfiles` around the existing session pages; Quick connect stays.
