# Remote Hub RDP — Windows NLA/CredSSP manual check (NOT verified)

Windows NLA/CredSSP cannot be verified in this repository: there is no Windows
RDP endpoint here, and the xrdp Docker target does not offer NLA (it negotiates
plain TLS security). The engine implements the path through IronRDP (Config
`enable_credssp = true`, `enable_tls = true`), but it is **not verified** and
must not be claimed as working.

## Reproducible manual scenario

1. On a Windows machine, enable Remote Desktop and set "Allow connections only
   from computers running Remote Desktop with Network Level Authentication".
2. Build the helper: `cd plugins/remote-hub && npm run build:helper`.
3. Start the helper and open a session (e.g. through the 2b-2 service once it
   exists, or a raw `session.open_rdp` over the stdio protocol) to the Windows
   host with `username`/`password`/`domain` set.

## What must be observed

- **NLA success**: the connection sequence reports `connecting` → `tls` →
  `authenticating` → `desktop_ready` (no `cert_prompt` when the server presents
  a certificate the machine trusts).
- **Wrong password → `auth_failed`**: a bad password closes the session with
  reason `auth_failed`, and the password literal appears in no log line, no
  event and no RPC response.
- **Strict TLS**: a self-signed or unknown certificate yields `cert_prompt`
  with the SHA-256 fingerprint, subject/issuer and validity; the decision must
  name that fingerprint.
- **Self-signed pinning**: accepting "Trust for this BB run" for a fingerprint
  auto-accepts the same fingerprint later, and a different certificate yields a
  prompt with reason `cert_changed`.
- **Changed certificate**: after pinning, replacing the server certificate
  yields `cert_changed`, never auto-accept.

## Status

Not verified. Reported as such in the stage 2b-1 report.
