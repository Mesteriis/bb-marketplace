# Remote Hub: security model (stage 4a state)

- **Secrets** live in the macOS Keychain only, bound inside the item to the endpoint or key file they were saved for,
  and are used by the helper (askpass for SSH, the engine for RDP). No page call, tool result, log, audit row or
  profile row carries one. There is no tool that reads a secret.
- **Agents** act through tools registered with BB. The only identity BB gives a tool call is the thread and project
  (`ctx.threadId`, `ctx.projectId`). Access is granted per connection by the owner on the Remote Hub page, applies to
  agents in any thread, and is checked on every call. Remote output (terminal text, pixels) is untrusted data: it
  cannot grant access, and the tools frame it as data.
- **Limit: the same OS user.** BB plugins and processes of the owner are full-trust. A process running as the same user
  can call the plugin's RPCs (the owner's page uses the same ones), read the plugin database and drive the helper. This
  model does not isolate an agent from the owner's shell access, and does not claim to: it limits what the registered
  tools do.
- **Host keys and certificates** are the owner's decisions: an agent cannot approve a new host key, a changed key, or a
  server certificate. A saved RDP password is pinned to the certificate it was first used with (trust on first sight);
  a saved-secret SSH session reads only the helper-owned known_hosts overlay.
- **Audit** records who (thread), what (tool, connection, session) and the outcome; it never records terminal text,
  keystrokes, screenshots or secrets. Input and command text are stored only as the owner chooses (stage 4b).
