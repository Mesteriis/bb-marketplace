# Remote Hub: security model (stage 4b-1 state)

- **Secrets** live in the macOS Keychain only, bound inside the item to the endpoint or key file they were saved for,
  and are used by the helper (askpass for SSH, the engine for RDP). No page call, tool result, log, audit row or
  profile row carries one. There is no tool that reads a secret.
- **Agents** act through tools registered with BB. The only identity BB gives a tool call is the thread and project
  (`ctx.threadId`, `ctx.projectId`). Access is granted per connection by the owner on the Remote Hub page, applies to
  agents in any thread, and is checked on every call. Remote output (terminal text, pixels) is untrusted data: it
  cannot grant access, and the tools frame it as data.
- **What Observe shows.** Agents never get a saved password or key. But an agent with Observe can read everything the
  terminal prints (its scrollback included) and everything visible on the remote screen, so a secret that appears
  there is visible to it. Treat Observe as "the agent sees what you would see".
- **Limit: access levels restrict tools, not callers.** The levels limit what the *registered agent tools* do. The host
  reports every caller that is not another plugin as kind `client`, whether it is the owner's page or `bb plugin rpc call`
  run from a shell, so the plugin cannot tell them apart. A BB agent that can run `bb plugin rpc call` or other shell
  commands as the owner is therefore NOT contained: it can change a grant, read the plugin database or drive the
  helper. The UI makes no claim of isolation. What the plugin does: owner RPCs refuse callers of kind `plugin`; every
  grant change and "revoke all" is written to the audit (who: "owner RPC", old and new level, time) and shown at the top
  of Agent activity. BB offers plugins no server-side toast or owner-only confirmation surface an agent cannot answer
  (`bb.ui.requestInput` appears in the agent's own thread), so widening a grant raises no notice.
- **Host keys and certificates** are the owner's decisions: an agent cannot approve a new host key, a changed key, or a
  server certificate. A saved RDP password is pinned to the certificate it was first used with (trust on first sight);
  a saved-secret SSH session reads only the helper-owned known_hosts overlay.
- **Audit** records who (thread), what (tool, connection, session) and the outcome; it never records terminal text,
  keystrokes, screenshots or secrets. An input is recorded as its length only (an unkeyed hash of a short typed secret could be guessed offline); command text only when the
  owner enables it (stage 4b-2).
- **Control.** At the `input` level an agent can open a connection with its SAVED credential (it never gets or types a
  secret), hold a lease on a session and send typed input. The owner sees who drives each session, the human's input is
  paused while an agent drives, and one click takes the session back at once. A lease is in memory only, ends when the
  grant drops, the thread goes or the call is aborted, and never survives a restart. What an agent types is visible to the
  remote side, as for a person: Input is the power to act as the logged-in user on that session.
- **When an SSH session becomes drivable.** Only after the SERVER accepted the login. For a session with a saved
  secret the helper adds `-o PermitLocalCommand=yes -o LocalCommand=<private link to itself>` itself (callers may not
  name either option); OpenSSH runs that command on this machine only after authentication succeeded, and the helper
  accepts it only from a child of that session's ssh process carrying the session's nonce, only after the saved secret
  was handed over, and once. Until then (and while the owner has a question open, and for ever after a refusal)
  an agent can neither take control nor type. A session the owner opened by hand never carries this and is never
  drivable. Tested against a real sshd that holds its answer for seven seconds after the password.

## Agents are never hidden (stage 4c)

- **The watching gate.** Agent input (terminal and desktop) is refused with `owner_not_watching` unless at least one
  person has that session's live view open and **on screen**: its element at least half inside the viewport (an
  IntersectionObserver), the document visible AND the window focused. A view reports over its stream socket every 2 s and
  at once on a change; a view that is mounted but scrolled away, behind another tab, in a hidden window or in an unfocused
  window counts for nothing, a missing document, observer or element is "not looking", and a report older than 6 s is
  stale. The `::remote-session` directive in a message is only a card (what the session is, "Watch in split", "Open live
  view"); it never attaches by itself. "Watch in split" opens the live view in the main pane and the agent's thread in a
  split beside it (BB can split a thread from a plugin but cannot split a plugin page, hence this arrangement); the
  thread comes from the service's record of who holds or opened the session, never from the directive text. The owner's
  screen is moved automatically only when they are already looking at that agent's thread; anywhere else the banner asks. Reads (terminal text,
  screenshots) need no watcher but are listed in Agent activity. The gate has no per-connection switch; there is ONE plugin-wide owner setting, "Agents may act only while I am watching the session" (default ON, stored in SQLite, changed only by the owner RPC from the Agent activity screen, every change audited and listed under Access changes). OFF means an agent can act while nobody looks: input and commands are not refused and leases are not suspended, but the banner, the live-view line, the pointer and the live command list stay. Tool results carry `watchingRequired`.
