---
name: credential-vault
description: Integrate a BB plugin with Credential Vault, migrate existing secrets safely, and troubleshoot access in BB settings.
---

## When to use this skill

Use this when a BB plugin on macOS needs to store, retrieve, rotate, delete,
or migrate a password, token, or key passphrase. Find the consumer's existing
credential adapter and call Credential Vault from that plugin's server.
Credential Vault owns encrypted storage. The consumer still owns the meaning
of each credential, its destination binding, and who may use it.

## Integration

1. Use the installed SDK declarations and mirror the consumer's existing RPC
   conventions. Call `bb.sdk.plugins.callRpc` with
   `pluginId: "makosh-credential-vault"`, the method, its input, a Zod
   `outputSchema`, and the caller's abort signal when available.
2. Keep one opaque, stable `ref` per credential. BB derives the namespace from
   the authenticated calling plugin ID. Changing that ID changes which
   credentials the plugin can read. Use a versioned envelope for secrets with metadata such as a host, username
   or certificate binding. Vault encrypts the entire envelope.
3. Resolve secrets only when a backend operation needs them. Validate the
   binding before use. Pass plaintext directly to the consumer and keep it out
   of logs, traces, UI state, agent tool results, command arguments, and
   environment variables. The browser, CLI and agents have no secret-read RPC.

| Method | Input | Output |
| --- | --- | --- |
| `experimental_put` | `{ ref, secret }` | `{ stored: true }` |
| `experimental_put_if_absent` | `{ ref, secret }` | `{ stored: boolean }` |
| `experimental_get` | `{ ref }` | `{ secret: string \| null }` |
| `experimental_remove` | `{ ref }` | `{ removed: boolean }` |

The reference can be 1–200 characters and the secret 1–131,072 characters.
For example, a server adapter reads a credential as follows.

```ts
const { secret } = await bb.sdk.plugins.callRpc({
  pluginId: "makosh-credential-vault",
  method: "experimental_get",
  input: { ref },
  outputSchema: z.object({ secret: z.string().nullable() }),
  signal,
});
```

A successful `secret: null` means the caller has no entry for that reference.
An RPC error means the store could not answer. Report the error without secret
content and stop the credential operation. The owner can verify readiness or
retry access in **Settings → Credential Vault**. The settings section has no
master-key reset or recovery action.

## Migration

1. Preserve the reference and the original binding. On a successful Vault
   miss, read the legacy item through its existing authorized path.
2. Insert it with `experimental_put_if_absent`, then read and validate the
   Vault record before switching or removing any legacy data. If insertion
   reports `stored: false`, a record already exists. Preserve it and validate
   it as the authoritative record.
3. Keep legacy items until successful migration is verified. If there is a
   legacy fallback, record deletion in the new store or retire the source so
   that a deleted credential cannot be reimported. A Vault error must never
   trigger legacy fallback.
4. Test with synthetic secrets. Cover retrieval under the same plugin ID,
   rejection of other callers, a missing or unavailable Vault, retrying a
   partial migration, retention of bindings, and reconnecting after migration.

Remote Hub's implementation is in
`plugins/remote-hub/src/adapters/bb/vault-bridge.ts` and
`plugins/remote-hub/helper/src/keychain.rs`.


## Let owners import into a plugin

For Remote Hub, an owner can use **Settings → Credential Vault → Импорт секретов**.
Keychain migration accepts a previously saved profile. 1Password import accepts
an `op://` field reference and uses the desktop app's CLI integration.

When adding a new recipient, give Credential Vault a backend-only list of
eligible targets and an import operation. Restrict both to the authenticated
Credential Vault caller. Return opaque IDs and current revisions, check those
again at save time, require explicit overwrite consent, and reject updates
that unexpectedly change shared credentials. Use the recipient's regular
binding and persistence path. Return only a receipt to the settings UI.
