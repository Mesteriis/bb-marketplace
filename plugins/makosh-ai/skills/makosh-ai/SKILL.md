---
name: makosh-ai
description: Stream Claude Messages and Codex Responses from a BB plugin through Account Pooler.
---

Use the calling plugin's server-side `bb.sdk.plugins.callRpc` with plugin ID
`makosh-ai`. Submit provider-native JSON to `ai.v1.start`, read encoded byte
chunks with `ai.v1.read` starting at cursor zero, and release the slot with
`ai.v1.cancel`. Reuse a conversation ID and replay history to continue a
dialogue. Call `ai.v1.providers` to list providers, their API formats and
bridge availability. Refusal messages start with a stable reason such as
`busy:` or `stream_lost:`. See the plugin README for schemas, stream
semantics and the reason table.

Inference requires a BB build with the Account Pooler model bridge. Use
the existing accounts configured in that pool. After a BB update, review
bridge compatibility before deploying the updated build.
