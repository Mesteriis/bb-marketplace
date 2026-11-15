# Makosh Mail — slice 3d: sending polish (signatures, aliases, pre-send check, undo, templates)

Status: decisions made by the owner (2026-11-15); this document is the
builder's design for review. It follows 3a (organize and read), 3b (write and
send) and 3c (agent proposals and translation), all shipped on
`feat/mail-imap-slice`. Everything in the slice-1, slice-2, 3a, 3b and 3c specs
holds unless this document changes it, and their "Resolutions" sections are
the binding form (3c resolutions 1–29 included). Backlog:
`docs/mail-feature-backlog.md` items 24, 33, 45, 55 and 61.

Points the builder could not verify are marked **[unverified]** and collected
in "Not verified" at the end. "Open questions for the owner" lists the places
that need an owner call. Each has a recommendation, and the design below
follows it.

## Owner's decisions

Recorded verbatim (2026-11-15).

1. **Signatures per account and per alias**, placed **above the quote** in replies and forwards (Gmail/Apple Mail style); new messages get it at the end. Agent-proposed mail (mail_propose) gets the signature too, and the card shows it (it's part of the hashed content).
2. **Aliases: manual + suggestions.** The owner adds sending addresses (iCloud aliases, Gmail "Send as") in the account's settings; the plugin suggests candidates from addresses that receive mail in that account (To/Cc/Delivered-To of stored inbound mail matching none of the account's known addresses). A reply goes out from the address the original was sent to when that address is one of the account's addresses/aliases.
3. **Pre-send check as a warning with "Send anyway"**: forgotten attachment (text mentions an attachment in RU/EN but none attached), empty subject, a new recipient (never sent to by the owner), in a reply a recipient outside the conversation's prior participants. A dialog lists the issues with Fix / Send anyway; nothing is blocked outright.
4. **Undo last action**: a toast "Undo" and the `z` key revert the last archive / delete / move / spam / not-spam and flag/read changes.
5. **Reply templates**: named canned texts inserted into the editor by name (picker + a shortcut); agents may use them (mail_propose can reference a template by name, its text is inlined and shown on the card).

Also: update docs/mail-feature-backlog.md labels to reflect what slices 3a–3c actually shipped (e.g. undo send, recipient autocomplete, hotkeys, agent send with confirmation, translation, headers/details) and mark 3d items.

## Goals

1. **Signatures.** Each sending identity (an account's own address and each
   alias) has an optional signature: plain text with bold, italic, underline,
   links and line breaks. A new draft gets it at the end; a reply or forward
   gets it between the owner's text and the quote. Changing From swaps it.
   The signature of the owner's own earlier mail is left out of quotes.
2. **Aliases.** An account's settings list its sending addresses. The owner
   adds them by hand or from suggestions. The composer's From offers every
   address of every account that can send. Reply, Reply all and Forward
   start from the address the original came to, when that is one of the
   account's addresses. A provider that refuses or rewrites an alias is
   reported in plain words, at the first send and in the settings.
3. **Pre-send check.** Send (and Cmd/Ctrl+Enter) runs four checks. Any issue
   opens a dialog with **Fix** per issue, **Back to editing** and **Send
   anyway**. The checks never block. The agent card shows the same checks.
4. **Undo the last action.** After archive, delete, spam, not spam, move, or
   a flag or read change, a toast offers **Undo** and the `z` key undoes it.
   Undo works whether or not the change already reached the server. It never
   deletes anything permanently.
5. **Templates.** Named texts the owner writes in settings, inserted at the
   cursor from a picker in the composer or with a shortcut. An agent can list
   them and name one in `mail_propose`; the card shows the inlined text.
6. **Backlog labels** match what shipped and mark the 3d items.

## Non-goals (later or backlog)

