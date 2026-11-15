# BB feature request (draft, not filed): who answered a plugin interaction

Status: draft text for the maintainer. Nobody has posted it. Filing it is an
external post: the maintainer files it, or tells the builder to.

---

**Title:** Plugin interactions: tell the plugin whether a person in the app answered

**SDK version:** `@get-bb/plugin-sdk` 0.6.132, BB 0.49.

## What we need

A host-verified marker on the answer of a `bb.ui.requestInput` form that says
the value came from a person using the BB app (the plugin's
`pendingInteraction` component submitted it), and not from
`bb thread interactions respond` or another API caller. For example:

```ts
type PluginInteractionResult =
  | { outcome: "submitted"; value: JsonValue; answeredBy: "app" | "cli" | "api" }
  | { outcome: "cancelled"; reason: PluginInteractionCancelReason };
```

and the same field on the value `describeSubmission` receives, so a plugin can
decide before the row is persisted.

An alternative that solves the same problem: an option on `requestInput`
(say `answerableFrom: "app"`) that makes BB refuse answers from the CLI and
the HTTP API for that form.

Either way, no patch from us: this is a request for the host to decide the
shape.

## Why

Makosh Mail lets an agent propose an email. The agent's tool opens a
confirmation card in its thread (`requestInput` with a `pendingInteraction`
renderer), and the mail is sent only after the owner presses Send on that
card. The card shows every recipient, flags new and agent-added addresses,
and waits 1.5 s before Send works.

Today the plugin cannot tell the owner's click from an agent that answers its
own card. An agent whose thread has shell access to the BB server can run:

1. `bb thread interactions show --self` to read the form;
2. `bb plugin rpc call makosh-mail proposal_view …` to get the card's
   one-time view token (an owner-only RPC, but `client` callers are the
   owner from the plugin's side);
3. `bb thread interactions respond --self --value …` to submit Send.

The plugin's own surfaces cannot confirm a proposal, and those commands show
in the thread's command log, but nothing in the plugin can stop them. We
accepted this limit with mitigations (off by default, a 10-second Undo with
a toast, an Outbox, caps). With a host-verified "answered in the app" marker,
the plugin would refuse a Send that did not come from the app, and the
confirmation would mean what the owner thinks it means.

The same marker would help any plugin that asks a person to approve an
action an agent requested: payments, deploys, deletions, messages.

## What it must not do

- It must not be settable by the answering caller (a field in the submitted
  value is not enough).
- It should not reveal more about the person than "the app", so plugins
  cannot use it to track who answered.
