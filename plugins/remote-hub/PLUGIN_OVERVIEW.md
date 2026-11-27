Remote Hub is an experimental SSH/RDP manager for BB, with Proxmox VE
guest discovery. SSH runs in xterm, RDP on a canvas, through a Rust helper.

## What you get

- Russian workspace: compact connection sidebar, one or two sessions with protocol, address, state and focus; stacked on narrow panels.
- Proxmox VE: Add Proxmox creates a restricted user (you confirm the plan; your admin login is used for this setup only, never stored) or saves a login or API token you have. The guest list shows each connection's outcome, search and links. Open a node shell, a container terminal or a VM's graphics (noVNC), several at once. A lost terminal reconnects itself (5 tries, 1-16 s, new console, scrollback kept); graphics never: Reconnect opens a new one. Tabs return after a restart as "not connected". Agents: container terminals, remote_reconnect; graphics only open, state, disconnect. No power buttons.
- SSH: connect form (host, user, port), a real /usr/bin/ssh session on a
  helper-owned PTY, xterm.js rendering, resize, and a binary WebSocket with
  attach/detach and a bounded scrollback snapshot on re-attach.
- RDP: connect form, the desktop on a canvas with mouse, wheel and keyboard input (Ctrl+Alt+Del button), a PNG screenshot, disconnect and reattach. The server certificate is
  validated strictly; when it is not trusted you see its fingerprint, subject,
  issuer and validity and accept it once, reject it, or trust it for good. A changed certificate is never accepted automatically. Sign-in uses NLA/CredSSP when offered.
  Quality per profile: Slow, Balanced, Best.
- Saved profiles: a tree in the sidebar with search and groups (Proxmox opens to its
  guests); an editor. A profile holds no password or key,
  only last-opened time and recent failure codes.
- Saved passwords and key passphrases use Credential Vault. Existing records are
  copied as needed, keeping their endpoint or key binding and any RDP certificate pin.
- Import (each source off until you switch it on): ssh config aliases (read as
  text, ssh -G only if you allow it), /etc/hosts names, public-key metadata, agent keys and
  known_hosts keys (only ticked ones are trusted). Profiles keep their source; re-importing changes
  nothing. Private keys are never opened. An alias behind a proxy or Match rule
  keeps using your ssh config.
- Agent access: per connection, default none, set by you in the editor. Observe: agents list connections and Proxmox guests, read terminals, take screenshots, and see all the terminal or screen shows, secrets too. Input: they may open a connection that has a SAVED password (never shown or typed by them), hold a lease (2 min; Take control ends it), send typed keys, text and pointer actions, and (Exec) run commands on sessions they opened, only while that session's live view is on screen in a focused window ("Watch in split"). While an agent drives, an overlay of light dots and a Take control button show it.
- The helper owns every session; detaching never ends it.

## Honest limits

Passwords saved before bindings existed must be saved again. Helper unsigned. A saved RDP password is bound to
host, port, user and domain and, after its first accepted use, to that server
certificate (trust on first sight): save it again to start over.
One-time codes are always typed by you. macOS may ask once to read a legacy record during migration. "Last opened" means the open succeeded, not that the login was accepted.
Cmd+V types the clipboard (RDP, VM). No remote resize, Kerberos. NLA, strict TLS and Proxmox are tested against fixtures. The helper is built with npm run build:helper (Rust, aarch64-apple-darwin).

## Source

Requires BB 0.49 or later. MIT licensed at https://github.com/Mesteriis/makosh-bb.
