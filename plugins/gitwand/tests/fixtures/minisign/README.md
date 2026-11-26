Test vectors for minisign verification. Made with OpenSSL 4.1 (Ed25519,
BLAKE2b-512), independently of the plugin's code, from a throwaway key whose
secret half was deleted after signing. `channel.json.minisig` is prehashed
(`ED`), `channel.json.legacy.minisig` signs the raw file (`Ed`). Key id
`0102030405060708`. Never trust this key outside tests.
