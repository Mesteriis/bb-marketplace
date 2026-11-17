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
- RDP image frames: not in this stage; nothing is claimed about them yet.

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
