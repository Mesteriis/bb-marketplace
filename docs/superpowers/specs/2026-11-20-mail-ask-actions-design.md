# Makosh Mail: Ask AI with actions — design

Date: 2026-11-20. Status: approved in advance (the owner, 2026-11-19:
"Завершай все что наметили"). The decisions below are the builder's and
are listed in the final report. Fifth of nine projects that bring
Superhuman Mail's features to Makosh Mail.

## Intent

Superhuman's Ask AI answers a question about the mailbox and then does
something with the answer: shows the messages, drafts the reply, archives
what was found. Makosh Mail's Ask answers with cited messages and stops
there.

## Goals

Under an answer the owner sees up to three buttons the model proposed.
Nothing happens until one is pressed.

- **Show these messages** — a Mail search the model wrote; pressing runs
  it in the search box.
- **Reply with this** — a reply to one of the cited messages with text the
  model drafted; pressing opens an ordinary reply with the text in it.
- **Write this message** — a new message with drafted text; the owner adds
  the recipients.
- **Archive / Mark read / Flag N messages** — over cited messages that are
  in the Inbox; pressing runs the ordinary action, with its Undo.

## Non-goals

- Web search: the plugin has no web tool and Makosh AI offers text
  generation only; it needs an outside service and the owner's decision.
- Calendar actions (calendar is out of scope).
- Delete, spam, send, forward, move to a folder: never proposed.
- Actions without a click.

## Anti-goals

- An email among the excerpts causing an action: every action is a button
  with a plain label and a count, run by the owner, undoable; the drafted
  text passes the link rule of AI writes mail (a link or address the
  owner did not write in the question is removed).
- A proposed search that leaves AI access: it is the owner's own search
  box, run as the owner would.
- Message ids, addresses or raw model output in the action: the model
  names cited messages by number only; the server maps them.

## The answer

The second Ask call's task gains: `"actions"`, at most 3, each one of

- `{"type":"search","query":"..."}` — at most 200 characters, one line;
  kept only when Mail's parser reads it without a note;
- `{"type":"reply","message":n,"paragraphs":["..."]}` — n one of the
  excerpts; paragraphs at most 4 000 characters in all;
- `{"type":"compose","paragraphs":["..."]}`;
- `{"type":"act","action":"archive"|"mark_read"|"flag","messages":[n]}` —
  at most 20 numbers, each one of the excerpts.

Anything else is dropped and counted. With `found` false no action is
kept. The poll answer carries the actions as the page needs them: the
search query; for a reply the message id, account and conversation; for
`act` the message ids grouped by account, only those now in an Inbox
(an action left without messages is dropped).

## Page

The Ask panel shows the buttons under the answer and its sources, with
"AI can be wrong; check before you act." A pressed action button is
disabled afterwards. An `act` says what it did through the ordinary Undo
toast.

## Testing

The parser by example (every kind, the limits, numbers out of range, a
query with a note, links removed); the server view (ids mapped, non-Inbox
messages left out); the panel with fake ports; the canary test still
passes.
