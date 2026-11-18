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
  screenshots) need no watcher but are listed in Agent activity. The gate has no per-connection switch.
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