- Scheduled send (#52), snooze (#42), read receipts, rules, folder management.
- Template placeholders or variables (`{name}`, dates). Templates are fixed
  text in 3d (Open question 6).
- "Save selection as template" in the composer; templates are written in
  settings only.
- Undo of Send through `z` (the send toast keeps its own Undo, 3b), redo, a
  history of more than one action, undo across a BB restart.
- Restoring other Gmail labels on undo of Delete or Spam (see "Undo:
  limits").
- Verifying that the owner may send from an alias. The plugin cannot; it
  reports what the provider does (Goal 2).
- HTML or images in signatures and templates; per-signature fonts or
  colours; a signature picker separate from From.
- Turning individual pre-send checks off, or a "don't warn again" list.
- Stripping other clients' signatures from quotes (Gmail's `gmail_signature`
  and the like). Only this plugin's own marked signature and the `-- `
  delimited block of the owner's own mail are left out.
- Agents adding or editing aliases, signatures or templates.
- Changes to BB.

## Anti-goals

- **Permanent deletion by undo.** Undo issues only MOVE (through the
  existing `canMoveSafely` guard: MOVE or UIDPLUS) and, for one Gmail case,
  COPY. It never sets `\Deleted` itself and never runs EXPUNGE.
- **An undo that lands somewhere else.** Undo acts only on rows that are
  still where the action left them. Anything moved since, by the owner here,
  another client or the server, is skipped and reported.
- **A From the owner did not choose.** No sync, agent or suggestion adds a
  sending address. A reply's From is picked by the fixed rule below and shown
  in the composer and on the card before Send.
- **Hidden signature content.** What the card shows includes the signature,
  and the content hash covers it (decision 1).
- **A check that blocks.** Every check is advisory; a failed check RPC lets
  the send go on.
- **Mail text, addresses, signature or template text in logs**, realtime
  payloads or error texts, as in 3b and 3c.

## Design

### Code and host facts this design relies on

Line numbers are in the current tree (`plugins/mail/…`) unless marked
"host" (BB 0.49.0, `…/runtime/node_modules/bb-app/server/dist/start-server.js`
in the owner's installation) or "imapflow" (2.11.0, installed).

| Fact | Where |
| --- | --- |
| A completed move re-homes the row to the destination with the same row id and the COPYUID uid; without a uid map the row waits detached (`uid` NULL) until the destination's sync reattaches it by Gmail id or Message-ID, keeping its id. | `src/adapters/bb/sqlite-store.ts` 1931–2021, header 19–22; reattach 1251–1264 |
| Reattaching (`updateMessage`) does not touch `move_pending`, so a move queued on a detached row is pushed once it is reattached; `pendingMoves` lists only rows with a uid. | sqlite-store.ts 857–869, 1894–1902 |
| `queueMove` requires every id in one account and one folder with no pending move; it does not look at `uid`. | sqlite-store.ts 1904–1929 |
| `FolderSession.moveMessages` returns the COPYUID map or null; servers without MOVE or UIDPLUS get `MoveUnsupported` and no move. | `src/core/ports.ts` 94–105; `src/adapters/bb/imapflow-gateway.ts` 304–323, 391–398 |
| A whole sync round (pushes, then folder syncs) runs inside the account's write queue; APPEND, expunge and SMTP share it. | `src/adapters/bb/sync-service.ts` 140; `src/adapters/bb/account-queue.ts` |
| `message_action` sets flags with `setDesired` (attached copies get the value to push) and queues moves with `queueMove`, then wakes the account's sync. | `server.ts` 810–918; sqlite-store.ts 1382–1437 |
| The page sends a batch in calls of at most `ACTION_CHUNK` = 200 ids. | `app.tsx` 102–103, 864–905 |
| imapflow `messageCopy(range, destination, {uid:true})` resolves a `CopyResponseObject` with `uidMap` when the server has UIDPLUS. | imapflow `dist/esm/imap-flow.d.ts` 499, `types.d.ts` 735–744 |
| The From header and the SMTP envelope sender are the same address today: `envelopeFrom = message.from.address`, `from` built from `account.email` and `account.displayName`. | `src/core/compose-outbox.ts` 220; `src/core/compose.ts` 680–722 |
| `ownAddresses` (account emails and usernames with `@`) drives Reply all and "reply to own sent mail". | compose.ts 671–674; `src/core/compose-reply.ts` 37–66 |
| A 5xx before DATA maps to `rejected_message`; `command` is known (`MAIL FROM`, `RCPT TO`). | `src/adapters/bb/smtp-transport.ts` 85–107 |
| `addressesSentTo` scans To/Cc of Sent-role rows only, so it knows only mail inside what sync has stored (30-day window by default). | sqlite-store.ts 2693–2712 |
| Sync fetches the whole source and parses its headers (the bulk mark reads them with no extra fetch), so more headers cost no fetch. | imapflow-gateway.ts 523–580 |
| The document schema: paragraphs, lists, blockquote; bold, italic, underline, link; hard break. The renderer emits only whitelisted tags and `href`. Agent bodies use `docFromLines(lines, quote)`. | `src/core/compose-doc.ts` 17–30, 313–319, 340–345 |
| Owner replies quote an HTML original through the page editor (`importHtml(… "quote")`); a text original becomes a blockquote on the server. The attribution lines come from `quoteHeaderText`. | compose.ts 197–208; `src/ui/compose-editor.tsx` 49–60; compose-reply.ts 91–104 |
| BB 0.49.0 default keybindings: Mod+T (new tab), Mod+Shift+T (reopen closed tab), Mod+K, Mod+P, Mod+Shift+P, Mod+N, Mod+J, Mod+W, Mod+[ / ], Alt+M, Alt+P, Mod+1–9 and others; no Mod+Alt+T and no plain `z`. | host 211619–211915 (`DEFAULT_APP_KEYBINDINGS`) |
| Mail page keys today: `j k o u x e s v c r a f t / ?`, Enter, Shift+U, Shift+I, `#`, `!`, `g`-chords; no `z`. | `src/ui/shortcuts.ts` 85–170 |
| SDK 0.6.132: `bb.agents.registerTool` and `configure` | `node_modules/@get-bb/plugin-sdk/bundled-types/bb-plugin-sdk.d.ts` 21227–21251 |

### User flows

1. **Set up a sending address.** Mail settings (gear at the bottom of the
   mail rail) → an account → **Sending addresses**. The list shows the
   account's own address first, then aliases, each with its display name,
   signature and send state. **Add address** takes an address and an optional
   name. **Suggestions** lists candidates with "N messages · last <date>",
   each with **Add** and **Not mine**.
2. **Write a signature.** In the same list, **Signature** under an address
   opens a small editor (bold, italic, underline, link; Enter and Shift+Enter).
   Save applies to new drafts from then on.
3. **Compose.** A new draft from an identity starts with an empty line and
   its signature below a faint `-- ` marker. Reply / Reply all / Forward
   start with an empty line, the signature, then the attribution and quote.
   From shows the identity the rule picked.
4. **Change From.** The composer replaces an unedited signature with the new
   identity's. An edited one stays, with a note "Kept your edited signature ·
   Use <address>'s".
5. **Insert a template.** **Templates** in the composer toolbar, or
   Mod+Alt+T, opens a filtered list; Enter inserts the chosen one at the
   cursor. **Manage templates…** opens settings.
6. **Send with issues.** Send → the draft is saved → `compose_check`. No
   issues: it queues as in 3b. Issues: the "Before you send" dialog. **Fix**
   on an issue closes the dialog and takes the owner to it (the attachment
   picker, the subject field, the recipient row with the chips marked).
   **Send anyway** queues it. **Back to editing** (default focus, Enter,
   Escape) closes the dialog.
7. **Undo.** Archive (or any undoable action) → toast "Archived 3
   conversations · Undo" for 10 s. **Undo** or `z` (within 10 minutes and
   until the next undoable action) brings them back. A toast reports
   "Undone" or "Undone for 5 of 7 messages · 2 were moved elsewhere".
8. **Agent proposals.** The card shows From (the alias with an "alias"
   badge), the body, a "Includes the template «name»" label when used, the
   signature under a `-- ` line, the quote, and a **Before sending** list of
   check results. Send stays as in 3c.

### Data model and migration

Migration element **7** is appended to `MIGRATIONS` in
`src/adapters/bb/sqlite-store.ts`. Elements 0–6 are frozen and keep their SHA
pins in "shipped migration elements are unchanged"; element 7's hash joins
the pin in the docs-and-listing task. As in 3c resolution 17, the new tables
carry no `REFERENCES`; deletes are explicit. Timestamps are ISO TEXT.

```sql
-- the signature of the account's own address (NULL = none)
ALTER TABLE accounts ADD COLUMN signature_json TEXT;

-- the account's other sending addresses, and dismissed suggestions
CREATE TABLE identities (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  address TEXT NOT NULL,            -- lower case, domain in ASCII (punycode)
  display_name TEXT,                -- NULL: the account's display name
  signature_json TEXT,              -- NULL: none
  state TEXT NOT NULL,              -- 'active' | 'dismissed' (a suggestion the owner refused)
  send_check TEXT NOT NULL DEFAULT 'unknown',
                                    -- unknown | accepted | pending | confirmed | rewritten | refused
  check_message_id TEXT,            -- the send whose Sent copy decides 'pending'
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX identities_account_address ON identities(account_id, address);

-- the draft's sending address; NULL = the account's own address
ALTER TABLE compose_drafts ADD COLUMN from_address TEXT;

-- Delivered-To and X-Original-To addresses of synced mail; NULL = not known
-- (synced before element 7)
ALTER TABLE messages ADD COLUMN delivered_to_json TEXT;

-- the template a proposal inlined, for the card's label only
ALTER TABLE agent_proposals ADD COLUMN template_name TEXT;

CREATE TABLE templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  name_key TEXT NOT NULL UNIQUE,    -- NFKC, trimmed, lower case
  doc_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- addresses the plugin sent to (SMTP accepted), so "never sent to" outlives
-- the sync window
CREATE TABLE sent_recipients (
  account_id TEXT NOT NULL,
  address TEXT NOT NULL,            -- lower case
  last_sent_at TEXT NOT NULL,
  PRIMARY KEY (account_id, address)
);
```

- `deleteAccount` also deletes the account's `identities` and
  `sent_recipients` rows; store tests pin it. Templates are not per account.
- The account's own address is not a row in `identities`: `accounts.email`,
  `accounts.display_name` and `accounts.signature_json` describe it, so the
  primary address keeps one source of truth.
- An address may be active on one account only, and never equal to any
  account's own address or username. `identity_add` checks it in the insert
  transaction (`conflict`, "This address belongs to <account>").
- `delivered_to_json` is filled by sync from the parsed headers
  (`Delivered-To`, `X-Original-To`, every occurrence, addresses only,
  lower-cased, at most 10). Rows synced earlier stay NULL; suggestions then
  use their To and Cc only. No backfill: the field only feeds suggestions.
- `sent_recipients` gets every accepted envelope recipient (To, Cc and Bcc)
  when an outbox row moves to `sent`, in the same transaction.
- Caps: 50 active identities per account; 200 templates; signature JSON
  ≤ 16 KiB and ≤ 2 000 visible characters; template JSON ≤ 32 KiB and
  ≤ 10 000 characters; template name 1–80 characters, one line.

### The signature in the document

`src/core/compose-doc.ts` gains one top-level block:

```ts
export type ComposeSignature = { type: "signature"; content: ComposeParagraph[] };
// ComposeDoc.content: (ComposeBlock | ComposeSignature)[]
```

- **Normalization.** `normalizeDoc` keeps at most one `signature`, and only
  at the top level. A second one, or one nested in a list or quote, is
  flattened into ordinary paragraphs with its text kept (3b resolution 5's
  rule). Inside it only paragraphs survive; a list or quote inside becomes
  paragraphs. An empty `signature` (no paragraphs, or only empty ones) is
  kept: it is the placeholder that lets From swap in a signature later.
- **Rendering.** An empty signature renders nothing. A non-empty one renders
  as HTML `<div class="makosh-signature"><p>-- </p>…paragraphs…</div>` and as
  text: a blank line, the line `-- ` (dash dash space, the Usenet delimiter
  that mail clients use to tell a signature apart), then its lines with no
  blank lines between paragraphs. The `class` is a fixed string the renderer
  writes; the page never supplies attributes.
- `isDocEmpty` ignores the signature, so a draft holding only its signature
  still counts as empty (the composer's close-without-saving rule).
- **Stored signature format.** `SignatureDoc = { type: "doc", content:
  ComposeParagraph[] }`, validated by `normalizeSignature(input)` (new, in
  `src/core/compose-signature.ts`): `composeDocInputSchema` bounds, then
  `normalizeDoc`, then lists and quotes flattened to paragraphs, then the
  caps. A first line that is exactly `--` or `-- ` is dropped, so the
  delimiter is never doubled. Links follow the renderer's protocols (http,
  https, mailto).

**Placement** (`withSignature(doc, signature, kind)`, pure, in
`compose-signature.ts`). Every draft created from 3d on carries exactly one
signature block, empty when the identity has none:

| Draft | Document |
| --- | --- |
| New (`planNew`) | `[p(""), signature]` |
| Reply, reply all, forward, owner (`planCompose`) | `[p(""), signature, attribution paragraphs…, quote]`. With an HTML original the quote is still imported by the page at the end, so the signature sits above the attribution and the quote. |
| Agent proposal (`createProposal`) | `docFromLines(body lines + template lines, quote)` with the signature inserted before the trailing blockquote, or at the end for a new message |

Drafts made before 3d and drafts continued from another client have no
signature block; From changes leave them alone.

**Swap on From change** (`swapSignature(doc, previous, next)`, pure, in
`compose-signature.ts`; the composer applies the result through the editor):

- No top-level signature block → unchanged.
- The block is empty, or its normalized content deep-equals `previous` →
  replaced by `next` (empty when the new identity has none).
- Otherwise (the owner edited it in this draft) → unchanged, result `kept`.
  The composer shows "Kept your edited signature" with **Use <address>'s**,
  which replaces it anyway.

**Editor.** `src/ui/signature-node.ts` defines a TipTap node with
`Node.create` from `@tiptap/core` (already on the architecture allow-list,
no new dependency): `name: "signature"`, `group: "block"`, `content:
"paragraph*"`, `defining: true`, `parseHTML` `div.makosh-signature`,
`renderHTML` the same `div`. CSS shows a muted `-- ` before it and hides it
when empty. Paste and drop of HTML containing the class go through
`sanitizeEmailHtml` first, like all incoming HTML.

**Left out of quotes.** Only for an original whose From is one of the
owner's identities (`isOwnIdentity`):

- HTML (the page's quote import): `importHtml` removes `div.makosh-signature`
  elements before wrapping the quote. For any other original it removes the
  `makosh-signature` class instead, so a sender cannot make part of their
  text look like a signature block in the owner's editor. `DraftView.import`
  gains `ownSource: boolean` for that choice.
- Text (`planCompose`'s text quote and `agentQuoteLines`):
  `stripOwnSignature(lines)` drops a line equal to `-- ` and the lines after
  it, up to but not including the first line that starts with `>`, ends with
  ` wrote:`, or equals `---------- Forwarded message ----------` (the
  formats `quoteHeaderText` writes); with none, to the end. The last `-- `
  line counts, so an earlier quoted signature further down is untouched.

### Aliases

Core `src/core/identities.ts` (new, pure):

```ts
export type SendCheck = "unknown" | "accepted" | "pending" | "confirmed" | "rewritten" | "refused";
export type Identity = {
  accountId: string;
  address: string;             // lower case
  displayName: string | null;  // effective: alias name, else the account's
  primary: boolean;
  signature: SignatureDoc | null;
  sendCheck: SendCheck;        // always "confirmed" for the primary address
};
export function identitiesOf(account: StoredAccount, aliases: AliasRow[]): Identity[];
export function ownIdentityAddresses(accounts: StoredAccount[], aliases: AliasRow[]): string[];
export function replyIdentity(source: ReplySource & { deliveredTo: string[] }, identities: Identity[]): Identity;
export function aliasSuggestions(rows: InboundRow[], known: ReadonlySet<string>, providerDomains: readonly string[]): Suggestion[];
```

- **Own addresses.** `ownAddresses` in `compose.ts` becomes
  `ownIdentityAddresses`: account emails, usernames with `@`, and every
  active alias. It feeds Reply all (an alias is never a reply-all
  recipient), "reply to own sent mail", `isOwnIdentity`, the mail_contacts
  exclusion (`ownerAccounts` in sqlite-store.ts 829–831 gains the aliases),
  the 3c card's own-domain flag (`ownDomains` includes alias domains) and the
  pre-send checks.
- **Reply-from rule** (`replyIdentity`, used by `planCompose` for reply,
  reply all and forward, and by `createProposal`):
  1. When the original's From is one of the account's identities (a reply
     to the owner's own sent mail), that identity.
  2. Else the first identity of that account whose address is in the
     original's To, in order; then in its Cc; then in its
     `delivered_to_json`.
  3. Else the account's own address.
  Only the original's account is searched, as in 3c (a reply goes out from
  the account that received it).
- **Message-ID domain.** `newMessageIdFor` takes the domain of the identity
  chosen when the draft is created. A later From change keeps the id (a
  draft's Message-ID is fixed, 3b).
- **Sending.** `outgoingOf` builds From from the draft's identity:
  `{ name: identity.displayName, address: identity.address }`. When
  `from_address` is set but is not an active identity of the draft's account
  (removed meanwhile), `queueSend` refuses with the new compose error
  `from_unknown` ("This sending address is no longer set up for the account;
  choose another From"), and the composer shows it. The SMTP envelope sender
  stays equal to the header From (`envelopeFrom`, unchanged code): bounces go
  to the alias, which delivers to the same mailbox. The SMTP login is the
  account's, as before. The Sent copy goes to the account's Sent (APPEND), or
  Gmail keeps its own, as in 3b.
- **What the providers do** (the plugin cannot verify an alias before
  sending):
  - Gmail sends with the From kept only for an address set up in Gmail's
    "Send mail as"; otherwise it rewrites From to the account's address
    **[unverified]**: public behaviour, not run. The send succeeds either way,
    so the plugin learns it from the Sent copy (below).
  - iCloud accepts only the account's own addresses and aliases and refuses
    others **[unverified]**: the stage (MAIL FROM or after DATA) and the
    reply text are not known.
- **Send check** (shown in settings and as a warning in the composer's From
  list):
  - The first time an alias's send is accepted by SMTP (outbox `sent`): on a
    `sentCopy: "server"` account (Gmail) `send_check = 'pending'` with
    `check_message_id` = the row's Message-ID; otherwise `'accepted'`.
  - After each sync round, `store.resolveSendChecks(accountId)` looks for a
    Sent-role row with that Message-ID: its From equal to the alias →
    `'confirmed'`; another address → `'rewritten'`. The composer's From list
    then marks the alias "Gmail sent your last message from <account> —
    add <alias> in Gmail Settings → Accounts → Send mail as". A later send
    starts a new check.
  - A send from an alias that fails with `sender_refused` → `'refused'`
    ("The server refused to send from <alias>").
- **New error kind** `sender_refused` in `sendErrorKindSchema`: a 5xx reply
  to MAIL FROM other than 552. `mapSendError` checks it before
  `rejected_message`. No migration: `outbox.error_kind` is TEXT. The Outbox
  row text: "The server refused to send from <address>. Check that it is an
  alias of this account at <provider>; then Edit and pick another From, or
  Retry." For `rejected_message` from an alias whose check is not
  `confirmed`/`accepted`, the text adds "If <address> is not an alias of
  this account, the server may refuse it."
- **Suggestions** (`aliasSuggestions`, store query
  `inboundAddressRows(accountId)`): rows of the account outside Sent,
  Drafts, Spam and Trash roles, with `bulk IS NOT 1`.
  - A row counts only when none of the account's known addresses (own,
    username, active aliases) is in its To or Cc: it reached the mailbox
    through another address.
  - Its candidates are its `delivered_to_json` addresses when known, else
    its To and Cc addresses.
  - A candidate must be unknown, not dismissed, valid by `parseAddress`, and
    either come from Delivered-To/X-Original-To or share a domain with one
    of the account's addresses or the provider's own domains (iCloud:
    `icloud.com`, `me.com`, `mac.com`; Gmail: `gmail.com`, `googlemail.com`).
    The domain rule keeps other people on the same message out.
  - It needs at least 2 messages. The top 10 by count, then latest date, are
    shown with the count and date.
  - **Add** opens Add address prefilled. **Not mine** stores a `dismissed`
    row. Suggestions never add anything by themselves.
- **Composer From.** One select over every active identity of every account
  with SMTP (plus the draft's current one), labelled "Name <address>",
  grouped by account, aliases marked "alias" and, when `rewritten` or
  `refused`, a warning icon with the text above. The value is the pair
  (accountId, address). Choosing another account keeps 3b's account switch
  (the server copy moves); `compose_save` carries `fromAddress` (NULL for the
  account's own address).

### Templates

Core `src/core/templates.ts` (new, pure):

- `TemplateDoc`: a `ComposeDoc` without a signature block (paragraphs, lists,
  quotes, the usual marks), through `normalizeDoc` and the caps.
- `templateNameKey(name)`: NFKC, trimmed, inner whitespace collapsed, lower
  case. Names are unique by key.
- `templateText(doc)`: `renderDoc(doc).text`, the form agents and the card
  see.
- Owner-written, so trusted as the owner's own text. It is rendered only
  through the editor schema and `renderDoc`, never as HTML.

**Composer.** A **Templates** toolbar button and Mod+Alt+T (Cmd+Option+T on
macOS; bound by `event.code` `KeyT` with `metaKey`/`ctrlKey` and `altKey`,
only while the composer has focus) open a popover: a filter field and the
list (name and first line). Enter or a click inserts the template's document
at the cursor with `insertContent`. Inserting is an ordinary edit: autosave
follows.

**Agents.**

- New tool `mail_templates` (no parameters), offered while `agentPropose`
  is on (the same `configure` rule as `mail_propose`; `execute` re-checks).
  It returns at most 200 entries `{ name, text }`, each `text` cut at 2 000
  characters with "…", the whole answer at most 64 KiB. Instructions: "Lists
  the owner's reply templates. Name one in mail_propose's `template` to
  include its text; do not copy it into `body`."
- `mail_propose` gains `template: z.string().min(1).max(80).optional()`. It
  is resolved by `templateNameKey`; an unknown name refuses with the new kind
  `template_unknown` ("No template has that name; call mail_templates for
  the names."). Its `templateText` lines follow the agent's body lines,
  after one empty line when the body is not empty, before the signature.
  The proposal row records `template_name` for the card's label.
- What is inlined is frozen in the hidden draft and covered by the content
  hash like the rest of the body. Editing the template later does not touch
  pending proposals.

### Pre-send check

Core `src/core/presend.ts` (new, pure):

```ts
export type PresendIssue =
  | { kind: "attachment_mentioned"; phrase: string }   // the matched words, from the owner's own text
  | { kind: "empty_subject" }
  | { kind: "outside_conversation"; addresses: string[] }
  | { kind: "new_recipients"; addresses: string[] };

export function presendIssues(input: {
  kind: ComposeKind;
  subject: string;
  doc: ComposeDoc;
  attachmentCount: number;
  recipients: string[];                 // To, Cc and Bcc
  own: ReadonlySet<string>;             // ownIdentityAddresses
  sentTo: ReadonlySet<string>;          // addressesSentTo ∪ sent_recipients
  conversation: ReadonlySet<string> | null; // reply / reply all only
}): PresendIssue[];
export function ownText(doc: ComposeDoc): string;            // without quotes and the signature
export function attachmentMention(subject: string, text: string): string | null;
```

- **Forgotten attachment.** `attachmentCount === 0` and the subject or
  `ownText` (every block except blockquotes and the signature) matches one
  of these, case-insensitively, with letter boundaries
  (`(?<!\p{L})…(?!\p{L})`, flag `u`), so "attachments" in a quoted message
  does not count:
  - English: `attach`, `attached`, `attaching`, `attachment(s)`,
    `enclosed`, `enclosure`, `find the file`, `see the file`, `here is the
    file`.
  - Russian: `вложени(е|я|и|ю|ем|ях)`, `во вложении`, `в приложении`,
    `приложени(е|я|и|ю)` only when preceded by `в ` or `см. `,
    `прилага(ю|ем|ется|ются)`, `прикладыва(ю|ем)`, `приложил(а|и)?`,
    `приложен(о|ы|а)`, `прикрепил(а|и)?`, `прикрепля(ю|ем)`, `прикреп(лю|лён|лено|лены)`,
    `отправляю файл`, `высылаю файл`.
  A bare "приложение" is left out: it more often means an app. Negations
  ("без вложений") are not parsed; a false warning costs one click. The list
  is a constant in `presend.ts` with its own tests.
- **Empty subject.** `subject.trim() === ""`.
- **Outside the conversation.** Reply and reply all only (a forward goes to
  new people by design). `conversation` is `store.conversationAddresses
  (sourceMessageId)`: From, To, Cc and Reply-To of every stored message of
  the source's thread. Recipients not in it and not own are listed. When the
  source is no longer stored the check is skipped.
- **New recipients.** Recipients not own and not in `sentTo`. `sentTo` is
  `addressesSentTo` (Sent-role rows) plus `sent_recipients` of every account.
  The 3c card's "New address" flag uses the same union from now on.
- Order of the list: attachment, subject, outside, new. An address in both
  "outside" and "new" is listed under "outside" only.

**RPC.** `compose_check({ draftId, baseRevision })` → `{ issues }`, owner
drafts only (`ownerDraft`), `conflict` when the revision moved on. It reads
the saved draft, so the page saves first (it already does before Send).

**Composer.** The send path in `src/ui/composer.tsx` becomes: local checks
(recipients, chips, uploads, as now) → save if dirty → `compose_check` →
issues ? dialog : `compose_send`. A failed `compose_check` (any error) goes
straight to `compose_send`, so a check never blocks. Cmd/Ctrl+Enter inside
the dialog does nothing; **Send anyway** needs a click or Tab then Enter, so
a repeated shortcut cannot skip the dialog.

**Agent card.** `proposal_view` adds `checks: PresendIssue[]`, computed from
the hidden draft. The card shows them as a **Before sending** list above the
buttons. They do not disable Send; the 3c acknowledgements stay as they are.

### Undo the last action

Core `src/core/undo.ts` (new, pure):

```ts
export const UNDO_TTL_MS = 10 * 60 * 1000;
export type UndoGroup = {
  accountId: string;
  source: string;                   // folder path the messages were in
  destination: string | null;       // move: folder path; flag change: null
  destinationUse: SpecialUse | null;
  ids: string[];
  /** flag changes: each id's value before the action */
  prior?: { id: string; seen: boolean; flagged: boolean }[];
};
export type UndoRecord = {
  id: string;                       // the page's undoId (uuid)
  action: MessageAction;
  groups: UndoGroup[];
  createdAt: string;
  expiresAt: string;
};
export type UndoStep =
  | { kind: "cancel_pending"; accountId: string; folder: string; destination: string; ids: string[] }
  | { kind: "move_back"; accountId: string; from: string; to: string; ids: string[] }
  | { kind: "copy_back"; accountId: string; from: string; to: string; ids: string[] }
  | { kind: "flags"; ids: string[]; change: FlagChange };
export function planUndo(record: UndoRecord, rows: ReadonlyMap<string, UndoRow>, folders: (accountId: string) => Folder[]):
  { steps: UndoStep[]; skipped: { accountId: string; folder: string; reason: "moved_elsewhere" | "gone" | "folder_gone" }[] };
```

`UndoRow` is `{ id, accountId, folder, uid, movePending, isRead, isFlagged }`
from the new store method `undoRows(ids)`.

**Which step for a moved message:**

| The row now | Step |
| --- | --- |
| In `source` with `move_pending = destination` (not pushed yet) | `cancel_pending` |
| In `destination`, no pending move (pushed; uid from COPYUID, or detached waiting for reattach) | `move_back`, except below |
| Same, and `destinationUse` is `all` (Gmail-style Archive, or Move to All Mail) | `copy_back` |
| In `source`, no pending move (the move was cancelled after refusals) | nothing: already back |
| Anywhere else, or gone | skipped (`moved_elsewhere` / `gone`) |
| `source` no longer exists or cannot hold messages | skipped (`folder_gone`) |

`copy_back` exists because a Gmail message in All Mail is "archived", and
the inverse is adding the Inbox label, which is a UID COPY to the Inbox. A
MOVE out of All Mail is avoided: what Gmail does with the All Mail side of a
MOVE is **[unverified]**, and COPY is non-destructive whatever it is.

**Flag changes.** For each id whose current value still equals what the
action set, the prior value is restored with `setDesired`; ids changed since
are skipped quietly. Opening a message (`markOpened`) is not an action and
records nothing.

**Where the record lives.** `src/adapters/bb/undo-book.ts` (new), in memory
on the server: one slot for the whole plugin (the owner's last action across
windows), replaced by the next undoable action, consumed by an undo, gone
after `UNDO_TTL_MS` or a restart or plugin reload. It holds message ids and
folder paths only. Reasons:

- Correctness does not depend on the window: each step re-checks where the
  rows are. The window is a UX bound (Open question 1).
- A restart already cancels in-flight state elsewhere (3b held sends, 3c
  cards); a persisted undo would need its own recovery for little gain.

**Contract.**

- `message_action` input gains `undoId: z.uuid().optional()`. When given,
  the server records the call's queued groups under that id, merging calls
  with the same id (the page's 200-id chunks of one batch) when that id is
  the current slot; a new id replaces the slot. Output gains `undoable:
  boolean`. Groups that queued nothing are not recorded.
- `action_undo({ undoId?: z.uuid() })` → `{ outcome: "done" | "pending" |
  "nothing", restored: number, skipped: number, groups: actionGroupSchema[] }`.
  Without `undoId` it undoes the current slot (the `z` key); with one, only
  that record (a stale toast cannot undo a newer action).

**Execution** (`runUndo` in `server.ts`):

1. Take the slot (consumed even if some steps fail, so an undo never runs
   twice).
2. Flag steps run at once through `setDesired`; the sync pushes them as any
   flag change.
3. Move steps run per account inside `queue.run(accountId, …)`, so they
   never overlap a sync round's push. Inside the task the plan is computed
   again from fresh rows (the round may have pushed the move meanwhile):
   - `cancel_pending`: new store method `cancelMove(ids, destination)`,
     a compare-and-swap that clears `move_pending` only where it still equals
     `destination` and the row is still in `folder`.
   - `move_back`: `queueMove(ids, source)` grouped by current folder. It is
     pushed by the next round like any move (woken at once). A detached row
     keeps the pending move and is pushed after it is reattached.
   - `copy_back`: a writable session on the All Mail folder through
     `gateway.openFolder`, the stored UIDVALIDITY compared with the server's
     first (skip on mismatch), then the new
     `FolderSession.copyMessages(uids, source)`. The Inbox's own sync brings
     the message back as a new row. Detached rows (no uid yet) are skipped
     as `gone` with the text "not synced yet; try again in a minute".
4. `publishChanged` and `loop.wake` for each touched account.
5. The RPC waits for the account tasks up to 5 s. If a long sync round holds
   the queue, it answers `pending`; the tasks go on and the page shows
   "Undo will finish after the current sync" and refreshes on the next
   `mail-changed`.

**Gateway.** `FolderSession.copyMessages(uids, destination):
Promise<{ copied: Map<number, number> | null }>` in `ports.ts`, implemented
in `imapflow-gateway.ts` with `client.messageCopy(uids, destination, {uid:
true})`: refusal → `CopyFailed`, a dropped connection → `ConnectionLost`, a
read-only session → `ReadOnly`, as `moveMessages` does. It is the only new
server write in 3d and adds a copy; it removes nothing.

**Multi-account batches.** One record holds every group of the batch. Undo
runs the accounts' tasks in parallel and reports per group like
`message_action`. The toast sums them: "Undone", or "Undone for N of M
messages" with the reasons ("moved elsewhere", "folder no longer exists",
"not synced yet").

**Undo: limits.**

- Gmail: Delete and Spam move to Trash or Spam, which drops every label.
  Undo moves the message back to the folder it was taken from only; other
  labels it had are not restored (Open question 2).
- A row that loses its id (no Message-ID and no Gmail id, so the
  destination's sync cannot reattach it) cannot be found; it is reported as
  moved elsewhere.
- While a long sync round holds the account's queue (an initial sync), the
  undo waits for it.
- Servers without MOVE or UIDPLUS have no moves at all (slice 2), so there
  is nothing to undo there.

**UI.** In `app.tsx` (toasts stay there, 3b resolution 17):

- `threadsAction` passes one `undoId` (`crypto.randomUUID()`) for all chunks
  of a batch. After a move action with something queued: `toast("<Archived |
  Moved to Trash | Marked as spam | Moved to Inbox | Moved to <folder>> N
  conversations", { action: { label: "Undo", … }, duration: 10_000 })`.
  After a flag or read change on two or more conversations: the same with
  "Marked N read" and the like. A single star or read toggle shows no toast
  (it would fire on every click); `z` still undoes it.
- `src/ui/shortcuts.ts`: `KeyZ` without modifiers → `{ kind: "undo" }`
  (Mod+Z stays the editor's). The shortcut sheet gains "z — Undo the last
  action". `z` with nothing to undo shows "Nothing to undo".

### RPC contract (`src/core/contract.ts`)

New or changed, all owner RPCs reachable by `client` callers like every
earlier one (3b resolution 1):

| Method | Input | Output |
| --- | --- | --- |
| `identities_list` | `{ accountId: idInput.nullable() }` | `{ identities: IdentityView[] }` (every account when null) |
| `identity_add` | `{ accountId, address: headerAddressInput, displayName?: string ≤ 200, one line }` | `IdentityView` |
| `identity_update` | `{ accountId, address, displayName?: string \| null, signature?: SignatureDoc input \| null }` (the account's own address takes `signature` only) | `IdentityView` |
| `identity_remove` | `{ accountId, address }` (aliases only) | `okOutput` |
| `identity_suggestions` | `{ accountId }` | `{ suggestions: { address, count, lastDate }[] }` |
| `identity_dismiss` | `{ accountId, address }` | `okOutput` |
| `templates_list` | `{}` | `{ templates: { id, name, doc, updatedAt }[] }` |
| `template_save` | `{ id?: idInput, name, doc: composeDocInputSchema }` | `{ id }`; `conflict` on a duplicate name |
| `template_delete` | `{ id }` | `okOutput` |
| `compose_check` | `{ draftId, baseRevision }` | `{ issues: PresendIssue[] }` |
| `action_undo` | `{ undoId?: z.uuid() }` | see "Undo" |
| `message_action` | gains `undoId?` | gains `undoable` |
| `compose_save` | gains `fromAddress: headerAddressInput.nullable()` | unchanged |
| `compose_prepare`, `compose_new`, `compose_open` | unchanged | `DraftView` gains `fromAddress: string \| null`; `import` gains `ownSource` |
| `proposal_view` | unchanged | gains `fromAlias: boolean`, `signatureText: string \| null`, `templateName: string \| null`, `checks: PresendIssue[]`; `links` also covers the signature |

`IdentityView = { accountId, address, displayName, primary, signature,
sendCheck }`. `compose_save` refuses a `fromAddress` that is not an active
identity of `accountId` (`invalid`). Deleting a template or removing an alias
is local configuration only; the settings dialog asks before either.

### Agent proposals: what changes

- `mailProposeParamsSchema.accountId` (new message): also accepts one of the
  account's alias addresses, which selects that identity.
  `resolveSendingAccount` matches aliases too; with no `accountId` the
  identity is the account's own address. For reply, reply all and forward,
  `replyIdentity` picks the From; an `accountId` that names another account
  or another identity refuses with `account_mismatch` (its text becomes "A
  reply or forward is sent from the address the message came to; leave
  accountId out.").
- The signature of the chosen identity is inserted as in "Placement"; the
  card shows it under a `-- ` line, and the content hash covers it because
  it is part of `doc`.
- `draftHash` and `queueConfirmed` take the From from the draft's identity
  (name and address) instead of `account.email`; `expectFrom` compares it as
  in 3c resolution 23.
- `template` as above. `PROPOSE_INSTRUCTIONS` and `skills/mail/SKILL.md`
  gain: "To use one of the owner's reply templates, call mail_templates and
  pass its name as `template`. The owner's signature is added for you; do
  not write one."

### UI (summary)

- **Mail settings dialog** (`src/ui/mail-settings.tsx`, new; opened by a
  gear in the mail rail footer, `src/ui/mail-sidebar.tsx`): per account a
  **Sending addresses** section (list, Add address, Suggestions, per-address
  name, signature editor, send state, Remove) and a link to the existing SMTP
  dialog; and a **Templates** section (list, New, rename, edit with the
  composer's editor without the signature node, Delete with confirmation).
- **Signature editor**: `ComposeEditor` with a toolbar of bold, italic,
  underline and link only; lists and quotes are off.
- **Composer**: the From select by identity, the signature node, the
  "kept" note, the Templates button and popover, the "Before you send"
  dialog.
- **Card**: the alias badge, the template label, the signature, the
  **Before sending** list.
- **Toasts and `z`** as in "Undo".

The views are host-free in `src/ui` with plain props, tested with Testing
Library, like the 3c card.

### Security and privacy

- **From and aliases.** Only the owner adds an alias, in settings. Sync and
  suggestions only propose. Agents cannot add, change or pick an alias
  outside the reply rule or by naming it, and the card shows the From with an
  "alias" badge before Send. The plugin cannot prove the owner owns an
  alias; the provider enforces it, and the plugin reports refusals and
  rewrites.
- **Suggestions** read header addresses already stored; nothing is fetched
  for them. `delivered_to_json` holds addresses only.
- **Signatures and templates** are the owner's text. They enter the
  document as JSON through the same schema and renderer as the body, so the
  only HTML out is the whitelisted tags plus the fixed `makosh-signature`
  class. A foreign message cannot inject a signature block: the class is
  removed from foreign quotes before import.
- **Templates and agents.** With `agentPropose` on, `mail_templates` gives
  the agent the templates' text, which goes to the agent's model provider.
  This is stated in README and `PLUGIN_OVERVIEW.md`.
- **Undo** acts on the owner's last action only, moves rows back only where
  they are still where the action left them, and never deletes. A shell
  agent can call `action_undo` (accepted limit, 3b resolution 1); the worst
  it does is undo the owner's last action, which the owner can redo.
- **Pre-send check** reads local data only, sends nothing anywhere, and
  never blocks.
- **Logs and realtime.** Log lines carry ids, kinds and counts. No address,
  signature, template or check phrase reaches a log, an error text or a
  realtime payload; refusal texts that name an alias go to the page only, as
  3b's Outbox texts already name the account.

## Testing

Core with fakes, the store on real SQLite, adapters with recorded fixtures,
UI with Testing Library and jsdom, as before. Tests are colocated. Fixtures
use made-up text and addresses on `example.com` / `example.org` only.

- **Signature document** (`compose-signature.test.ts`, `compose-doc.test.ts`):
  normalization (one top-level block kept, nested and second flattened with
  text kept, lists inside flattened, empty kept); rendering (empty → nothing;
  HTML with the fixed class and `-- `; text with `-- ` exactly, trailing
  space kept, no blank lines inside); `isDocEmpty` ignores it; placement for
  each kind; swap (unchanged → replaced, empty → filled, edited → kept, none
  → unchanged); `normalizeSignature` drops a leading `--`, enforces caps and
  link protocols.
- **Quotes**: `stripOwnSignature` for a reply and a forward of own mail
  (sig above an earlier quote stays out, the earlier quote kept), no
  delimiter, two delimiters; not applied to foreign mail; the page import
  removes `div.makosh-signature` for own mail and only the class for foreign
  mail (`compose-editor.test.tsx`).
- **Identities**: `replyIdentity` (To, then Cc, then Delivered-To, own sent
  mail, fallback); `ownIdentityAddresses` drives Reply all (alias excluded);
  `aliasSuggestions` (known in To/Cc → row ignored; Delivered-To preferred;
  other people on the message left out by the domain rule; bulk, Spam,
  Trash, Sent, Drafts left out; dismissed and known excluded; ≥ 2; order).
- **Sending from an alias**: `outgoingOf` From and envelope sender equal the
  alias; `from_unknown` after removal; `compose_save` refuses a foreign
  `fromAddress`; `mapSendError` → `sender_refused` for 5xx at MAIL FROM,
  552 still `too_large`; send-check transitions (accepted, pending →
  confirmed / rewritten from a synced Sent row, refused); `sent_recipients`
  written on `sent` in the same transaction.
- **Pre-send** (`presend.test.ts`): each English and Russian pattern hits;
  "приложение банка", "attachments" inside a quote, and the signature do not;
  the subject counts; empty subject; outside-conversation only for replies,
  skipped without the source; new recipients against the union; own
  addresses never listed; order and de-duplication; `compose_check`
  conflict on a stale revision; composer: issues → dialog, Fix targets, Send
  anyway, check RPC error → send, Cmd+Enter inert in the dialog.
- **Undo** (`undo.test.ts`, `server.test.ts`, store tests): `planUndo` for
  every table row; flags restored only where unchanged; `cancelMove` CAS
  (no-op once pushed); an undo racing a round (fake queue holding the task
  until the round's `completeMove`) ends as `move_back`, never as a lost row;
  a detached row gets its reverse move pushed after reattach; `copy_back`
  for a Gmail-style archive calls `copyMessages`, never `moveMessages`, and
  skips on UIDVALIDITY mismatch; multi-account record from chunked calls
  with one `undoId`; a stale `undoId` does nothing; slot consumed once;
  expiry; no gateway call ever sets `\Deleted` or expunges (fake session
  records commands).
- **Templates**: name keys (case, NFKC, spaces), duplicate refused, caps,
  insert in the composer at the cursor, Mod+Alt+T opens the picker only with
  focus in the composer.
- **Agents**: `mail_templates` gating and caps; `mail_propose` with
  `template` (inlined after the body, before the signature, unknown name
  refused, hash covers it, a later template edit does not change the
  proposal); signature in the proposal doc and in `proposal_view`; alias
  selection for new mail and the reply rule, `account_mismatch`; card renders
  alias badge, template label, signature and checks.
- **Store**: element 7 appended; elements 0–6 byte-identical (SHA pin);
  explicit deletes on account removal; `delivered_to_json` filled by sync
  from fixtures with Delivered-To and X-Original-To.
- **Logs and realtime**: a spy logger and realtime recorder over an alias
  send, an undo, a check and a template proposal see no address, signature,
  template text or phrase.

### Live verification (owner's accounts, after the build)

1. iCloud: send from a real iCloud alias (accepted) and from an address that
   is not one (record where and how iCloud refuses; confirm
   `sender_refused` or the `rejected_message` hint).
2. Gmail: send from an address set up in "Send mail as" (confirmed) and from
   one that is not (rewritten, detected after the Sent sync); confirm Gmail
   keeps the Message-ID.
3. Reply to a message sent to an alias: From preselected.
4. Signatures: new, reply (HTML and text originals), forward; From swap;
   reply to own mail leaves the signature out of the quote; the text part
   has `-- `.
5. Undo on iCloud and Gmail: archive, delete, spam, not spam, Move to…, flag
   and read, each before and after the push; Gmail archive undo via COPY
   brings the conversation back to Inbox; a multi-account selection.
6. Pre-send dialog for each issue; Send anyway.
7. A proposal with a template and a signature from an alias.

## Tasks

Each task ends with `npm run check`. The last also runs `npm run build` and
`node ../../scripts/check-manifests.mjs`. Paths are under `plugins/mail/`.

1. **Core: signature and document.** `src/core/compose-signature.ts`
   (+ test); `compose-doc.ts` gains the `signature` block in normalization,
   rendering and `isDocEmpty`.
2. **Core: identities.** `src/core/identities.ts` (+ test);
   `ownAddresses` → `ownIdentityAddresses` everywhere; `replyIdentity` in
   `planCompose`; `withSignature` in `planNew`/`planCompose`;
   `stripOwnSignature` in the text quote and `agentQuoteLines`;
   `outgoingOf` and `newMessageIdFor` by identity; `from_unknown`;
   `sender_refused` in `model.ts`.
3. **Core: templates, pre-send, undo.** `src/core/templates.ts`,
   `src/core/presend.ts`, `src/core/undo.ts` (+ tests); `ports.ts` gains the
   store methods (`listIdentities`, `addIdentity`, `updateIdentity`,
   `removeIdentity`, `dismissIdentity`, `inboundAddressRows`,
   `resolveSendChecks`, `conversationAddresses`, `sentRecipients`,
   `undoRows`, `cancelMove`, template CRUD) and `FolderSession.copyMessages`;
   `contract.ts` gains the RPC schemas.
4. **Store and migration 7.** `sqlite-store.ts`: element 7, the methods
   above, `delivered_to_json` in the upsert, `sent_recipients` on `sent`,
   explicit deletes, aliases in `ownerAccounts` (+ tests).
5. **Adapters.** `imapflow-gateway.ts`: `copyMessages`, Delivered-To and
   X-Original-To parsing; `smtp-transport.ts`: `sender_refused`;
   `src/adapters/bb/undo-book.ts` (+ tests).
6. **Server wiring.** `server.ts`: the new RPCs, `message_action`'s
   `undoId`, `runUndo` through the account queue, `compose_check`,
   `resolveSendChecks` after each round, the send-check update on `sent` and
   on `sender_refused`, `mail_templates` registration and `configure`,
   `mail_propose`'s `template` and alias handling, `proposal_view`
   additions (+ `server.test.ts`).
7. **UI: settings.** `src/ui/mail-settings.tsx` (+ test), the rail gear,
   the signature editor.
8. **UI: composer.** `src/ui/signature-node.ts`, From by identity, swap,
   templates popover and Mod+Alt+T, the "Before you send" dialog, quote
   import rule (+ tests).
9. **UI: undo and card.** `app.tsx` toasts and `action_undo`,
   `shortcuts.ts` `KeyZ`, shortcut sheet, `agent-send-card.tsx` additions
   (+ tests).
10. **Docs and listing.** `README.md`, `PLUGIN_OVERVIEW.md` ("Not yet" loses
    signatures; aliases, templates, undo, checks; the template-to-provider
    note), `package.json` `bb.description`, root `marketplace.json`,
    `skills/mail/SKILL.md`, `CHANGELOG.md`, element 7's SHA pin.
    `THIRD_PARTY_NOTICES.md` changes only if code is vendored (none planned;
    no new dependency). Run `check-manifests`, `npm run check` and
    `npm run build`.

## Calls made by me (not the owner)

- Signature as a top-level `signature` block of the document, always
  present (possibly empty) in new 3d drafts, so From can swap it; rendered
  with `-- ` in both parts and a fixed `makosh-signature` class in HTML.
- Signatures left out of quotes only for the owner's own mail: the marked
  block in HTML, the last `-- ` block in text.
- Primary address described by `accounts`; aliases in `identities`; one
  account per address.
- Envelope sender equal to the header From (unchanged code); Message-ID
  domain from the identity at creation.
- Alias verification by observation: Gmail's Sent copy compared by
  Message-ID, iCloud's refusal mapped to `sender_refused`.
- Suggestions: rows reached through an unknown address, Delivered-To
  preferred, a domain rule to keep other recipients out, at least 2
  messages, top 10.
- Forward also follows the reply-from rule.
- "Never sent to" = Sent-role rows plus a new `sent_recipients` ledger; no
  network call in the check.
- Undo record in memory, one slot, 10 minutes; moves undone through the
  account queue; COPY instead of MOVE out of All Mail.
- Toasts for moves and for flag changes on two or more conversations only.
- Templates: fixed text, no placeholders; agents get name and text through
  `mail_templates`; inlined after the agent's body.
- Template shortcut Mod+Alt+T.

## Open questions for the owner

1. **Undo window.** `z` works for 10 minutes or until the next undoable
   action; the toast shows for 10 s; a restart forgets it. *Recommendation:*
   keep these values.
2. **Gmail labels on undo of Delete or Spam.** Gmail drops all labels when a
   message goes to Trash or Spam; undo returns it to the folder it came from
   only. Restoring every label means recording the message's other folders
   and copying back to each after the reverse move. *Recommendation:* accept
   the limit in 3d and document it.
3. **COPY as a new server write.** Undoing a Gmail archive adds the Inbox
   label with UID COPY (it adds, never removes). *Recommendation:* allow it,
   only for undo, and list it in "What it changes on the server".
4. **"New recipient" history.** The plugin knows what you sent only from
   synced Sent mail (30 days by default) and from what it sends from now on,
   so someone you last wrote to months ago from another client shows as new
   once. A server SEARCH of Sent per address would fix it at the cost of a
   network call per Send. *Recommendation:* accept the local history; the
   warning costs one click and fades as the ledger fills.
5. **Templates for agents.** `mail_templates` sends the templates' text to
   the agent's model provider whenever an agent lists them.
   *Recommendation:* yes, under `agentPropose` (no separate setting).
6. **Placeholders.** *Recommendation:* none in 3d; add `{first name}` later
   if fixed texts prove limiting.

## Not verified

- Gmail rewrites From to the account address for an address not set up in
  "Send mail as", and keeps the client's Message-ID on SMTP submission (the
  send check relies on both). Live step 2.
- Where and with what reply iCloud refuses a From that is not an alias
  (MAIL FROM or after DATA). Live step 1.
- Whether Gmail sets `Delivered-To` to the alias or to the account address
  for mail sent to a "Send mail as" alias, and whether iCloud sets
  `X-Original-To` for its aliases. Suggestions work without either, from To
  and Cc.
- What Gmail does on a UID MOVE out of `[Gmail]/All Mail` (the design avoids
  it for undo). Note: the existing **Move to…** already allows All Mail as a
  source on Gmail; its behaviour there is equally unverified and worth a
  live check.
- That imapflow's `messageCopy` reports a refused COPY as `false` like
  `messageMove` (assumed from its shared return type).
- That TipTap 3.32.2 keeps an empty `paragraph*` node in the document
  through `getJSON` and paste, and that `defining: true` keeps the signature
  block intact on select-all-and-type (pinned by `compose-editor.test.tsx`).
- That BB's RPC layer has no timeout shorter than the 5 s `action_undo`
  wait.
- That Mod+Alt+T reaches the page inside BB's webview on macOS (no default
  binding in BB 0.49.0, checked in the bundled key table only).

## Resolutions after the builder check

These override the sections above. Items marked *(owner)* were decided by the owner on 2026-11-15; open questions 1–6 are closed by them. Names below were checked against the current code (`src/core/actions.ts`, `compose.ts`, `compose-outbox.ts`, `contacts.ts`, `agent-proposals.ts`, `ports.ts`, `contract.ts`, `src/adapters/bb/sqlite-store.ts`, `smtp-transport.ts`, `imapflow-gateway.ts`, `sync-service.ts`, `server.ts`, `src/ui/shortcuts.ts`).

1. **UID COPY only on Gmail *(owner)*** (open question 3).
   - Undo may issue UID COPY only when the session on the folder the message is in now reports `capabilities().gmail` (X-GM-EXT-1), and only when that folder is not the account's Trash or Spam (`specialUse` `trash` / `junk`). It adds the source folder's label; it never removes anything.
   - Everywhere else (every non-Gmail server, and on Gmail a message now in Trash or Spam) undo is a move back through `queueMove` and the existing `canMoveSafely` guard.
   - README and `PLUGIN_OVERVIEW.md` "What it changes on the server" gain: "Undo on Gmail adds a message back to the folder it came from with UID COPY; nothing else uses COPY."
2. **Where the `-- ` delimiter goes *(owner)*.**
   - The `-- ` line is written only when the signature block is the last top-level block of the document (a new message). The text part then has a blank line, `-- `, the signature lines; the HTML has `<div class="makosh-signature"><p>-- </p>…</div>`.
   - When anything follows the signature (a reply or forward: attribution and quote below it), the text part has a blank line, then the signature lines, then a blank line, with no `-- `; the HTML is `<div class="makosh-signature">…</div>` with no `-- ` paragraph. So clients that hide everything after `-- ` (RFC 3676) never hide the quote.
   - The composer's muted marker and the card follow the same rule: `-- ` only for a signature that is last.
3. **Own signature in quotes: replies only *(owner)*.**
   - Reply and Reply all to the owner's own mail leave the own signature out of the quote. A Forward of the owner's own mail keeps it: the signature is part of what is forwarded.
   - `DraftView.import` gains `stripSignature: boolean` instead of `ownSource` (true only for reply and reply all of a message whose From is one of the owner's identities). With it `importHtml` removes `div.makosh-signature` elements; without it (foreign mail and every forward) it removes only the `makosh-signature` class, so the text stays as ordinary quoted text and no second signature block reaches the editor.
   - The text path follows the same rule: `stripOwnSignature` runs in `planCompose`'s text quote and in `agentQuoteLines` for reply and reply all of own mail only. Since 3d replies carry no `-- ` (resolution 2), the text path finds only signatures of own new mail and of own mail written in other clients; the HTML path finds the marked block wherever it is.
4. **Kept as recommended *(owner)*.**
   - Undo window 10 minutes, toast 10 s, forgotten on restart or plugin reload (open question 1).
   - `z` sends the page's own last `undoId`; `action_undo` therefore takes `{ undoId: z.uuid() }` as a required field, and there is no "current slot" call without an id. A `z` in one window cannot undo another window's action; with no `undoId` on the page, `z` shows "Nothing to undo" without a call.
   - Gmail labels lost on undo of Delete or Spam stay lost; README states it (open question 2).
   - "New recipient" uses local history only: Sent-role rows and `sent_recipients`, no server SEARCH (open question 4).
   - `mail_templates` is offered under `agentPropose`, with no setting of its own (open question 5).
   - No template placeholders (open question 6).
5. **Replies: conversation participants are not "new"** (builder finding B1).
   - For reply and reply all with a stored source, `presendIssues` checks only `outside_conversation`. A recipient in `conversation` is never listed as `new_recipients`; a recipient outside it is listed under `outside_conversation` only. `new_recipients` applies to new messages, forwards, and replies whose source is no longer stored (`conversation === null`).
   - The agent card's `checks` leave `new_recipients` out: the card already flags each new address and requires its acknowledgement (3c resolution 13). The card shows `attachment_mentioned`, `empty_subject` and `outside_conversation` only.
6. **Templates are document blocks** (B2).
   - `mail_propose` with `template` splices the template's normalized blocks into the proposal document: the body's `docFromLines` paragraphs, an empty paragraph when the body is not empty, the template's blocks (marks and links kept), then the signature, then the quote. The text form (`templateText`) is used only for `mail_templates` and for the card's label and body text.
   - A template may not contain a blockquote: `normalizeTemplate` refuses one (`invalid`, "Templates cannot hold quotes"), and the template editor has quotes off. So a template never looks like a quote to `ownText` or to the card's `docParts`.
7. **`copy_back` is keyed on the Gmail capability** (B3). `isGmailStyle` in `src/core/actions.ts` 61–65 is true for any account with All Mail and no Archive, which is broader than Gmail. `planUndo` therefore does not decide copy by `destinationUse === "all"`. It emits `move_back` with `copyIfGmail: boolean` (true when the folder the message is in now is not Trash or Spam); `runUndo` opens a writable session on that folder, and uses `copyMessages` only when `capabilities().gmail` is true, else closes it and queues the move back. No session is opened for a group whose `copyIfGmail` is false.
8. **`runUndo` refusals and failed copies** (B4).
   - Before taking the slot, `runUndo` refuses per group exactly as `runMessageAction` does: vault not ready → `NEEDS_KEY_MESSAGE`, account `authFailed` → `PASSWORD_NEEDED_MESSAGE`, unknown account → skipped. A record whose groups are all refused is left in the slot, so the owner can undo after unlocking.
   - When opening the session or the copy fails (connection lost, open refused, `CopyFailed`), the failed copy groups are put back into the slot under the same `undoId` (with the same expiry) and reported in the result as `failed`, with "Could not reach the server; try Undo again". Groups that succeeded are not undone twice: only the failed groups go back.
   - `action_undo` output therefore gains `failed: number` beside `restored` and `skipped`.
9. **Where `stripOwnSignature` stops** (B5). It drops the last line equal to `-- ` and the lines after it up to, not including, the first blank line after it; with none, to the end. It no longer looks for "wrote:", `>` or the forward marker: the signature is written with no blank lines inside (Design, "Rendering"), so the first blank line ends it.
10. **A removed alias, an account switch, queued rows.**
    - `outgoingOf(…, strict: false)` (the Drafts copy) falls back to the account's own address when `from_address` is not an active identity any more; it does not throw. `outgoingOf(…, strict: true)` (`queueSend`) refuses with `from_unknown` as in the Design.
    - A `compose_save` that changes `accountId` stores `fromAddress` only when it is an active identity of the new account, else NULL (the new account's own address). A save that keeps the account refuses a foreign `fromAddress` with `invalid`, as in the Design.
    - An outbox row already queued keeps the From it was built with, even if the alias is removed before it goes out. README states it.
11. **Own-address shapes.** The owner's addresses travel as `{ id: string; addresses: string[] }` (the account's email, its username when it holds `@`, its active aliases, lower case): `ownerAccounts()` in `sqlite-store.ts` 830–831, the `Owner` type and the `own` sets in `src/core/contacts.ts` (`rankContacts`, `correspondenceOf`), and `resolveSendingAccount` in `agent-proposals.ts` 331–351, which matches the given value against any address of an account and returns `{ accountId, address }`.
12. **Card From and body parts.** `proposal_view`'s `fromName` and From address come from the draft's identity (`identityOfDraft`), not `account.email`; `draftHash` takes the same pair. `docParts` in `agent-proposals.ts` splits the doc into body, signature and quote, so `bodyText`, `signatureText` and `quoteText` are separate; `links` covers body, template and signature text and the `href` of every link mark in the body, template and signature blocks.
13. **`sender_refused` mapping.** The `EMESSAGE` + `MAIL FROM` → `too_large` branch of `mapSendError` stays as it is (nodemailer's size refusal). `SendError` gains `command: "MAIL FROM" | "RCPT TO" | "DATA" | null` (fixed strings only), filled by `mapSendError`. The core, not the transport, decides `sender_refused`: a `rejected_message` before DATA with `command === "MAIL FROM"` on a row whose `envelopeFrom` is not the account's own address becomes `sender_refused`. From the own address it stays `rejected_message`.
14. **Forward: the attachment words stop at the forward header.** For a forward, `ownText` ends at the paragraph `---------- Forwarded message ----------` (what `quoteHeaderText` writes): the forwarded text below it never triggers `attachment_mentioned`.
15. **Russian attachment words.**
    - Subject and text are normalized before matching: NFKC, lower case, `ё` → `е`.
    - Stems, each with letter boundaries and `\p{L}*` endings: `прикрепл\p{L}*`, `приложенн\p{L}*`, `вложени\p{L}*`, `аттач\p{L}*`; the verb forms of the Design that the stems do not cover stay (`прилага\p{L}*`, `прикладыва\p{L}*`, `приложил\p{L}*`, `приложен[оыа]`, `отправляю файл`, `высылаю файл`).
    - `в приложении` and `см. приложение` count only when one of the file words (`файл`, `документ`, `скан`, `фото`, `презентаци`, `таблиц`, `договор`, `pdf`, `doc`, `xls`) is within five words; a bare `приложение` never counts.
    - The tests include false positives that must not match: "ошибка в приложении", "приложение банка", "в мобильном приложении".
16. **Undo progress.** After the reverse moves are queued the page shows "Moving back…" until the next `mail-changed` (rows with `move_pending` are already hidden from lists, so they vanish from the destination's list at once). `runUndo` wakes the account's sync twice: once at once (to push the reverse moves) and once after that round completes (so the source folder's sync brings a reattached or copied row back without waiting 5 minutes).
17. **The signature node is top-level only.** `signature-node.ts` is `isolating: true` and `defining: true`, and is in no group that lists or blockquotes accept: the editor's Document content becomes `(block | signature)+`. `normalizeDoc` keeps its server-side rule (Design, "Normalization"). Pasted and dropped HTML goes through the editor's `transformPastedHTML`, which removes the `makosh-signature` class, so pasting a copied signature gives ordinary paragraphs.
18. **Nits.**
    - The BB key table row also lists `Alt+T` and `Alt+Shift+T` (`modelPicker.cycleReasoning` / `…Backward`, scoped to BB's own composer and model picker), beside `Alt+M` and `Alt+P`. Mod+Alt+T is a different chord and stays free.
    - imapflow `messageCopy` resolves `false` on a refused COPY and a `CopyResponseObject` with `uidMap` when the server has UIDPLUS (verified in `imap-flow.d.ts` / `types.d.ts`); that "Not verified" item is closed. `copyMessages` maps `false` to `CopyFailed`.
    - `identity_add` upserts on `(account_id, address)`: adding a dismissed address makes it active, adding an active one updates its display name.
    - For rows synced before element 7 (`delivered_to_json` NULL), suggestions use To and Cc, so the provider-domain rule may offer another person's `gmail.com` or `icloud.com` address that shared a message. Accepted: the owner dismisses it with **Not mine**.
    - `sent_recipients` keeps every accepted envelope recipient, Bcc included, until the account is removed. README states it.
    - `addressesSentTo` reads Sent-role rows and `sent_recipients` together, so the 3c card's "New address" flag and the pre-send check use one union without a second store method.
19. **On Gmail, COPY only undoes an archive *(owner)*** (narrows resolutions 1 and 7).
    - Undo uses UID COPY only when the message now sits in All Mail (`specialUse` `all`, `\All`) and goes back to the folder it was archived from (the Inbox, or the action's source). `planUndo` sets `copyIfGmail` true only when the folder the row is in now is All Mail; `runUndo` still copies only when that session reports `capabilities().gmail`.
    - Undoing **Move to <label>** on Gmail is a move back: a MOVE out of the label removes that label, which is the true inverse; a COPY there would leave the label on the message.
    - Undo out of Trash or Spam stays a move back, as before. Every non-Gmail server moves back as before.
    - README and `PLUGIN_OVERVIEW.md` "What it changes on the server" therefore say: "Undo of Archive on Gmail adds the message back to the folder it came from with UID COPY; nothing else uses COPY."
20. **Review fixes.**
    - A `compose_save` that keeps the account and sends the draft's stored `fromAddress` back unchanged is accepted even when that alias is no longer active; the Drafts copy falls back to the own address (resolution 10) and Send refuses it with `from_unknown`. A newly chosen inactive address is still `invalid`. The composer sends `fromAddress` only when From (or the account) changed since the last save.
    - For reply, reply all and forward, `attachment_mentioned` searches the subject only when the owner changed it from the Re:/Fwd: subject computed from the stored source (`PresendInput.inheritedSubject`); with the source gone the subject is searched as before. New messages are unchanged.
    - Undo accounting: rows counted `not_synced` (detached, or a UIDVALIDITY mismatch) go back into the slot under the same `undoId` and expiry (refused once a newer action took it), and the toast says "not synced yet; try again in a minute". The move back is queued per row: a row the owner moved or queued elsewhere meanwhile is `moved_elsewhere`, the rest restore. A failed `status()` counts every row of the step as `failed`, detached ones included, and puts them back.
    - `copyIfGmail` is also false when the undo's target (the action's source) is Trash or Spam: a COPY there would add a copy, not undo; those rows move back. README and `PLUGIN_OVERVIEW.md` say so.