- **The overlay while an agent drives.** The live view (terminal and desktop, on the page, in the tab and wherever the widget is
  mounted) shows a slim bar ABOVE the widget, "Agent is controlling this session" (with the agent thread's title when the
  service knows the thread) and one button, "Take control", which uses the owner's existing take-over path (audited the same
  way as the banner's); and a field of small dots over the widget with a visible travelling wave. The dots are drawn by
  tsParticles (`@tsparticles/engine` 4.6.0, MIT, engine only; about 81 kB minified, loaded lazily when an agent lease first
  appears, so pages without an agent run none of it): at most 30 frames per second, one dot per 900 px² with a floor of 24 and
  a hard maximum of 360, paused while the document is hidden or the view is off screen, destroyed (canvas, listeners, loop)
  when the lease ends or the view goes away. Under `prefers-reduced-motion`, or if the library fails to load, no particle code
  runs and static CSS dots stay. The dots are a picture only: translucent, no blur or dimming, the canvas takes no pointer
  events (text can still be selected; the human's input is refused by the service while the agent drives, which stays the
  source of truth). The overlay follows the same lease state the banner uses; it is a sibling of the widget, so it neither
  counts as "not watching" nor changes the view's on-screen ratio (the bar takes its own row, so the widget is a little
  shorter while an agent drives).
- **Suspension.** When the last watcher goes (closed, hidden, stalled) an agent's lease is suspended at once: its owner tag
  changes in the helper, so what it had queued is dropped and what it held down is released (the same barrier as a
  takeover), its input is refused, and it resumes when a watcher returns. The lease still expires as usual.
- **What the owner sees.** `remote_connect` / `remote_control_acquire` return a `liveView` line (`::remote-session{id=…}`)
  that the agent is told to put in its reply; BB renders it as this plugin's live view of the session. The owner's pages
  also show a standing banner ("An agent is driving…", Watch / Take control) fed by the plugin's realtime signal,
  which carries session identifiers only. Typed input appears in the same terminal; a desktop shows the agent's pointer.
- **Experimental SDK surfaces used** (each has a fallback): `bb.realtime.publish` + `useRealtime`;
  `slots.experimental_appOverlay` (the banner); `slots.experimental_tab` + `experimental_useAppPanel().openTab` (opens the
  live view on a thread's side panel without a click — BB answers false when there is no panel, and then the banner and
  the directive are what the owner has); `slots.messageDirective` (stable). They may change between BB releases.
- **Limit.** The gate proves a visible view is open, not that a person is looking at it. A directive in the agent's reply
  depends on the agent following the skill text; the banner does not.

## Remote commands (stage 4b-2)

- **What a command is.** At the `exec` level an agent may run ONE command on the host of an SSH session it opened
  (`remote_ssh_exec`; read with `remote_command_read`, stopped with `remote_command_cancel`). The command is a single string
  (at most 8192 bytes) that ssh hands to the **remote** user's shell, which parses it. No local shell is involved and
  nothing is expanded on this machine. It runs in its own `/usr/bin/ssh -T` process (no pty, stdin closed, so a command that
  reads input sees end of file), built by the same argv builder and validated by the same strict allowlist as a session.
- **No question can reach an agent.** The run uses the connection's saved credential through the same askpass broker
  (the one expected prompt, once) and in refuse mode: any other prompt is refused and ssh is stopped, so a host key, a code or
  a refused password ends the run with a closed-list code (`host_key`, `login_prompt`, `credential_rejected`,
  `credential_unavailable`). Host keys come from a private copy of the owner's confirmed keys with
  `StrictHostKeyChecking=yes`: an unknown endpoint is refused before anything starts (`host_key_unknown`), a changed key
  stops the run. A command never decides a key.
- **Bounded.** 3 live commands per thread, 2 per session, a timeout (default 60 s, at most 600 s; TERM then KILL after 2 s,
  by process group), the head of each stream kept (1 MiB, the total counted and the cut said), a 256 MiB flood stop, no
  automatic retry, the tool budget on every call. Output reaches the agent as text with control sequences removed, framed as
  untrusted data. Binary output is not passed through.
- **Visible and audited.** The command text and its output stream live to the session's open views (the "Commands an agent
  ran" list) even when "record commands" is off: shown, not stored. The audit keeps the command's length, or its text cut
  at 512 characters only when the owner switched "record commands" on for that connection. The watching rule applies as
  for input: with the rule on, a session whose last watcher leaves has its running commands cancelled after a **5 s grace**
  (so a tab switch does not kill a run; a watcher back inside it keeps them), and a read after that returns the
  cancellation (`reason: owner_not_watching`), never what the command printed later. A start is checked again once the run
  exists: a revoke, a closed session or a lost watcher while it was starting cancels it and nothing is returned. Both the
  per-thread and the per-session slot are reserved before the start is awaited. Lowering the grant below `exec` cancels what
  runs for that connection and ends reading. One public command id names the start, the output and the end in the live list.
