Remote Hub is an experimental SSH/RDP connection manager for BB. Stage 2a
ships one real SSH session in the embedded xterm terminal, plus the echo console
and the Rust PTY helper from stage 1.

## What you get

- A Remote Hub page with a live helper status line (version, pid, platform,
  open sessions) and an echo console.
- An SSH page: connect form (host, user, port), a real /usr/bin/ssh session on
  a helper-owned PTY, xterm.js rendering, resize, and a binary WebSocket with
  attach/detach and a bounded scrollback snapshot on re-attach.
- The helper owns every session; detaching a view never ends it. Session end is
  reported with the exit code/signal/reason, and the helper enforces the same
  ssh argv policy as the TypeScript builder.

## Honest limits

No saved profiles, no credentials, no RDP, no agent tools and no CLI yet. The
plugin has not been exercised inside a live BB server. The helper binary is not
committed under bin/; build it with npm run build:helper (Rust toolchain for
aarch64-apple-darwin).

## Source

Requires BB 0.49 or later. MIT licensed at https://github.com/Mesteriis/makosh-bb.
