Remote Hub is an experimental SSH/RDP connection manager for BB. This stage
ships the scaffold: a Rust supervision helper and the verified stdio protocol
it speaks with the plugin.

## What you get

- A Remote Hub page with a live helper status line (version, pid, platform,
  open sessions) and an echo console.
- The helper opens a real PTY per echo session (/bin/cat) and streams output
  back as binary frames with sequence numbers.
- Closing a session, closing the helper stdin, or SIGTERM tears down every
  child process the helper owns.

## Honest limits

No SSH or RDP, no saved profiles, no credentials, no agent tools and no CLI
yet. They arrive in the following stages; nothing here pretends they work.

## Source

Requires BB 0.49 or later. MIT licensed at https://github.com/Mesteriis/makosh-bb.