- **Limits.** A command runs as the saved user with that user's rights: exec is the power to act as that user. The
  helper's own bounds do not limit what the remote command does on the server.

## Saved passwords and migration

On macOS, install Credential Vault before replacing Remote Hub. Start with an
available, unlocked default Keychain. Credential Vault needs one Keychain item
for its encryption key and stores each Remote Hub credential and binding in
encrypted SQLite. The native helper sends and receives these records through a
private Unix socket. The BB backend authenticates that socket with a
per-instance token and accesses Credential Vault under the Remote Hub plugin
identity. No page, CLI or agent tool can read passwords from the bridge.

The helper first reads the vault. If a reference is absent, it reads the old
Keychain item without interaction and copies the complete bound record using
an insert that preserves any newer vault value. It reads the vault back before
using the copied value. If macOS refuses to read a legacy record, the owner can
select **Перенести сохранённый пароль** on the RDP error or allow access from
the Credentials panel. That may show a native dialog for the old record. Future
connections use the vault and skip the legacy item. An unavailable vault causes
a refusal before fallback. A missing default Keychain is reported as an error.

The legacy originals are retained for rollback. When a credential is deleted
in the new version, an encrypted deletion marker prevents that legacy copy
from being imported or used again. Do not treat rollback as permanent deletion
of the original items. New writes go only to the vault. Back up the Vault DB
with its corresponding Keychain key before removing the legacy backup.

## Proxmox VE (stages 0 and 1)

- The PVE engine (`--pve-engine`) is a separate process like the RDP engine: empty environment, the helper's stdio and stderr
  closed, one socketpair. The secret (a typed password used for one request, or a Keychain item the helper resolves itself) travels only in
  its `Open` frame; the helper checks that a saved secret was saved for exactly this `pve` host, port and user or token id.
- TLS is strict in every mode: the system roots, one CA the owner supplied, or one pinned leaf certificate. There is no
  setting that skips verification. No login is sent before the handshake passed. A refusal carries the presented SHA-256
  fingerprint; the owner confirms it on the page, and the server accepts a pin only for the fingerprint it last saw in a
  refusal for that connection (`pve_trust_pin`). A pinned certificate that changes is `cert_changed`, never silently accepted.
- A refused login, an expired ticket or a refused console ticket is one `login_failed`; nothing retries it (the server delays a
  refused login by 3 seconds and an account can be locked by repeats).
- Onboarding mode 1 is the only place the plugin changes anything on Proxmox, and only through the owner's RPC after a reviewed
  plan. It creates the role `RemoteHubConsole` (Sys.Audit, Sys.Console, VM.Audit, VM.Console), a user `name@pve` (default
  `remotehub@pve`, chosen by the owner) and one ACL entry. The plan answer carries a SHA-256 digest of the server state it was
  computed from (endpoint, ACL path, admin identity, presented certificate, the role and its privileges, the user and its marker,
  the user's ACL entries); apply must present it, re-reads the state and refuses before the first write with `plan_changed` if
  anything differs. A digest is accepted once, and an apply without one is refused (`plan_required`).
- Ownership is proven, not assumed: a user is ours only if its comment carries "Managed by BB Remote Hub", otherwise `name_taken`
  and nothing is written. An existing role is kept only if its privileges are exactly the four; otherwise `role_differs`, and
  replacing it needs a separate confirmation (it also narrows the role for everyone who holds it). The plan lists the user's other
  ACL entries, groups and API tokens; none is ever removed. Rotating the password of a managed user updates every saved
  credential bound to that endpoint and user.
- Partial failure is reported per step (role, user, acl: done, kept, failed, not_attempted, unknown). The new password is saved to
  the Keychain as soon as the user step succeeds, before the ACL write, and the helper waits for that save before writing the ACL;
  if a later step fails, the connection stays visible as "setup incomplete" and running the setup again completes it. A write that
  was sent without an answer is `unknown`; losing the helper transport cancels the engine at once and no further write is sent.
- The administrator's login is used for this setup only and never stored or logged: plan and apply each sign in, so it is typed
  for the review and kept in the page's memory until apply, then cleared on success, cancel, unmount and after every failed attempt.
  The generated password is made in the engine, saved to the Keychain by the helper, and only for a binding that names this
  endpoint and user; the client is told what happened, never the secret. Server response bodies and headers are never passed on:
  errors are fixed local messages plus the HTTP status. It is audited (`pve.onboard_plan`, `pve.onboard_apply`, `pve.pin`) with
  host, port, admin user, new user and ACL path, never a secret. There is no agent tool for it.
- A certificate pin is bound to (profile id, host, port, profile revision). Editing the connection discards the refusal, a late
  discovery answer for an old revision is dropped, "forget" is not undone by an answer already on its way, and `profile_save`, the
  pin RPC and both onboarding entry points store a pin only through the same "fingerprint presented in the last refusal for this
  endpoint" rule.
- `remote_pve_targets` is an observe-level read: it lists guests of connections the owner allowed, with outcomes. It cannot open
  a console, change a guest or call the API otherwise. Guest names come from the server: untrusted data.

## Threat model and every stated limit, in one list

Assets: the saved credentials (Keychain), the sessions and what is on them, the owner's decisions (host keys,
certificates, grants). Attackers considered: a remote host or its output, an agent that is wrong or manipulated (prompt
injection through remote text), another local process, a thread that is archived or deleted.

