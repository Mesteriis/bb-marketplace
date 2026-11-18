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
  an SSH/RDP filter, groups, tags, favourites and a status derived from the live
  sessions; an editor for name, host, port, user, domain, authentication type,
  key-file path and RDP desktop size. Connect opens a session from a profile
  (SSH at once; RDP fills the form and waits for the password). A profile holds
  no password or key material, and it records only when it was last opened and
  the codes of recent failed opens.
- Saved passwords for RDP profiles, kept in the macOS Keychain (never in the profile,
  the database, the page or any log). A profile can save a password, replace it or
  remove it; Connect then uses it without typing. A saved password only works for
  the host, port, user and domain it was saved for, and editing those forgets it.
  A Credentials screen lists what is saved, which profiles use each entry, and can
  check, change or delete it. A locked or refusing Keychain is shown as such; there
  is no fallback to storing the password anywhere else.
- The helper owns every session; detaching a view never ends it, and
  disconnecting never logs the remote user off. Session end is reported with its
  reason.

## Honest limits

SSH passwords and key passphrases are still typed each time (saving them needs the
askpass work of stage 3b-2), certificate trust lasts for the BB run, and there is no
import of SSH config, no agent tools and no CLI yet. The helper is not code-signed,
so macOS may ask you to approve its Keychain access; until you do, a saved password
reports "locked or needs approval" instead of a dialog. "Last opened" means the open call succeeded, not that
the server accepted a login. No clipboard, no remote resize, no
Kerberos. NLA against a real Windows host and strict TLS were checked by hand;
the plugin has not otherwise been exercised inside a live BB server. The helper
binary is not committed under bin/; build it with npm run build:helper (Rust
toolchain for aarch64-apple-darwin).

## Source

Requires BB 0.49 or later. MIT licensed at https://github.com/Mesteriis/makosh-bb.
