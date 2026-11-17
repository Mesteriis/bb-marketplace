# Mail slice 3k: OpenPGP

Date: 2026-11-17. Built in one session, on the owner's word: "start 3k",
"you can generate the keys yourself, I have none", and "better: key
generation right from the interface". There was no separate design round;
this file records what was decided and built.

## Owner's decisions

1. **Scope: OpenPGP (backlog #92).** Signing, encryption, checking and
   opening. Keys are made in Mail's own interface.
2. **S/MIME (#97) stays recognised only.** It needs a certificate issued by
   a certificate authority; a self-made one is not trusted by the people the
   owner writes to. Decided by the builder; the owner may reopen it with a
   certificate.
3. **New dependency: `openpgp` 6.3.2, LGPL-3.0-or-later.** The owner was
   told 3k needs new dependencies and said to start. The license differs
   from the plugin's MIT: the notice says how the bundle is rebuilt from
   the npm package. The owner should confirm this before publishing.

## Rules the code holds

- A private key is stored sealed by the vault (`pgp_keys.private_sealed`),
  read by `pgpPrivateSealed` alone, unsealed in `pgp-service.ts` for one
  operation, and leaves the server only as a backup locked by a passphrase
  the owner types (`pgp_cert_export` with `phrase`, at least 8 characters).
- Decrypted text is returned by `pgp_open` to the owner's page and lives in
  `PgpPanel`'s state for that view. It is never stored, indexed, logged,
  sent on realtime, or given to an agent, a model, the CLI or BB. Slice 3i
  already keeps an encrypted body out of the store.
- All nine `pgp_*` methods refuse another plugin first; none is a tool or a
  CLI command; mail an agent proposes is never signed or encrypted
  (`queueSend` refuses `protect` unless the origin is the owner).
- Encrypt refuses Bcc, needs a saved, unexpired key for every To and Cc
  address, and always encrypts to the sender's own key too.
- A key is made only for an address the account sends from; one own key per
  address. A pasted public key is a contact key even when the armor holds a
  private half; a pasted private key (a backup) becomes an own key only
  with its passphrase. Revoked keys are refused.
- Saved keys are trusted because the owner saved them. No network lookup of
  keys (no WKD, key servers or Autocrypt).
- Logs: `pgp open <id>: <state>`, `pgp verify <id>: <state>`, and fixed
  lines for key changes. Never an address, a fingerprint, a subject or text.

## What was built

- `src/core/pgp.ts` (the engine port), `src/core/pgp-mime.ts` (PGP/MIME
  wrapping and extraction on raw bytes), `src/adapters/bb/pgp-openpgp.ts`
  (the engine on openpgp.js, Curve25519 keys), `src/adapters/bb/pgp-service.ts`.
- Store: migration element 15 (`pgp_keys`), pinned as `MIGRATIONS.slice(0, 16)`.
- Contract: `pgp_certs_list`, `pgp_cert_generate`, `pgp_cert_import`,
  `pgp_cert_import_message`, `pgp_cert_remove`, `pgp_cert_export`,
  `pgp_check`, `pgp_verify`, `pgp_open`; `compose_send` gains `protect`.
- UI: Mail settings tab "Encryption (OpenPGP)" (`pgp-settings.tsx`), Sign
  and Encrypt in the composer, Decrypt and Check signature in a message
  (`pgp-panel.tsx`). Russian texts for all of it.

## Not done

- Attachments inside an encrypted message are listed by name, not opened.
- Decrypted mail is shown as plain text (an HTML-only body is converted).
- Clear-signed text (inline signatures) is not checked.
- No key rotation, revocation, expiry setting, or publishing of the key.
- No review by a second pass; no rendered preview; not tried against
  another mail program on real mail. The live check should send a signed
  and an encrypted message to a correspondent who uses GnuPG or
  Thunderbird, and open one from them.