What holds: saved secrets never reach an agent, the page, a log or a profile and work only for the endpoint they are bound
to; an agent cannot answer a host-key, certificate or login question; agent control needs the owner's grant, an SSH
session that is authenticated (the server accepted the login: LocalCommand signal) and, by default, a visible live view;
the owner takes a session back with one click and a handover drops queued input and releases held keys (for a desktop, in
the engine); output reaching an agent is framed as untrusted data; commands are bounded, never retried and ask no question.

Limits, plainly:
1. Levels restrict the registered agent tools, not callers: an agent that can run shell commands as the owner can reach
   the plugin's RPC and the Keychain prompts. Not contained.
2. Observe shows everything on screen or in the terminal, secrets included, and the scrollback.
3. The helper binary is unsigned; the Keychain item is protected by the user's login Keychain, not by the helper.
4a. Automated input on a host with endpoint protection (EDR, antivirus) can raise a detection under the owner's account: a
    live incident blocked `powershell.exe` started from the Run dialog through the RDP client. This is a stated limit, not
    something to work around. Agent policy (skill text and the `remote_rdp_input` / `remote_connect` descriptions): do not
    launch shells or programs through Start/Run/Win+R or launch shortcuts unless the owner asked in this conversation, and say
    what you will type first; on a security block, an access-denied launch error or an antivirus notice stop all input, dismiss
    nothing, try no other route and report what was shown. This is guidance to the agent, not a technical control.
4. The watching gate proves a view is on screen in the focused BB window, not that a person looks at it; a window left
   focused on it counts. "On screen" is viewport intersection of the view's element, so an element drawn over the view (a modal,
   another panel) does not stop it counting. The owner can
   switch the rule off, and then an agent can act while nobody looks.
5. The live-view line in a reply depends on the agent following the skill text; the banner and the audit do not.
6. `openTab` (opening the live view without a click) is best effort and untested against a real BB; the SDK surfaces used
   are experimental and may change.
7. Up to 8 KiB of desktop input already in the engine pipe, and whatever the engine already wrote to the server's socket, are
   not recalled by a handover.
8. Exec is the power to act as the saved user on that host; the helper's bounds do not limit what the command does there.
9. Audit stores lengths, not content (commands only when "record commands" is on, cut at 512 characters).
10. A changed host key against a real sshd is not tested for exec (the option list and the unknown-host refusal are).
11. "Credential used" plus the LocalCommand signal is the strongest trusted authentication signal OpenSSH gives; a server
    that accepts then drops is seen as ready briefly.
12. Memory-only state (leases, watchers, command lists) is lost on a restart: every session returns to the human.
13. RDP: sessions the owner opens by hand remain drivable by the owner only; Windows rendering completeness is under
    investigation (see the RDP notes in docs/rdp-engine.md).
14. A remote command is a child `ssh` process of the helper. If the helper dies hard (killed, crashed) the ssh process is not
    ended by the system (macOS has no parent-death signal), so a running command can outlive it until its own timeout or the
    server closes it. A clean stop, a revoke, closing the session and the timeout all kill it.
16. The helper's checksum (`bin/SHA256SUMS`) is verified before the helper starts and a missing, malformed or non-matching file
    (or a symlink in its place) refuses the start, with no override. It detects a corrupted or partly updated install. It
    does NOT defend against someone who can write to the plugin directory (they can replace SHA256SUMS or `dist/server.js`
    too), and it does not close the window between hashing the file and executing it by path (a process of the same user can
    swap it in between); that is the same-user limit of item 1. The helper status shows "checksum verified".
15. The "Watch in split" arrangement (live view in the main pane, the agent's thread in a split) depends on BB's
    `toThread(…, { split: true })` and `useSidebarSplitLayout`; where BB does not split, the live view stays and a link to the
    thread is shown. Whether the owner is "looking at the agent's thread" is read from the focused split pane or the
    surface's thread id; neither is verified against a real BB yet.
