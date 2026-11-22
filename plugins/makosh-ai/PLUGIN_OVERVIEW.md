## Provider APIs for BB plugins

Call Claude Messages and Codex Responses from a server-side BB plugin. Stream
provider-native output and continue a dialogue by replaying its history.
Inference uses existing accounts and quota routing through a versioned bridge
in BB's built-in Account Pooler. Makosh AI installs the bridge itself when it
is missing, for example after a BB update, on a BB backend outside a signed
app bundle, and reloads Account Pooler.
List the routable providers and their API formats, read BB model catalogs,
and handle refusals by a stable reason.
