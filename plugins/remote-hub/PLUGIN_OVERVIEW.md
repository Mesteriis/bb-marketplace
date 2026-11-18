Remote Hub is an experimental SSH/RDP connection manager for BB. It runs one real
SSH session in the embedded xterm terminal and one real RDP session on a canvas,
both through a Rust helper, plus the echo console from stage 1.

## What you get

- A Remote Hub page with a live helper status line (version, pid, platform,
  open sessions) and an echo console.
- An "SSH / RDP" page with a switch between the two kinds.
- SSH: connect form (host, user, port), a real /usr/bin/ssh session on a
  helper-owned PTY, xterm.js rendering, resize, and a binary WebSocket with
  attach/detach and a bounded scrollback snapshot on re-attach.
- RDP: connect form (host, port, user, password, domain), the desktop painted on
  a canvas with mouse, wheel and keyboard input (Ctrl+Alt+Del button), Fit and
  1:1 views, a PNG screenshot, disconnect and reattach. The server certificate is
  validated strictly; when it is not trusted you see its fingerprint, subject,
  issuer and validity and choose to accept it once, trust it for this BB run, or
  reject it. A different certificate on a host you trusted is shown as changed
  and is never accepted automatically. Sign-in uses NLA/CredSSP when the server
  offers it.
- Saved profiles: a catalogue beside Quick connect (nothing saved) with search,
  an SSH/RDP filter, groups, tags, favourites and live status; an editor for name,
  host, port, user, domain, authentication, key-file path and RDP size. A profile
  holds no password or key material, only when it was last opened and recent
  failure codes.
- Saved passwords and key passphrases live in the macOS Keychain, never in the
  profile, database, page or any log, and work only for the host, port, user
  (domain) or key file they were saved for; editing those forgets them. SSH uses
  them through OpenSSH's askpass hook, served by the helper: one prompt, once,
  with no SSH config (`-F none`). A refused secret is tried once and reported.
  Host-key questions are answered by you, never saved. A Credentials screen lists,
  checks, changes and deletes them.
- Import (each source off until you switch it on): ssh config aliases (read as
  text, ssh -G only if you allow it per source), /etc/hosts names, public-key
  metadata and agent keys. Profiles keep their source; re-importing changes
  nothing. Private keys are never opened. An alias behind a proxy or Match rule
  keeps using your ssh config and cannot save a password.
- The helper owns every session; detaching a view never ends it, and
  disconnecting never logs the remote user off.

## Honest limits

Passwords saved before bindings existed must be saved again. The helper is unsigned: same-user code
injected into it is not stopped. A saved RDP password is bound to
host, port, user and domain; you still decide on the server certificate each time.
One-time-code logins are always typed by you. Certificate trust lasts for the BB run; there are no agent tools or CLI yet. macOS may ask you to
approve the helper's Keychain access; until then a saved password reports "locked or needs approval". "Last opened" means the open succeeded, not that the server accepted a login.
No clipboard, no remote resize, no Kerberos. NLA against a real Windows host and strict TLS were checked by hand;
the plugin has not otherwise been exercised inside a live BB server. The helper
binary is not committed under bin/; build it with npm run build:helper (Rust
toolchain for aarch64-apple-darwin).

## Source

Requires BB 0.49 or later. MIT licensed at https://github.com/Mesteriis/makosh-bb.
