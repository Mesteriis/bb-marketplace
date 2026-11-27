## Credential Vault

BB plugins can save and retrieve credentials from encrypted SQLite storage on macOS. Each plugin can access only its own entries through the server RPC API. Settings → Credential Vault shows whether the store is ready and lets you retry access after unlocking Keychain.

One master key lives in macOS Keychain. Credential values are encrypted before they enter SQLite. Keep the database and its Keychain key together when backing up the installation.

## Import a saved password

In Settings → Credential Vault, choose Keychain or 1Password and a Remote Hub password profile. Confirm replacements explicitly. The original source item is retained.
