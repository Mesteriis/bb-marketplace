# Remote Hub RDP — Windows NLA/CredSSP manual check

Windows NLA/CredSSP cannot be verified in this repository: there is no Windows
RDP endpoint here, and the xrdp Docker target does not offer NLA (it negotiates
plain TLS security). The engine implements the path through IronRDP (Config
`enable_credssp = true`, `enable_tls = true`). The checks below are run by hand
against a real Windows host; see "Status" for what has been observed and what
has not.

## Reproducible manual scenario

1. On a Windows machine, enable Remote Desktop and set "Allow connections only
   from computers running Remote Desktop with Network Level Authentication".
2. Build the helper: `cd plugins/remote-hub && npm run build:helper`.
3. Run the probe, which starts the real helper through the service code path.
   The password is read from stdin only:

   ```sh
   printf '%s\n' "$PASSWORD" | node --experimental-transform-types scripts/rdp-probe.ts \
     <host> 3389 <username> [<domain>] [--accept-fingerprint <sha256>] [--timeout-s 60]
   ```

   It prints one line per state change, the certificate prompt (fingerprint,
   subject, issuer, validity, reason), the decision it took and the close reason.
   Exit code: 0 `desktop_ready`, 2 `auth_failed`, 3 anything else. Without
   `--accept-fingerprint` a certificate prompt is rejected; with it, the prompt is
   accepted once only when its fingerprint is exactly that one (nothing is
   persisted).

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

Verified by the coordinator on 2026-11-18 against a real Windows host with the
probe (production helper, three runs):

- **NLA success**: `connecting`, `tls`, `authenticating`, `desktop_ready`
  1280x800, then closed `killed_by_close` (a disconnect, no logoff). Verified.
- **Wrong password → `auth_failed`**: `authenticating`, then closed
  `auth_failed`, exit 2. Verified; the password literal is in no output.
- **Strict TLS on an untrusted root**: `cert_prompt` with reason
  `untrusted_root`, the fingerprint, issuer and validity; with nothing accepted
  the session closes `cert_rejected`; accepting that exact fingerprint once
  continues to `desktop_ready`. Verified.

Still NOT verified against a live Windows host: pinning across runs ("Trust for
this BB run" and the auto-accept of the same fingerprint), `cert_changed` after
the server certificate is replaced (covered against xrdp in
`tests/integration/rdp-service.test.ts`, case 6b), mouse and keyboard input, and
resize.

A certificate with an EMPTY subject (names only in its SubjectAltName, as some
Windows certificates do) is shown as `(empty subject) SAN: DNS:<first name>`; the
issuer is shown as it is.
