# Live check: Proxmox VE consoles

Run by the coordinator on 2026-11-19 against the owner's Proxmox VE 9.2.4
(one node, 34 guests: 27 LXC, 7 QEMU) through the plugin installed in BB.
Builds: `30a043be`, `fdde141d`, `c3f907dc` (the helper binary is the one built
from `30a043be`; later commits changed no helper production code). The
connection uses the restricted user the onboarding created (`remotehub@pve`,
role `RemoteHubConsole`). Only harmless input was typed; no guest or host
configuration was changed. One VM (`astra-linux`, 152) was started by the
owner's word for the graphics check and shut down afterwards.

| Scenario | Result | Evidence |
| --- | --- | --- |
| Onboarding: restricted user, role, ACL; TLS pin after `tls_untrusted` | passed (stage 1 run) | plan shown, applied by the owner, discovery `ok` |
| Discovery: nodes and guests with state | passed | 34 guests, node `pve`, PVE 9.2.4 |
| Saved credential after a helper update | passed | `keychain_needs_approval` shown; the owner's Allow access made it readable; reinstalling the same binary asked nothing |
| Refusal: stopped guest | passed | `guest_stopped`, nothing started |
| Refusal: missing guest | passed | `guest_not_found` |
| LXC terminal: output and input | passed | login prompt of `rdp-ssh-test`, typed name echoed, `Login incorrect` |
| Disconnect ends the console on the node | passed | no `termproxy` for the guest after Disconnect |
| Manual Reconnect opens a new console | passed | one new `termproxy`, input works |
| Node shell as a second console | passed | `pve login:` beside the container tab; nothing typed |
| Close tab ends its console | passed | node-shell `termproxy` gone |
| QEMU graphics: first frame, mouse, keyboard | passed | 1280x800 Astra login screen; click focused the field, four letters appeared, then removed |
| First graphics open on a cold page | failed on `30a043be`, passed on `fdde141d` | PVE task `connection timed out` after 10 s; after the fix active in under 3 s |
| Automatic reconnect of a lost terminal | passed | node-side `termproxy` killed: `reconnecting (1 of 5)` then `active`, exactly one `termproxy` |
| Idle close with no view | passed | console gone from the node within 5 minutes of leaving the page |
| Tabs after a page reload | passed | restored as `not connected`, nothing opened |
| Guest list and console together | failed on `fdde141d` (terminal 15 px high), passed on `c3f907dc` (225 px at 1280x581) | measured in the page |
| Terminal text after a reconnect | partial | the `connection lost` / `reconnected` lines are in the scrollback; the screen text from before the loss was not found there |
| Agent: node shell | passed | `node_shell_owner_only` |
| Agent: connection list, targets, own container console, session visibility, disconnect | passed | a separate agent thread: connection listed with its level, 34 guests, console of the test container reached `running`, only its own session visible, list empty after disconnect |
| Agent: typing into a container console, `remote_reconnect` refusal, stopped-guest refusal | not verified live | the tester stopped before these steps |

Not verified live: a guest moving to another node (single-node installation),
a console ticket expiring in the middle of an open, the 2 s hand-over deadline
under a blocked transport, API-token authentication and the "connect as is"
onboarding mode, repeated onboarding (keep / rotate), a guest SSH or RDP link
from a guest card.

Known limits: the helper is not signed with a stable identity, so macOS asks
once per saved credential after every helper rebuild; agents get no screenshot
and no input for VM graphics; after a reconnect the visible terminal is blank
until the guest prints.
