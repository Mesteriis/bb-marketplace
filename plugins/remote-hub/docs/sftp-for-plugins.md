# SFTP for other plugins

Remote Hub lets another BB plugin work with files on a saved SSH connection, by the owner's grant. The plugin never
gets a password, a key, a key path, a credential reference or a Keychain item name: Remote Hub's helper starts
`/usr/bin/ssh` with the `sftp` subsystem itself and the plugin talks to Remote Hub over plugin RPC.

- Plugin id: `makosh-remote-hub`.
- Contract (zod schemas, limits, refusal codes, events): [`src/core/sftp-contract.ts`](../src/core/sftp-contract.ts).
- Since version 0.2.0.

## Calls

Every call answers only a caller the host reports as a plugin (`experimental_caller.kind === "plugin"`), and acts for that
plugin id. An input has no field that names a plugin. Any other caller gets `caller_not_plugin`.

| Call | What it does |
| --- | --- |
| `hub_sftp_profiles` | The saved SSH connections without secrets, with this plugin's consent, level and a host-key hint. |
| `hub_sftp_request_access` | Puts a request (`read` or `write`, an optional reason of at most 200 characters) in front of the owner. Grants nothing. |
| `hub_sftp_grants` | What this plugin holds, asked for or lost. |
| `hub_sftp_open` | Opens a channel: `{ channelId, generation }`. At most 4 channels per plugin. |
| `hub_sftp_op` | One operation on a channel: `list`, `stat`, `realpath`, `read` need `read`; `write`, `mkdir`, `rename`, `remove` need `write`. |
| `hub_sftp_close` | Closes the plugin's own channel. |

Data travels in the RPC itself: a read returns and a write carries at most 4 MiB, as canonical base64. A path is
`{ text }` when it is valid UTF-8 and `{ bytes }` (base64 of the raw bytes) when it is not. Sizes and offsets are
decimal strings (unsigned 64-bit). A listing is paged (1000 entries a page, 10 000 entries a directory) in byte order of
the names, with an opaque cursor.

Writes are stateless: each chunk says how the file is opened (`exclusive`: must not exist; `truncate`: created or
emptied; `existing`: must exist, written at `offset`). `rename` with `overwrite: true` is an atomic replace and needs the
server's `posix-rename@openssh.com` extension; without it the answer is always `unsupported`. `remove` takes one file or
one empty directory.

## Grants

Only the owner grants, declines and revokes, on the Remote Hub page ("Plugin access" in the sidebar menu, and a notice
shown anywhere in BB while a request waits). A grant is (plugin, connection, level), has no expiry and survives a
restart; channels do not. A revoke ends that plugin's channels to that connection at once: the next call is
`consent_revoked`. Every open and every operation checks the grant again.

## Host keys

A host key is the owner's decision for every kind of sign-in. Remote Hub never passes `StrictHostKeyChecking=no` or
`accept-new`.

- A connection with a saved password or key passphrase is checked against the host keys the owner confirmed in Remote
  Hub. An endpoint that is not there is refused before ssh starts (`host_key_unknown`); a different key ends the
  connection (`host_key_changed`). ssh reads no configuration file (`-F none`).
- A connection without a saved secret (the SSH agent, or a key without a passphrase) runs with the user's own ssh
  configuration and known_hosts, with `BatchMode=yes` and `StrictHostKeyChecking=yes` on the command line (which wins over
  the configuration), `UpdateHostKeys=no` and no shared master connection. ssh asks nothing; a key that is not in the
  user's files refuses the channel. The owner confirms such a key by opening the connection in Remote Hub.

`hostKey` in `hub_sftp_profiles` is a hint read from those files (`trusted` or `unknown`); ssh decides when a channel
opens. Reading it runs no program and evaluates no configuration.

## Refusals

A refusal is `experimental_PluginRpcRefusal` whose message starts with a stable code and `": "`, followed by a fixed
sentence. Nothing ssh, the helper or the Keychain wrote is passed on. The codes and their classes are `SFTP_REFUSALS` in
the contract. Two of them describe a lost channel:

- `channel_closed`: the request was not sent. Opening a new channel and repeating is safe.
- `outcome_unknown`: a changing request was sent and the channel ended before the answer. Remote Hub does not repeat it.

`agent_unavailable` means a connection that signs in with the SSH agent was refused and no agent socket is there.
The agent is the one ssh itself would use for that host: an `IdentityAgent` in the owner's `~/.ssh/config` (1Password,
Secretive) wins over `SSH_AUTH_SOCK`, so Remote Hub looks at that socket when it names the refusal. It reads the
configuration as text, with its `Include` files (nested up to 16 deep, at most 64 files, inside `~/.ssh`), and runs
nothing. When the text cannot settle which agent applies (a `Match` block, an unknown `%`-token or `~user`, an Include it
will not follow) it does not claim the agent is missing: the refusal is `auth_failed`. Remote Hub does not override the
owner's configuration.

**Unknown codes.** The set of codes grows. A client treats a code it does not know as `failure` (an internal failure of
the operation) and keeps the message only for a log, never for a decision. The class of a refusal (`forbidden`,
`not_found`, `conflict`, `invalid`) always stays one of those four.

`keychain_unavailable` (new in Remote Hub 0.2.2; 0.2.1 answered `failure` in this case) means the saved credential could not be read because the Keychain or Credential Vault could not
be reached at all (as opposed to `keychain_locked` and `keychain_needs_approval`, which the owner can fix with an unlock
or Allow access).

## Events

On the realtime channel `remote-hub.sftp`, identifiers only: `{ type: "sftp.consent", profileId, state }` and
`{ channelId, state }` with `open`, `closed`, `revoked` or `hostkey_changed`.

## What is recorded

The agent activity list also records a plugin's request and open (with the outcome code), every changing operation by
its name and outcome, and the owner's grant and revoke. A path, a file name or file contents are never recorded.

## Limits

- A plugin with a `write` grant can change and delete what the saved user can on that server. The grant is the power to
  act as that user over SFTP.
- No recursive operation, no chmod/chown/utimes, no symlink creation, no resume token: a transfer is the plugin's own
  sequence of chunks.
- A password connection without a saved password cannot open a channel (`credential_missing`).
- A channel is one ssh process; the helper holds at most 16.
