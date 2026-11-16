# Makosh AI

Makosh AI gives loaded BB plugins a server-side RPC for the Claude Messages and
Codex Responses APIs. Inference runs inside the existing Account Pooler, using
its accounts, quota rules, affinity and failover. Installations need a BB build
with the [Account Pooler bridge](../../patches/README.md).

## API

Call these methods with `bb.sdk.plugins.callRpc`, using `pluginId: "makosh-ai"`.
BB identifies the calling plugin. Only that plugin can read or cancel its stream.

- `ai.v1.start` accepts `{ providerId, body, conversationId?, anthropicBeta? }`
  and returns `{ streamId }`. The body is the provider-native JSON request.
  Use `claude-code` for `POST /v1/messages` or `codex` for
  `POST /v1/responses`. Claude accepts `body.stream: true` for SSE or a
  regular JSON response. Codex always uses SSE with `stream: true` and
  `store: false`. `anthropicBeta` sets the Claude beta header when needed.
- `ai.v1.read` accepts `{ streamId, cursor }`. Start with cursor `0`. A
  `chunk` includes the next cursor, the HTTP status, content type and
  base64-encoded bytes. Advance after consuming the chunk. On retry the
  previous cursor replays the last chunk. A `pending` reply means to read
  again with the same cursor. A `done` reply marks the end of the HTTP body
  and includes status and content type. A `failed` reply reports a transport
  error. Check the HTTP status and provider events as well as the RPC state.
- `ai.v1.cancel` accepts `{ streamId }` and returns `{ cancelled }`.
  Cancel when the caller stops consuming, including after a terminal read, to
  release its slot immediately. Aborting one read leaves the stream available
  for retry.
- `ai.v1.providers` accepts `{}` and returns `{ providers: [{ id,
  displayName, apiFormat, available, reason? }] }` for every provider the
  bridge can route: `claude-code` with `apiFormat: "anthropic-messages"` and
  `codex` with `apiFormat: "openai-responses"`. `available` comes from one
  no-op bridge call. `false` carries `reason: "bridge_missing"` or
  `"pool_missing"`. `true` means the bridge answered. Account readiness for a
  provider is checked when a stream starts; an unusable pool returns HTTP 503
  in the stream.
- `ai.v1.models` accepts `{ providerId, projectId? }` and returns
  `{ models: [{ model, displayName }] }` from BB's
  `bb.sdk.providers.models`. With `projectId` it is that project's catalog.
  Without it BB returns the provider's catalog outside any project, which the
  SDK allows. This is BB metadata, outside the inference transport.

Read chunks as bytes. A single SSE event or UTF-8 code point may span chunks.
The bridge limits a request body to 8 MiB, caps concurrent streams at 8 per
plugin and 64 overall, and expires streams after two minutes without reads.
The upstream request has a ten-minute deadline.

## Errors

Refusals keep the SDK codes `conflict`, `forbidden`, `invalid` and
`not_found`. The message starts with a stable reason and `: `, followed by
human text that may change. Match `^([a-z_]+): ` and switch on the reason.

| Reason | Code | Meaning |
| --- | --- | --- |
| `forbidden_caller` | `forbidden` | The caller is not a BB plugin server. |
| `bridge_missing` | `conflict` | Account Pooler has no Makosh bridge. |
| `pool_missing` | `not_found` | Account Pooler is not loaded. |
| `busy` | `conflict` | The stream limit is reached. Cancel open streams or retry later. |
| `stream_lost` | `not_found` | The stream expired, was cancelled or belongs to another plugin. |
| `bad_cursor` | `conflict` | The read cursor is neither the current nor the previous one. |
| `too_large` | `invalid` | The request body exceeds 8 MiB. |

A `not_found` without a reason prefix comes from BB before Makosh AI runs,
which means `makosh-ai` itself is not loaded. Input that fails the schema is
`invalid_input` from the SDK. Other pool refusals pass through unchanged.
Callers that only check the code keep working.

## Continue a conversation

The calling plugin owns the history. For the next turn, send prior messages or
response items plus the new input in `body.messages` (Claude) or `body.input`
(Codex). Include provider-native tool results or replayable reasoning items
when the model returns them. Reuse the same optional `conversationId` to let
Account Pooler prefer the prior account for that plugin's dialogue. The pool
can still select a different account when required. Makosh AI keeps no thread
history. Codex stored responses, item references and background mode are
outside this contract.

## Start a streamed call

```ts
import { z } from "zod";

const { streamId } = await bb.sdk.plugins.callRpc({
  pluginId: "makosh-ai",
  method: "ai.v1.start",
  input: {
    providerId: "claude-code",
    conversationId: "example",
    body: {
      model,
      max_tokens: 1024,
      stream: true,
      messages: [{ role: "user", content: "Write a short greeting." }],
    },
  },
  outputSchema: z.object({ streamId: z.uuid() }),
  signal,
});
```

The pool checks that routing is enabled and that it can serve the provider.
A missing bridge fails the RPC. A disabled or unavailable route returns an
error from the pool. The inference path has no BB thread dispatch, local
account lookup or separate API keys.
