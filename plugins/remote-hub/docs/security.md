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
  keystrokes, screenshots or secrets. An input is recorded as its length and a short hash; command text only when the
  owner enables it (stage 4b-2).
- **Control.** At the `input` level an agent can open a connection with its SAVED credential (it never gets or types a
  secret), hold a lease on a session and send typed input. The owner sees who drives each session, the human's input is
  paused while an agent drives, and one click takes the session back at once. A lease is in memory only, ends when the
  grant drops, the thread goes or the call is aborted, and never survives a restart. What an agent types is visible to the
  remote side, as for a person: Input is the power to act as the logged-in user on that session.
