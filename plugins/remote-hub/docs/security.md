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
  person has that session's live view open and **visible**. A view reports in over its stream socket every 2 s with its
  page visibility; a hidden tab counts for nothing and a report older than 6 s is stale. Reads (terminal text,
  screenshots) need no watcher but are listed in Agent activity. The gate has no per-connection switch; there is ONE plugin-wide owner setting, "Agents may act only while I am watching the session" (default ON, stored in SQLite, changed only by the owner RPC from the Agent activity screen, every change audited and listed under Access changes). OFF means an agent can act while nobody looks: input and commands are not refused and leases are not suspended, but the banner, the live-view line, the pointer and the live command list stay. Tool results carry `watchingRequired`.
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
  for input. Lowering the grant below `exec` cancels what runs for that connection and ends reading.
- **Limits.** A command runs as the saved user with that user's rights: exec is the power to act as that user. The
  helper's own bounds do not limit what the remote command does on the server.

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
4. The watching gate proves a visible view is open, not that a person looks at it; one tab left open counts. The owner can
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
