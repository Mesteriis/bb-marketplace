Remote Hub is an experimental SSH/RDP connection manager for BB. It runs one real
SSH session in the embedded xterm terminal and one real RDP session on a canvas,
both through a Rust helper.

## What you get

- A Remote Hub page with a helper status line and an echo console.
- An "SSH / RDP" page with a switch between the two kinds.
- SSH: connect form (host, user, port), a real /usr/bin/ssh session on a
  helper-owned PTY, xterm.js rendering, resize, and a binary WebSocket with
  attach/detach and a bounded scrollback snapshot on re-attach.
- RDP: connect form (host, port, user, password, domain), the desktop painted on
  a canvas with mouse, wheel and keyboard input (Ctrl+Alt+Del button), a PNG screenshot, disconnect and reattach. The server certificate is
  validated strictly; when it is not trusted you see its fingerprint, subject,
  issuer and validity and choose to accept it once, trust it for this BB run,
  reject it, or trust it for good. A changed
  certificate is never accepted automatically. Sign-in uses NLA/CredSSP when offered.
  Connection quality per profile (presets also in Quick connect): Slow link, Balanced (default), Best quality; compression, colour depth and effects under Advanced.
- Saved profiles: a catalogue beside Quick connect (nothing saved) with search,
  an SSH/RDP filter, groups, tags, favourites and live status; an editor for name,
  host, port, user, domain, authentication, key-file path and RDP size. A profile
  holds no password or key material, only when it was last opened and recent
  failure codes.
- Saved passwords and key passphrases live in the macOS Keychain, never in the
  profile, database, page or any log, and work only for the host, port, user
  (domain) or key file they were saved for; editing those forgets them. SSH uses
  them through OpenSSH's askpass hook, served by the helper: one prompt, once,
  with no SSH config (`-F none`).
  Host-key questions are answered by you, never saved. A Credentials screen lists,
  checks, changes and deletes them.
- Import (each source off until you switch it on): ssh config aliases (read as
  text, ssh -G only if you allow it per source), /etc/hosts names, public-key
  metadata, agent keys and known_hosts keys (only the ones you tick are trusted,
  in a helper-owned file used by saved-password SSH). Profiles keep their source; re-importing changes
  nothing. Private keys are never opened. An alias behind a proxy or Match rule
  keeps using your ssh config; no password can be saved for it.
- Agent access: per connection, default none, set by you in the editor. Observe: agents list connections, read terminals, take screenshots, and see all the terminal or screen shows, secrets too. Input: they may open a connection that has a SAVED password (never shown or typed by them), hold a lease (2 min; Take control ends it) send typed keys, text and pointer actions, and (Exec) run commands on sessions they opened, only while that session's live view is on screen in a focused window (banner; "Watch in split"). While an agent drives, an overlay of light dots and a Take control button show it.
- The helper owns every session; detaching a view never ends it, and disconnecting never logs the remote user off.

## Honest limits

Passwords saved before bindings existed must be saved again. Helper unsigned. A saved RDP password is bound to
host, port, user and domain and, after its first accepted use, to that server
certificate (trust on first sight): the helper sends it to no other (save it
again to start over).
One-time codes are always typed by you. macOS may ask to approve Keychain access. "Last opened" means the open succeeded, not that the login was accepted.
No clipboard, remote resize or Kerberos. NLA and strict TLS checked by hand; not run in a live BB server. The helper binary is built with npm run build:helper (Rust, aarch64-apple-darwin).

## Source

Requires BB 0.49 or later. MIT licensed at https://github.com/Mesteriis/makosh-bb.
