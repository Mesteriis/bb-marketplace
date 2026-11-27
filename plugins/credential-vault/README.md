# Credential Vault

Credential Vault runs on the macOS machine hosting the BB server. It stores
credential values encrypted with AES-256-GCM in the plugin's SQLite database.
The DB stores each plugin ID and reference as metadata. Use an opaque reference
and put sensitive labels, usernames and bindings inside the encrypted value.
A fresh nonce is generated for every write. Authentication binds the encrypted
value to its vault, plugin ID and reference.

Each DB gets one randomly generated key in the default macOS Keychain. A
background service opens the vault once when the plugin loads. An unlocked
Keychain may ask for access to that key. When the vault is open, later requests
use the key held in memory. If access is declined or Keychain is unavailable,
Settings → Credential Vault shows the state and provides a retry. The helper checks the default
Keychain with prompts disabled and never creates or resets a Keychain. If the
key of an existing database is missing, restore the matching Keychain item from
backup. Disabling or reloading the plugin discards the in-memory key.

## Import a saved password

Open **Settings → Credential Vault → Импорт секретов**. Select the source and a
Remote Hub profile that uses password authentication.

- **macOS Keychain** migrates the selected profile's existing Remote Hub
  record. macOS may ask to approve reading that legacy item. The original is
  kept for rollback.
- **1Password** reads the selected password field using its `op://` reference.
  Install 1Password CLI and enable the desktop app's CLI integration under
  **Settings → Developer**. Confirm the request there if prompted. The import
  leaves the 1Password item in place and asks for explicit approval before
  replacing an existing Remote Hub password. Passwords shared by multiple
  profiles are excluded from replacement to protect the other profiles.

The receiving plugin checks that the selected profile is still current,
applies its credential binding rules, and verifies that the new record can be
read. The settings page receives a success receipt and does not see the
password. Subsequent connections read the saved value from Credential Vault.

## Backend API

Use `bb.sdk.plugins.callRpc` on the server with the plugin ID
`makosh-credential-vault`. These experimental methods accept a reference of up
to 200 characters and a nonempty secret of up to 131,072 characters.

- `experimental_put` takes `{ ref, secret }` and returns `{ stored: true }`.
- `experimental_put_if_absent` takes `{ ref, secret }` and reports whether an
  existing value was left intact or a new value was stored.
- `experimental_get` takes `{ ref }` and returns `{ secret }`. The value is null
  when the calling plugin has no such entry.
- `experimental_remove` takes `{ ref }` and returns `{ removed }`.

The namespace comes from BB's server-side caller identity. Clients cannot use
these methods. The return value is plaintext inside the calling plugin's backend.
Pass it directly to the intended consumer and keep it out of logs, UI, agent
results and transport metadata. This is an API boundary between integrations.
BB plugins with native process or filesystem access run with the server user's
rights.

Remote Hub uses this API to migrate saved passwords on demand. Its security
documentation describes the legacy originals kept for rollback.

## Building and testing

Run `npm ci`, `npm run check` and `npm run build`. The test suite uses Bun.
The native helper source is under `native/`. Run `npm run build:helper` on macOS
to rebuild it. The universal executable is bundled so installation does not need
Xcode. Keep the helper binary byte-identical across JavaScript-only releases.
A changed ad-hoc signature can require macOS to grant access to the vault key
again. To preserve the authorization across native helper updates, release those
updates with a stable code-signing identity.
