# Remote Hub — architecture (stage 1)

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
  (:20446-20448). Verified in declarations; not wired in this stage (echo output
  returns through the RPC response today).
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
  drains at most 512 KiB (the 256 KiB pending-output bound plus one 256 KiB
  PTY read) and drops the rest. The remaining limit is the single shared stdout
  pipe: a stalled reader stalls every session, which stage 2 will revisit with
  a per-session binary WebSocket.
- openpty retry: `openpty` is retried a bounded 8 times on transient
  errnos (EAGAIN/EINTR/ENXIO, positive or negative); the observed failure is a
  transient errno -6 (-ENXIO) from plain `openpty` on macOS under parallel
  load, cause not established.
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
