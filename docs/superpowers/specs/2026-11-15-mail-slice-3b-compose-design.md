# Makosh Mail — slice 3b: compose, reply, reply all, forward, drafts, sending

Status: decisions made by the owner (2026-11-15); transport, storage and
safety rulings made by the controller; this document is the builder's design
for review. Second of three slices toward a full mail client in BB: 3a
(organize and read, done), 3b (this: write and send), 3c (agent sends with
confirmation, translation). Builds on the slice-1, slice-2 and 3a specs;
everything there holds unless this document changes it. Backlog:
`docs/mail-feature-backlog.md` items 4, 13, 18 and 19 (and 23 undo send).

Points the builder could not verify are marked **[unverified]** and collected
in "Not verified" at the end. "Open questions for the owner" lists the places
where this design departs from a controller ruling or needs an owner call;
each has a recommendation, and the design below follows that recommendation.

## Owner's decisions

1. **Rich text plus attachments**, with TipTap as the editor.
2. **Drafts are kept on the server** (the account's Drafts folder), so other
   clients see them.
3. **Only the owner sends** in 3b. Agents get send-with-confirmation in 3c;
   3b leaves a seam for it and nothing more.
4. Accounts are **iCloud and Gmail over IMAP with app passwords**; sending
   uses SMTP with the same app password.
5. The goal is a full client: **Compose, Reply, Reply all, Forward**.

## Goals

1. **Compose** a new message from any account: From (one of the owner's
   accounts), To, Cc, Bcc as recipient chips, Subject, a rich-text body, and
   attachments by picker, drag and drop or paste.
2. **Reply**, **Reply all** and **Forward** from the reading pane (toolbar
   and keys `r`, `a`, `f`) with correct recipients, subject prefix, quoted
   original and threading headers. Forward carries the original's
   attachments.
3. **Drafts**: work is saved locally within about two seconds of a change and
   copied to the account's Drafts folder on the server; a draft found in
   Drafts (made here or in another client) opens in the composer to continue.
4. **Send** through SMTP with TLS, through an **outbox**: 10 seconds to undo,
   then a background send; a failure stays in the outbox with **Retry**; a
   message is never silently dropped and never sent twice.
5. A **Sent copy** that matches what was sent: Gmail stores it itself; other
   servers get an IMAP APPEND to Sent.
6. **SMTP settings** on each account: iCloud and Gmail presets fill them;
   other servers get SMTP host and port fields. Existing accounts get them by
   migration (presets) or by a settings form (other).
7. The shortcut sheet's `c`, `r`, `a`, `f` stop being "coming later";
   Cmd/Ctrl+Enter sends, Escape closes the composer (asking first when there
   is unsaved or unsent content).

## Non-goals (later slices or backlog)

- Agents sending, drafting or replying (3c). No agent tool, CLI command,
  mention or skill text gains any compose ability in 3b.
- Aliases and multiple identities per account (backlog #45), signatures
  (#33), scheduled send (#52), pre-send checks such as "you mentioned an
  attachment" (#55), templates, read receipts, S/MIME or PGP.
- Address book or CardDAV contacts; autocomplete uses only addresses already
  in the local store.
- Inline images inserted by the owner (pasted pictures become attachments,
  not `cid:` parts) — see "Body format".
- Plain-text-only compose mode, HTML source editing, tables, fonts, colors.
- OAuth, Gmail API, server-side send-later.
- Permanent deletion of anything except the plugin's own superseded drafts
  (the narrow exception in "Drafts on the server").

## Anti-goals

- **A send the owner did not ask for.** Only the owner's Send click or
  Cmd/Ctrl+Enter queues a message. Agents, mentions, CLI, sync and restarts
  never send; a restart never resends automatically.
- **Sending twice.** No automatic retry after the SMTP server may have
  accepted the message (see the failure matrix).
- **Losing the owner's text.** A draft is never deleted locally before a
  newer copy exists, and a send failure keeps the message in the outbox.
- **Expunging mail the plugin did not write.** The only expunge is UID
  EXPUNGE of one uid that this plugin appended and has verified, on a server
  with UIDPLUS. Without UIDPLUS, nothing is expunged.
- **Trusting HTML from the page.** The server builds the message HTML from a
  structured document; it never sends HTML the page produced.
- **Remote loads while composing.** The editor never fetches a remote image,
  font or stylesheet, including from quoted mail.
- **Mail text or attachment bytes in logs, realtime events or errors.**
- **Plaintext SMTP.** No port 25, no opportunistic TLS, no fallback.

## Design

### User flows

1. **Compose.** `c` or the **Compose** button in the nav rail opens the
   composer (panel or full page, see UI) with From = the account being viewed
   (in All accounts: the account of the Inbox's first account in sort order).
   The owner types; the draft autosaves. **Send** (or Cmd/Ctrl+Enter)
   validates (at least one recipient, every chip valid, total size under the
   cap), closes the composer and shows a toast "Sending in 10 s · Undo". After
   10 s the outbox sends; the toast becomes "Sent" or "Not sent · Retry".
2. **Reply / Reply all.** From an open message, `r` or `a` (or the toolbar)
   opens the composer prefilled: recipients per "Reply rules", subject with
   `Re:`, body empty above a quote of the original, threading headers set.
   The composer docks under the conversation (wide) or replaces it (narrow).
3. **Forward.** `f` opens the composer with no recipients, `Fwd:` subject,
   a "Forwarded message" header block and the quoted body, and the original's
   attachments listed as chips that the owner may remove.
4. **Continue a draft.** Opening a message in a Drafts folder shows an
   **Edit draft** action (and Enter / `o` on a draft opens the composer
   directly). The draft's fields, body and attachments load into the
   composer.
5. **Discard.** **Discard** in the composer (or Escape, then confirm) deletes
   the local draft and the plugin's own server copy (per the exception).
6. **Undo send.** "Undo" in the toast within 10 s returns the message to the
   composer as a draft, unchanged.
7. **Failure.** A failed send shows in an **Outbox** row at the top of the
   thread list of the account's Sent role and in the toast: the reason kind
   (auth, refused recipient, too large, network), **Retry**, **Edit** (back to
   the composer) and, only for the "may have been sent" state, **Send again**
   and **Discard** (see failure matrix).
8. **SMTP settings for an existing "other" account.** The account settings
   form gains SMTP host, port and security; **Test** checks the SMTP login
   with the stored password; Save stores them. Until then Compose from that
   account explains "SMTP is not set for this account" with a link to the
   form.

### Data model and migration

Migration element **4** is appended to `MIGRATIONS` in
`src/adapters/bb/sqlite-store.ts`; elements 0–3 are frozen and unchanged.

```sql
-- accounts: SMTP and Sent-copy policy (NULL = not configured)
ALTER TABLE accounts ADD COLUMN smtp_host TEXT;
ALTER TABLE accounts ADD COLUMN smtp_port INTEGER;
ALTER TABLE accounts ADD COLUMN smtp_security TEXT;   -- 'tls' (465) | 'starttls' (587)
ALTER TABLE accounts ADD COLUMN smtp_username TEXT;   -- NULL = use accounts.username
ALTER TABLE accounts ADD COLUMN sent_copy TEXT;       -- 'server' | 'append'
UPDATE accounts SET smtp_host='smtp.mail.me.com', smtp_port=587,
  smtp_security='starttls', sent_copy='append' WHERE preset='icloud';
UPDATE accounts SET smtp_host='smtp.gmail.com', smtp_port=465,
  smtp_security='tls', sent_copy='server' WHERE preset='gmail';
UPDATE accounts SET sent_copy='append' WHERE sent_copy IS NULL;

-- the composer's working copy; one row per open or saved draft
CREATE TABLE compose_drafts (
  id TEXT PRIMARY KEY,                 -- newId()
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,                  -- 'new' | 'reply' | 'reply_all' | 'forward'
  source_message_id TEXT,              -- messages.id it replies to / forwards
  message_id TEXT NOT NULL,            -- stable RFC 5322 Message-ID for all versions
  in_reply_to TEXT, refs TEXT,         -- threading headers, computed once
  to_json TEXT NOT NULL, cc_json TEXT NOT NULL, bcc_json TEXT NOT NULL,
  subject TEXT NOT NULL,
  doc_json TEXT NOT NULL,              -- TipTap/ProseMirror document
  revision INTEGER NOT NULL,           -- bumped on every save (CAS)
  server_folder TEXT,                  -- Drafts path holding our copy
  server_uidvalidity INTEGER,
  server_uid INTEGER,                  -- APPENDUID of our latest copy
  server_revision INTEGER,             -- revision that copy holds
  server_size INTEGER,                 -- RFC822 size of that copy
  origin TEXT NOT NULL DEFAULT 'owner',-- seam for 3c; always 'owner' in 3b
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX compose_drafts_account ON compose_drafts(account_id);

-- attachment bytes for drafts and queued sends
CREATE TABLE compose_attachments (
  id TEXT PRIMARY KEY,
  draft_id TEXT NOT NULL REFERENCES compose_drafts(id) ON DELETE CASCADE,
  file_name TEXT NOT NULL,             -- sanitizeFileName() result
  mime_type TEXT NOT NULL,             -- safeContentType() result
  size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  data BLOB NOT NULL,
  position INTEGER NOT NULL
);

-- outbox: one row per Send; holds the exact bytes
CREATE TABLE outbox (
  id TEXT PRIMARY KEY,                 -- idempotency key
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  draft_id TEXT,                       -- kept until done, for Undo / Edit
  message_id TEXT NOT NULL,
  envelope_from TEXT NOT NULL,
  envelope_to_json TEXT NOT NULL,      -- To + Cc + Bcc addresses
  mime BLOB NOT NULL,                  -- bytes sent (no Bcc header)
  sent_copy_mime BLOB,                 -- bytes appended to Sent (with Bcc), or NULL
  state TEXT NOT NULL,                 -- see state machine
  send_after INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  error_kind TEXT,                     -- errorKind(); never the server's text
  rejected_json TEXT,                  -- recipients the server refused
  origin TEXT NOT NULL DEFAULT 'owner',
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX outbox_state ON outbox(state, send_after);

-- hide superseded draft copies on servers without UIDPLUS (see Drafts)
ALTER TABLE messages ADD COLUMN is_deleted INTEGER NOT NULL DEFAULT 0;
```

Notes:

- `saveAccount` stays an `ON CONFLICT DO UPDATE` upsert and gains the new
  columns; it never becomes `REPLACE` (which would cascade-delete mail and,
  now, drafts and outbox rows).
- Deleting an account cascades its drafts, attachments and outbox rows. A
  row in `sending` blocks `accounts_remove` with "A message is being sent"
  until it settles.
- `messages.is_deleted` is set by sync from the `\Deleted` flag (the flags
  fetch already returns flags); list, count, search and mention queries add
  `AND is_deleted = 0`. This hides the superseded copies the plugin marks on
  servers without UIDPLUS, and any `\Deleted` mail another client left.
- No Reply-To column is added: Reply-To comes from the raw original at
  `compose_prepare` time (below).
- Attachments in SQLite: at most 25 MB per draft and per outbox row (the
  outbox stores the encoded MIME, about 34 MB at the cap). A done outbox row
  is deleted; a sent draft is deleted. The `vaultKey` does not cover these
  bytes, same as synced mail bodies today.

### Core: ports (src/core/ports.ts)

```ts
export interface MailTransport {
  /** Verify connect + TLS + AUTH; sends nothing. */
  verify(config: SmtpConfig): Promise<void>;
  /** Send prepared bytes with an explicit envelope. Throws SendError. */
  send(config: SmtpConfig, message: {
    envelopeFrom: string; envelopeTo: string[]; raw: Uint8Array;
  }, signal: AbortSignal): Promise<SendResult>;
}
export interface SmtpConfig {
  host: string; port: number; security: "tls" | "starttls";
  username: string; password: string;
}
export interface SendResult {
  accepted: string[]; rejected: string[]; response: string; // response never logged
}
export type SendErrorKind =
  | "auth" | "tls" | "connect" | "timeout_before_data" | "rejected_all"
  | "too_large" | "unknown_after_data";
// SendError carries .kind and whether DATA was started.

export interface MessageBuilder {
  /** Build RFC 5322 bytes once. Pure output from core input. */
  build(input: OutgoingMessage): Promise<{ raw: Uint8Array; withBcc: Uint8Array | null }>;
}
```

`FolderSession` (the writable session) gains:

```ts
capabilities(): { uidplus: boolean; gmail: boolean };     // UIDPLUS, X-GM-EXT-1
appendMessage(raw: Uint8Array, flags: string[]):
  Promise<{ uidValidity: number | null; uid: number | null }>;
findByMessageId(messageId: string): Promise<number[]>;    // UID SEARCH HEADER Message-ID
expungeOwn(uid: number, guard: { messageId: string; size: number }): Promise<void>;
  // throws ExpungeUnsupported without UIDPLUS, GuardMismatch if the uid's
  // Message-ID or RFC822.SIZE differ; otherwise STORE +FLAGS \Deleted then
  // UID EXPUNGE <uid> on that uid alone.
markDeleted(uid: number, guard: { messageId: string; size: number }): Promise<void>;
  // the no-UIDPLUS path: \Deleted only, no expunge
```

`OutgoingMessage` (core type) is plain data: `from {name,address}`, `to`,
`cc`, `bcc` (address lists), `subject`, `messageId`, `date`, `inReplyTo`,
`references`, `html`, `text`, `attachments: {fileName, mimeType, bytes,
contentId?}[]`, and `forwardedRfc822?: bytes` (only if Open question 5 picks
it). `SmtpConfig` and `OutgoingMessage` hold no host objects, so core stays
host-free.

### Core: pure logic (new src/core files)

- `compose-address.ts`: parse and validate one address (`local@domain`,
  3–320 chars, no CR/LF/NUL, no `<>,;"` outside a quoted display name, IDN
  domains accepted as typed and punycoded by the builder), display-name
  quoting, case-insensitive dedupe by address.
- `compose-reply.ts`:
  - **Reply rules.** Reply: To = Reply-To of the original if present, else
    From. If the original's From is one of the owner's account addresses (a
    reply to one's own sent message), To = the original's To and Cc = its Cc.
    Reply all: To = the Reply target plus the original's To; Cc = original
    Cc; then remove every address of every connected account (not only the
    From account), dedupe case-insensitively, and if that leaves To empty,
    move Cc into To. Bcc is never carried. Address comparison lowercases the
    whole address; Gmail dot and plus variants are **not** folded (an
    alias the owner did not configure is still a different address).
  - **Subject prefixes.** Strip leading reply and forward markers, repeated
    and mixed, with optional `[n]` or `(n)` counters, before adding one:
    replies recognize `Re`, `RE`, `Aw`, `AW`, `Sv`, `Antw`, `Odp`, `Rif`,
    `R`, `Vs`, `VS`, `Ответ`, `Отв`; forwards recognize `Fwd`, `Fw`, `FW`,
    `WG`, `TR`, `Pd`, `Пересл`. Reply gives `Re: <stripped>`, Forward gives
    `Fwd: <stripped>`. A reply to `Fwd: x` gives `Re: Fwd: x` is **not**
    produced: only the outermost run of markers is stripped and one prefix
    added, so `Re: Fwd: x` stays as is when replied to again. Matching needs
    the colon (full-width `：` too) so a subject such as "Revenue" is left
    alone.
  - **Threading.** In-Reply-To = the original's Message-ID; References = the
    original's References (or its In-Reply-To when References is empty) plus
    its Message-ID, deduped, trimmed from the front to the first id plus the
    last 20 (RFC 5322 3.6.4 practice). Forward sets neither (Open question 5
    notes the alternative).
  - **Quote header.** "On <date>, <name> <address> wrote:" for replies; a
    "Forwarded message" block (From, Date, Subject, To, Cc) for forwards. The
    header text is built from parsed fields as text nodes, never as HTML.
- `compose-doc.ts`: the TipTap document schema the server accepts (zod) and
  the **renderer** from document to `{html, text}`. Allowed nodes: doc,
  paragraph, text, hardBreak, bulletList, orderedList, listItem, blockquote.
  Allowed marks: bold, italic, underline, link. A link mark keeps `href`
  only if it parses as `http:`, `https:` or `mailto:`; anything else drops
  the mark and keeps the text. Text is HTML-escaped; no attribute other than
  `href` is emitted; the output is wrapped in a fixed minimal HTML skeleton.
  The text alternative wraps at 76 columns, renders links as `text <url>`,
  lists as `- ` / `1. `, quotes as `> `. Size limits: 2 MB of document JSON,
  depth 32.
- `compose-outbox.ts`: the state machine (below), the `queueSend` use case
  and the Sent-copy decision.
- `compose-drafts.ts`: autosave scheduling decisions (which revision to push
  to the server, when) as pure functions over `{revision, serverRevision,
  updatedAt, now}`.

### Body format and quoting

- The page edits with TipTap and sends **only the document JSON**. The
  server validates it against the schema above and renders HTML and text
  itself. HTML from the page is never accepted, so compose HTML is
  "sanitized on output" by construction: the renderer can only emit the
  whitelisted tags.
- Quoting: the page already shows the original through `sanitizeEmailHtml`
  (DOMPurify, remote images stripped). For a reply or forward the page takes
  that sanitized HTML, loads it into the TipTap editor (which parses it into
  the schema, dropping everything the schema does not know: styles, tables,
  images, fonts, scripts), and wraps it in a blockquote. The result is a
  structured document, so the server-side renderer re-escapes everything.
  The quote is therefore **lossy** (layout of rich newsletters is flattened);
  Open question 5 offers forward-as-attachment for full fidelity.
- Before handing HTML to the editor, the page runs it through
  `sanitizeEmailHtml` with remote images off and removes every `<img>`
  (including `data:` and `cid:`) so TipTap's parser never creates an image
  and the browser never fetches one. TipTap parses with `DOMParser` into an
  inert document; whether an inert parse can trigger any fetch is
  **[unverified]** but irrelevant once `<img>`, `<link>`, `<style>` and
  `srcset` are gone, which DOMPurify guarantees.
- No image node exists in the schema in 3b. Pasted or dropped image files
  become attachments. Forwarded `cid:` images travel as the original's
  attachments (inline parts are re-attached as regular attachments, with
  their Content-ID kept so mail clients that honor it still show them).
- The Link extension is configured `openOnClick: false`, `autolink: true`,
  protocols `http`, `https`, `mailto` only; the renderer enforces the same
  list again.

### Message building (adapter, nodemailer)

- `src/adapters/bb/mime-builder.ts` implements `MessageBuilder` with
  nodemailer's `MailComposer` (`nodemailer/lib/mail-composer`, an exported
  subpath of nodemailer 10.x; verified in the package's `exports`
  metadata). It is the only place headers are written.
- Built once per Send: Message-ID (the draft's stable `<random@domain>`,
  domain taken from the From address), Date, From, To, Cc, Subject,
  In-Reply-To, References, `MIME-Version`, `multipart/alternative` (text and
  HTML) inside `multipart/mixed` when there are attachments. No `X-Mailer`
  (set it to an empty/false value if nodemailer adds one by default —
  **[unverified]** default).
- Every header value comes from validated core data: addresses from
  `compose-address`, the subject with CR, LF and NUL rejected at the RPC
  boundary (zod refine) and again in the builder. Header injection needs a
  newline; none can reach the builder.
- Attachments are passed by `content` (a Buffer) only, never `path` or
  `href`; the composer runs with file and URL access disabled
  (`disableFileAccess`, `disableUrlAccess` — option names from nodemailer's
  docs, **[unverified]** in 10.x types until installed).
- **Bcc and "same bytes".** The bytes sent over SMTP have no Bcc header; the
  envelope carries Bcc recipients. The Sent copy (when appended) is the same
  bytes with one `Bcc:` header line inserted in the header block, so the
  owner can see whom they Bcc'd, as Apple Mail and Thunderbird do. Everything
  else (Message-ID, Date, body, boundaries) is byte-identical. When there is
  no Bcc, the Sent copy is exactly the sent bytes. See Open question 4.
- Size: the encoded size is computed after building; over the cap the send
  is refused before any network use (`too_large`).

### SMTP transport (adapter, nodemailer)

- `src/adapters/bb/smtp-transport.ts` implements `MailTransport` with
  `nodemailer.createTransport({host, port, secure: security === "tls",
  requireTLS: security === "starttls", auth: {user, pass}, tls:
  {minVersion: "TLSv1.2", rejectUnauthorized: true, servername: host},
  connectionTimeout, greetingTimeout, socketTimeout})` and
  `sendMail({envelope: {from, to}, raw})`. One transport per send, closed
  after (no pool; volumes are tiny and a pool would hold the password longer).
- `requireTLS` makes STARTTLS mandatory on 587; `secure` is implicit TLS on
  465. Ports other than 465 and 587 are accepted for custom servers only with
  an explicit security choice; there is no "none" option.
- Option names `raw`, `envelope`, `requireTLS` follow nodemailer's
  documentation and are **[unverified]** against the installed 10.x types
  (not installed during design).
- nodemailer honors an `AbortSignal` per send; its README warns a cancel
  does not prove the server did not accept the message. The adapter maps
  "aborted or failed after DATA began" to `unknown_after_data`, never to a
  retryable kind.
- nodemailer: version 10.5.0 is the latest (2026-11-10), licence MIT-0, no
  dependencies, ships its own types, engines `node>=20`. Pin a version at
  least two weeks old at install time: **10.3.1** (2026-10-29) today.
  `@types/nodemailer` is not needed. Record nothing in
  `THIRD_PARTY_NOTICES.md` (a dependency, not vendored code).
- Logging: nodemailer's `logger` and `debug` stay off; no SMTP response text,
  address or subject reaches a log, an error message, realtime or the
  outbox row (only `error_kind`).

### Presets

`src/core/presets.ts` gains `smtp` per preset: iCloud `smtp.mail.me.com`, 587,
`starttls`, `sentCopy: "append"`; Gmail `smtp.gmail.com`, 465, `tls`,
`sentCopy: "server"`; Other: none (fields required). SMTP username defaults to
the IMAP username (iCloud's SMTP username is the full address
**[unverified]**; if the live check shows otherwise the preset sets it).
`addAccount` for a preset fills SMTP from the preset; for Other it requires
SMTP fields and verifies both IMAP and SMTP before saving.

### Drafts on the server

Two copies, chosen as a hybrid (Open question 2):

1. **Local autosave**: every change saves `compose_drafts` (debounced 1.5 s
   in the page; also on blur, close and `visibilitychange`). This is the
   copy that protects against a lost draft.
2. **Server copy**: the server appends the draft to Drafts 30 s after the
   last change that the server copy lacks, and immediately on composer close
   and on an explicit **Save draft**. A send skips it.

Server copy procedure (one per draft, serialized per account with all other
writes of that account):

1. Build the draft MIME with the same builder (no Bcc stripping: a draft
   keeps Bcc so another client can continue it), flags `\Draft \Seen`.
2. `appendMessage` to the account's Drafts folder (special use `drafts`; no
   Drafts folder = local only, with a note in the composer).
3. Record `server_uid`, `server_uidvalidity`, `server_revision`,
   `server_size` from APPENDUID.
4. Remove the previous copy: if the session has UIDPLUS, the previous uid
   came from our own APPENDUID, and UIDVALIDITY is unchanged, call
   `expungeOwn(prevUid, {messageId, size: prevSize})`. The guard fetches
   `ENVELOPE`/`RFC822.SIZE` of that uid with BODY.PEEK semantics and refuses
   on any mismatch.

**The expunge exception.** README's "It never expunges" becomes: "It
expunges only its own superseded drafts: after saving a newer copy of a
draft, it removes the previous copy it wrote, by UID, on servers with
UIDPLUS." imapflow 2.11.0's `messageDelete(range, {uid: true})` sends UID
EXPUNGE only when UIDPLUS is present and otherwise a plain EXPUNGE that
removes **every** `\Deleted` message in the folder (verified in
`dist/esm`). The gateway therefore checks `client.capabilities.has("UIDPLUS")`
itself and never calls `messageDelete` without it; `expungeOwn` throws
`ExpungeUnsupported`. A test pins this.

**Without UIDPLUS:** no periodic server autosave (each save would leave a
copy behind). The server copy is written only on close, Save draft and
Discard-is-not-chosen; the previous copy is marked `\Deleted` by
`markDeleted` and never expunged, and `messages.is_deleted` hides it here.
Other clients may show it until they expunge. Whether iCloud has UIDPLUS is
**[unverified]**; it has MOVE or UIDPLUS (moves work there today).

**Gmail.** UID EXPUNGE in `[Gmail]/Drafts` removes the label; Gmail may keep
the message in All Mail or delete it, depending on the account's "When a
message is marked as deleted and expunged" setting **[unverified]** for
Drafts. Gmail is known to manage Drafts specially; the live check covers it.

**Conflicts.**

- Two tabs: every `compose_save` carries the revision it was based on; the
  store updates with `WHERE revision = ?`; a stale save returns `conflict`
  and the composer shows "This draft changed in another window" with
  **Reload** (discard this window's edits) and **Keep mine** (save as the new
  revision).
- Our server uid vanished (another client edited or deleted the draft, or
  UIDVALIDITY changed): the next server copy is appended as new, nothing is
  deleted, and the composer notes "This draft was changed elsewhere; both
  versions are kept in Drafts."
- **Resuming a draft made elsewhere** (a message in Drafts that has no
  `compose_drafts` row): `compose_open` with `draftMessageId` fetches its raw
  source with the guarded raw fetch, parses it, and creates a
  `compose_drafts` row whose `server_uid` points at it and whose
  `message_id` is the draft's own Message-ID. Its first server save
  supersedes it under the same exception (Open question 3). Parsing an
  outside draft's HTML into the editor uses the quoting path (sanitize, drop
  images, parse into the schema); attachments become `compose_attachments`.
- Sync sees our own appended drafts as ordinary Drafts messages. The row
  whose `(folder, uid)` matches a `compose_drafts.server_uid` shows **Edit
  draft** and opens that draft instead of creating a second one.

After a successful send the plugin's server draft is removed by the same
exception (or marked `\Deleted` without UIDPLUS) and the local draft row is
deleted when the outbox row reaches `done`.

### Outbox and sending

State machine (`compose-outbox.ts`, persisted in `outbox.state`):

```
queued ──(send_after reached)──► sending ──(250 after DATA)──► sent
  │                                │                              │
  │ Undo (CAS on queued)           ├─ error before DATA ─► failed │ (sent_copy='append')
  ▼                                │                              ▼
cancelled → draft back             └─ error/abort after DATA,   appending ──► done
                                      or restart in sending       │
                                      ─► unknown                  └─ fails ─► sent_no_copy
```

- **Queue.** `compose_send` validates, builds the MIME once (`mime` and, for
  `append`, `sent_copy_mime`), inserts the outbox row with `id = newId()` as
  the idempotency key, `state = queued`, `send_after = now + 10 s`, and
  keeps the draft row (for Undo). The RPC takes a client-generated
  `requestId` (UUID) stored as the outbox id: a repeated `compose_send` with
  the same id returns the existing row instead of queuing a second message,
  so a double click or a retried RPC cannot send twice.
- **Undo.** `outbox_cancel({id})` updates `state = cancelled WHERE id = ? AND
  state = 'queued'`; zero rows changed means "too late — already sending".
  On success the composer reopens the draft.
- **Send.** The sync service's background loop gains a small outbox worker
  (same `bb.background.service`, separate timer, woken by `compose_send` and
  checked every 5 s): it takes one due row per account, sets
  `state = sending, attempts = attempts + 1` with a CAS on `queued`/`failed`
  (Retry), and only then opens SMTP. Writes per account are serialized with
  the IMAP push (one connection at a time per account, matching provider
  connection limits).
- **Sent copy.** After `sent`: `sent_copy = 'server'` (Gmail) → `done`.
  `append` → `appending`: `findByMessageId` in the Sent folder first (makes
  the APPEND idempotent across retries and restarts), then
  `appendMessage(sent_copy_mime, ["\\Seen"])`. Success → `done`; the sync is
  woken so the Sent folder shows the message.
- **Done.** Delete the outbox row and the draft row with its attachments;
  remove the server draft (exception). Realtime `mail-changed`
  `{accountId}` as today, plus a new channel `outbox-changed`
  `{accountId, id, state}` (ids and states only).

**Failure matrix** (what the owner sees; never an automatic resend once
DATA may have been accepted):

| Situation | State after | Shown to the owner | Retry is safe? |
| --- | --- | --- | --- |
| Undo within 10 s | `cancelled`, draft back in composer | Composer reopens | n/a |
| Undo after the worker took it | stays `sending` | "Too late to undo" | n/a |
| DNS / connect / TLS failure | `failed` (`connect`/`tls`) | "Not sent · Retry" | yes, nothing reached the server |
| AUTH refused | `failed` (`auth`); account flagged | "Not sent: sign-in refused · Retry" + account error | yes |
| Size refused (552 / SIZE) | `failed` (`too_large`) | "Too large for the server · Edit" | after editing |
| All recipients refused (RCPT 5xx) | `failed` (`rejected_all`) | "Not sent: recipients refused · Edit" | after editing |
| Some recipients refused, rest accepted | `sent` → copy step; `rejected_json` kept | "Sent, but not to: <addresses>" | no; Edit to send a new message to them |
| Timeout or abort before DATA | `failed` (`timeout_before_data`) | "Not sent · Retry" | yes |
| Connection lost or timeout after DATA started | `unknown` | "May have been sent · Send again · Discard" | owner decides |
| BB restarts while `queued` | `queued`, `send_after` kept (Open question 10) | Toast on next open: "Sending in N s · Undo" | n/a |
| BB restarts while `sending` | `unknown` | "May have been sent · Send again · Discard" | owner decides |
| SMTP accepted, Sent APPEND fails | `sent_no_copy` after 3 tries (search-then-append each time) | "Sent; the Sent copy failed · Retry copy · Dismiss" | yes (idempotent by Message-ID search) |
| SMTP accepted, restart before APPEND | `sent` on restart → copy step resumes | nothing, unless it fails | yes |
| Sent folder missing (`append`) | `sent_no_copy` | "Sent; no Sent folder to copy to · Dismiss" | n/a |
| Account removed with rows queued | rows cascade-deleted only if not `sending` (removal blocked meanwhile) | removal explains | n/a |

For `unknown` on Gmail (`sent_copy = 'server'`), the worker first runs
`findByMessageId` in the Sent folder: found → `done` with "Sent"; not found
after one minute → still `unknown` (Gmail may lag), owner decides. For
`append` accounts the Sent folder proves nothing (the plugin writes it), so
the owner decides directly. **Send again** re-sends the same bytes with the
same Message-ID, so a duplicate is at least recognizable and threads with
the first; **Discard** deletes the row and reopens nothing.

Retries are owner-driven (**Retry**) except the APPEND step, which retries
automatically up to 3 times with backoff because it is idempotent.

### Attachments upload

The controller ruled one-time tickets and an HTTP upload route, as for
downloads. BB 0.49.0's host answers **415** to any non-GET plugin HTTP
request under `auth: "local"` whose content type is not `application/json`
(read in `start-server.js`), and HTTP routes carry no caller identity, so
`refusePluginCaller` cannot apply to them. A binary upload route would have
to lie about its content type or use `auth: "none"`. Recommended instead
(Open question 1): **chunked base64 over owner-only RPC**:

- `compose_attachment_begin({draftId, fileName, mimeType, size})` →
  `{uploadId}`; refuses if `size` exceeds the per-file cap or would exceed
  the per-message cap with what the draft already has.
- `compose_attachment_chunk({uploadId, offset, dataBase64})`: chunks of at
  most 512 KiB decoded, strictly sequential offsets (a gap or overlap is
  refused), base64 validated.
- `compose_attachment_finish({uploadId, sha256})` → the attachment record;
  the server checks size and SHA-256, applies `sanitizeFileName` and
  `safeContentType`, and stores it in `compose_attachments`.
- `compose_attachment_remove({draftId, attachmentId})`.

In-flight uploads live in memory, bounded to 64 MB total and 16 uploads,
expire after 5 minutes idle, and vanish on restart (the page restarts the
upload). Finished attachments are in SQLite and so survive restarts and
reach the outbox. No body-size limit for plugin RPC was found in the BB host
code (a plugin RPC body is parsed with `JSON.parse`); 512 KiB chunks stay far
below any reasonable limit if one exists. Attachment names, types and bytes
are never logged or published.

Caps: **25 MB per file and 25 MB per message** (sum of attachment sizes;
the encoded message is about a third larger). iCloud's limit may be 20 MB
**[unverified]**; the cap is `min(25 MB, preset limit)` once the live check
confirms provider limits, and the SMTP server's advertised `SIZE` (when
present) refuses earlier with `too_large` **[unverified]** whether
nodemailer exposes it before DATA.

Forward attachments: `compose_prepare` for a forward fetches the original
with `fetchRawGuarded` (UIDVALIDITY, 50 MB and Message-ID guards from 3a),
parses with `parseMail` (postal-mime), and copies its attachments and inline
parts into `compose_attachments` (subject to the same caps; over the cap the
composer lists which were left out).

### RPC shapes (src/core/contract.ts)

All new methods are registered with `{experimental_discoverable: false}`,
start with `refusePluginCaller(context)`, return `errorKind` on failure
(never the error message), and validate every string with the existing
patterns (`idInput`, `addressInput`, no CR/LF/NUL in any header field).

```ts
compose_prepare: { kind: "reply"|"reply_all"|"forward", messageId: idInput }
  → { draftId }   // creates the compose_drafts row with recipients, subject,
                  // threading headers, quote doc, forwarded attachments;
                  // falls back to stored fields (no Reply-To, no attachments)
                  // with warning:"original_unavailable" when the raw fetch fails
compose_new:     { accountId: idInput } → { draftId }
compose_open:    { draftId: idInput } | { draftMessageId: idInput }
  → { draft: DraftView, warning? }  // DraftView: fields, doc, attachments
                                    // (id, name, type, size), revision
compose_save:    { draftId, baseRevision: int, accountId, to, cc, bcc:
                   addressInput[] (≤ 100 each), subject: string ≤ 998,
                   doc: ComposeDoc, saveToServer?: boolean }
  → { revision } | { conflict: true, revision }
compose_discard: { draftId } → { ok: true }
compose_attachment_begin / _chunk / _finish / _remove   (above)
compose_send:    { draftId, baseRevision, requestId: uuid }
  → { outboxId, sendAfter }
outbox_list:     { accountId?: idInput } → OutboxRow[] // id, accountId, subject
                                                       // (local display only), state,
                                                       // errorKind, rejected
outbox_cancel:   { id } → { cancelled: boolean }
outbox_retry:    { id } → { ok: true }    // only from failed / sent_no_copy
outbox_resend:   { id } → { ok: true }    // only from unknown
outbox_dismiss:  { id } → { ok: true }    // unknown, sent_no_copy
recipients_suggest: { prefix: string 1–64 } → { name, address }[] (≤ 10)
accounts_smtp_test: { accountId, host, port, security, username? } → { ok } | errorKind
accounts_smtp_set:  same → { ok }
```

`recipients_suggest` reads the local store only: distinct From, To and Cc
addresses of synced messages (and of the owner's sent mail first), ranked
by recency and count, prefix-matched on address and display name. No
network.

`origin` is fixed to `"owner"` in every 3b RPC; the field and
`queueSend(message, {origin})` exist so 3c can add an agent origin with a
confirmation step without a migration.

### Server composition (server.ts)

- Wires `MailTransport` (smtp-transport), `MessageBuilder` (mime-builder),
  the store and gateway into new use cases; `AccountDeps` gains `transport`
  and `builder`.
- The outbox worker runs inside the existing background service; a crash
  restarts it with backoff (host behaviour of `bb.background.service`). On
  start it moves every `sending` row to `unknown` before taking new work.
- No new agent tool, CLI command, mention provider or skill capability.
  `skills/mail/SKILL.md` gains one sentence: agents cannot send, draft or
  reply.

### UI

- **Placement.** Wide layout (`useWideLayout`, ≥ 768 px): the composer is a
  panel in the conversation area. A new message replaces the reading pane;
  a reply or forward docks under the open conversation. Narrow layout: the
  composer is the full page with a back button. One toolbar at a time: while
  the composer has focus its formatting toolbar is the only toolbar shown in
  that area (the reading pane's action toolbar and the selection panel stay
  hidden), matching 3a's "one action toolbar at a time" rule.
- **Fields.** From (a select of connected accounts with SMTP configured; the
  vendored `select`), To, Cc and Bcc as chip inputs (Cc and Bcc collapsed
  behind "Cc Bcc" until used), Subject (`input`), the editor, attachment
  chips (name, size, remove), and the footer: **Send**, **Discard**, a
  save-state line ("Saved", "Saving…", "Saved on this computer — server copy
  failed").
- **Chips.** Enter, comma, semicolon or Tab turns typed text into a chip;
  paste of a list splits it; an invalid address is a chip in the error style
  with its reason as the accessible description; Backspace on an empty input
  selects the last chip. Autocomplete is a listbox under the input fed by
  `recipients_suggest` (debounced 150 ms).
- **Toolbar.** Bold, italic, underline, bulleted list, numbered list, link,
  quote, clear formatting — icon buttons with labels and key hints
  (Cmd/Ctrl+B, I, U, K), `role="toolbar"` with roving focus like the reading
  pane.
- **Keys.** `c` compose, `r` reply, `a` reply all, `f` forward on the Mail
  page (not while typing; `g a` keeps meaning All accounts since `g` starts a
  sequence). Cmd/Ctrl+Enter sends from any composer field. Escape in the
  composer: if nothing changed since the last save, close; otherwise a
  dialog (vendored `dialog`) "Save draft · Discard · Keep editing". The
  shortcut sheet drops `soon: true` for c, r, a, f and adds Cmd/Ctrl+Enter
  and Escape. `isTypingTarget` already ignores contenteditable, so the
  editor never triggers list keys.
- **Drag and drop / paste.** Dropping files anywhere on the composer, or
  pasting files or images, adds attachments; a drop outside the composer does
  nothing. Pasted HTML goes through the editor's schema (TipTap drops what it
  does not know) after a `transformPastedHTML` that runs `sanitizeEmailHtml`
  and removes images.
- **Outbox UI.** Toasts as in the flows; an Outbox section at the top of the
  Sent role's list while rows are not `done`; the nav rail's Sent shows a
  small count of failed or unknown rows.
- **Editor isolation.** The editor is a normal contenteditable in the
  plugin page, not the sandboxed reading frame. It only ever holds content
  that went through DOMPurify and the schema, so no script, style or remote
  resource reaches it.

**Architecture allow-list.** `tests/architecture.test.ts` matches a `ui`
package by exact name or by `name + "/"` prefix. The `ui.packages` array
gains exactly: `"@tiptap/react"`, `"@tiptap/core"`, `"@tiptap/pm"`,
`"@tiptap/starter-kit"`, `"@tiptap/extension-link"`,
`"@tiptap/extension-underline"` (if not already in starter-kit 3.x; starter
kit 3.x lists underline and link — then only the first four entries plus
`"@tiptap/extensions"` for the placeholder). Not `"@tiptap"` (that prefix would
allow every TipTap package). `@tiptap/pm/*` subpaths (`@tiptap/pm/state`,
`@tiptap/pm/model`) are allowed by the `@tiptap/pm` prefix rule. These
packages use the DOM and React only, no host API, so `src/ui` stays host-free;
`src/core` gains nothing (the document schema in core is zod, the renderer is
plain TypeScript).

TipTap 3.34.0 is current (2026-11-13), MIT. Pin a version at least two weeks
old: **3.32.2** (2026-10-30) today. `@tiptap/react` peers on `react` and
`react-dom`; the BB build shims React and `react-dom` already resolves
(Radix portals use it), but whether TipTap's `EditorContent` works with the
shim is **[unverified]** until the first build. Bundle size impact (`app.js`
is 151 KB today) is **[unverified]**; core is 3.3 MB unpacked but tree-shaken
bundles are typically far smaller. Whether `bb plugin build` code-splits so
the editor loads only when opened is **[unverified]**.

### Security and privacy

- **Owner only.** Every compose, outbox, recipient and SMTP RPC calls
  `refusePluginCaller` and is non-discoverable. As README already states for
  other RPCs, a process with shell access to the BB server can still call
  local plugin RPC; README says this now includes sending.
- **No new HTTP route.** Uploads go over RPC (Open question 1), downloads
  keep the 3a ticket route.
- **SMTP.** TLS 1.2+, certificate verification on, STARTTLS mandatory on
  587, no plaintext option. The password is unsealed from the vault for one
  send and dropped after; it never enters a log, an error or the outbox row.
- **Headers.** CR, LF and NUL refused in every header input at the RPC
  boundary and in the builder; addresses validated by one core parser; the
  builder is the single writer of headers.
- **HTML.** Server-rendered from a validated document with a tag whitelist;
  links limited to http, https, mailto; quoted mail passes DOMPurify, loses
  images and is parsed into the schema; the server never accepts page HTML.
- **Attachments.** Names through `sanitizeFileName` (no path separators,
  no `..`, control characters stripped, length capped); types through
  `safeContentType`; bytes in SQLite only, never on disk paths, never passed
  to nodemailer as `path`. Upload chunks bounded in size, count and time.
- **Mail is data.** Quoted text, subjects and addresses from received mail
  are never interpreted; nothing from a message chooses a recipient except
  the documented Reply rules (Reply-To included, which is standard and
  visible as chips before sending).
- **Logs and realtime.** Nothing about content, recipients, subjects or file
  names; realtime carries account ids, outbox ids and states.
- **Server writes, stated in the overview.** README, `PLUGIN_OVERVIEW.md`,
  `bb.description` and the marketplace entry gain: it sends mail you write
  through your SMTP server; it appends drafts to Drafts and sent copies to
  Sent (except Gmail, which keeps its own); it removes only its own
  superseded drafts, by UID, on servers with UIDPLUS.

### Agent surfaces

Unchanged: `mail_search`, `mail_read`, mention, Hand to agent and CLI read.
Drafts and outbox rows are not exposed to agents; a draft synced from the
server is an ordinary Drafts message to `mail_search`, as today.

## Testing

Core with fakes, store on real SQLite, adapters with mapper and fake-server
tests, UI with Testing Library and jsdom, as in earlier slices. Named risks
and the tests that pin them:

- **Double send.**
  - `compose_send` twice with one `requestId` queues one row.
  - The worker's CAS: two workers (or a tick racing an Undo) cannot both move
    a row to `sending`.
  - Restart in `sending` → `unknown`, never `queued`; no transport call
    happens on restart.
  - A transport error after DATA maps to `unknown`, not `failed`; Retry is
    refused for `unknown`.
  - APPEND retry searches Sent by Message-ID first; a found copy is not
    appended again.
- **Lost draft.**
  - Every save writes the local row before any server step; a server
    failure leaves the local row and shows "server copy failed".
  - The previous server copy is expunged only after the new APPEND returned a
    uid; APPEND failure deletes nothing.
  - A vanished server uid appends a new copy and deletes nothing.
  - Revision CAS returns `conflict` for a stale tab.
  - Undo restores the draft exactly (fields, doc, attachments).
- **Expunge safety.**
  - `expungeOwn` without UIDPLUS throws and issues no command; a test against
    a fake imapflow client asserts `messageDelete` is never called and no
    plain EXPUNGE is sent.
  - The guard refuses when Message-ID or size differ.
  - Only uids recorded from our own APPENDUID are ever passed in.
- **Wrong Reply-all recipients.** Table tests: Reply-To present/absent;
  original from me; owner's addresses in To and Cc across all accounts; case
  variants; duplicates; empty To after removal; Bcc never carried; Reply to a
  message in Sent.
- **Header injection.** CR, LF, NUL, and encoded `%0d%0a` in subject, display
  names and addresses are refused at zod and again in the builder; built
  output parsed back with postal-mime shows exactly the expected headers.
- **Attachment path traversal.** File names `../../x`, `/etc/passwd`,
  `C:\x`, names with control characters and very long names come out
  sanitized; the builder receives `content` only (a spy asserts no `path`
  or `href` key); the composer has file and URL access disabled.
- **HTML injection through quoted mail.** Fixtures with `<script>`,
  `onerror`, `javascript:` links, `<style>`, `srcset`, `<svg>`, `<form>`,
  `<base>`, CSS `url()` and remote `<img>` produce a document with none of
  them and server HTML with only whitelisted tags; a `javascript:` link
  becomes plain text; no `img` node can exist.
- Other core tests: subject prefixes (each localized marker, stacked and
  mixed, counters, "Revenue" untouched, full-width colon); References
  trimming; renderer HTML and text output; address parsing; Sent-copy
  decision; failure matrix rows one by one.
- Store: migration 4 appended (elements 0–3 byte-identical to before — a
  test compares them to a frozen copy), preset backfill, cascades, CAS
  updates, `is_deleted` filtering in lists and counts.
- Upload: chunk order, gaps, oversize, SHA mismatch, idle expiry, memory
  bound, refusal for plugin callers.
- Server: every new RPC refuses plugin callers and is non-discoverable; no new
  tool, CLI command or mention; realtime payloads contain only ids and
  states.
- UI: chips, autocomplete, toolbar, keys (c/r/a/f, Cmd/Ctrl+Enter, Escape
  dialog), one toolbar at a time, Undo toast, outbox rows, drop and paste.
  Fixtures use made-up addresses on `example.com`/`example.org` only.

### Live verification (owner's accounts, after the build)

1. iCloud: SMTP 587 STARTTLS login with the app password; username form.
2. iCloud: does the IMAP session advertise UIDPLUS? (decides draft autosave)
3. iCloud: message size limit (20 MB?) with a 19 MB and a 21 MB test send to
   self.
4. Gmail: SMTP 465 login; the sent message appears once in Sent (no
   duplicate from the plugin); Message-ID preserved.
5. Gmail: a draft saved twice leaves exactly one draft in `[Gmail]/Drafts`
   and in the Gmail web UI; what happens to the expunged copy (All Mail?).
6. Reply and Reply all thread correctly in Gmail web, Apple Mail and iCloud
   web; prefixes not stacked on a second reply.
7. Forward of a message with attachments and `cid:` images: attachments
   arrive; images show where the recipient's client honors Content-ID.
8. Undo within 10 s sends nothing (check the recipient); kill BB during the
   10 s, restart, toast offers Undo with the remaining time.
9. A draft started here shows in Apple Mail's Drafts and can be continued
   there; a draft started in Apple Mail opens here with **Edit draft**.
10. TipTap builds under `bb plugin build`, works with the React shim, and
    the `app.js` size is recorded.

## Tasks

Each task ends with `npm run check`; the last also with `npm run build` and
`node ../../scripts/check-manifests.mjs`. Paths are under `plugins/mail/`.

1. **Core compose logic.** `src/core/compose-address.ts`,
   `src/core/compose-reply.ts`, `src/core/compose-doc.ts` (schema +
   renderer), tests `tests/core/compose-address.test.ts`,
   `tests/core/compose-reply.test.ts`, `tests/core/compose-doc.test.ts`.
   No dependency changes.
2. **Ports, contract, outbox state machine.** `src/core/ports.ts`
   (`MailTransport`, `MessageBuilder`, `FolderSession` additions, new
   `MailStore` methods), `src/core/contract.ts` (new RPC schemas,
   `OUTBOX_CHANGED_CHANNEL`), `src/core/compose-outbox.ts`,
   `src/core/compose-drafts.ts`, `src/core/presets.ts` (SMTP), tests
   `tests/core/compose-outbox.test.ts`, `tests/core/compose-drafts.test.ts`,
   `tests/core/presets.test.ts`.
3. **Store and migration 4.** `src/adapters/bb/sqlite-store.ts` (element 4,
   new tables and methods, `is_deleted` filters, `saveAccount` columns),
   `tests/adapters/sqlite-store.test.ts` (frozen 0–3 check, backfill,
   cascades, CAS).
4. **IMAP writes.** `src/adapters/bb/imapflow-gateway.ts` (`capabilities`,
   `appendMessage`, `findByMessageId`, `expungeOwn`, `markDeleted`; the
   `SessionClient` Pick list gains `append`, `search`, `messageFlagsAdd`,
   `messageDelete` behind the UIDPLUS check), flag sync of `\Deleted` →
   `is_deleted`, `tests/adapters/imapflow-gateway.test.ts`.
5. **SMTP and MIME adapters.** Add `nodemailer` (pinned, e.g. `10.3.1`) to
   `package.json`; `src/adapters/bb/smtp-transport.ts`,
   `src/adapters/bb/mime-builder.ts`, tests
   `tests/adapters/smtp-transport.test.ts` (a local fake SMTP server or
   nodemailer's stream transport for error mapping),
   `tests/adapters/mime-builder.test.ts` (round trip through postal-mime,
   Bcc only in the Sent copy, no `path`). Run `check-manifests`.
6. **Server wiring.** `server.ts` (RPCs, outbox worker in the background
   service, upload sessions, `accounts_smtp_*`), `src/adapters/bb/uploads.ts`
   (chunk sessions), `src/adapters/bb/sync-service.ts` (worker hook,
   `sending` → `unknown` on start), `src/core/accounts.ts` (SMTP in
   add/test), tests `tests/server.test.ts`, `tests/adapters/uploads.test.ts`,
   `tests/core/accounts.test.ts`.
7. **Composer UI.** Add `@tiptap/react`, `@tiptap/core`, `@tiptap/pm`,
   `@tiptap/starter-kit` (and `@tiptap/extensions` if the placeholder is
   used), pinned; `tests/architecture.test.ts` (exact entries above);
   `src/ui/composer.tsx`, `src/ui/recipient-input.tsx`,
   `src/ui/compose-toolbar.tsx`, `src/ui/compose-editor.tsx`,
   `src/ui/attachments-input.tsx`, tests `tests/ui/composer.test.tsx`,
   `tests/ui/recipient-input.test.tsx`.
8. **Page integration.** `src/ui/mail-page.tsx` (placement, one toolbar),
   `src/ui/reading-pane.tsx` (Reply, Reply all, Forward, Edit draft),
   `src/ui/shortcuts.ts` (c, r, a, f live; Cmd/Ctrl+Enter, Escape),
   `src/ui/outbox.tsx` (toast and outbox rows), `app.tsx` (RPC clients,
   realtime `outbox-changed`), tests `tests/ui/mail-page.test.tsx`,
   `tests/ui/shortcuts.test.ts`, `tests/ui/outbox.test.tsx`.
9. **Docs and listing.** `README.md`, `PLUGIN_OVERVIEW.md`,
   `package.json` `bb.description`, root `marketplace.json`
   (makosh-mail entry), `skills/mail/SKILL.md` (agents cannot send),
   `THIRD_PARTY_NOTICES.md` only if code is vendored (none planned). Run
   `check-manifests`, `npm run check`, `npm run build`.

## Calls made by me (not the owner)

- Uploads over chunked RPC instead of tickets and an HTTP route (Open
  question 1), because of the host's 415 rule and missing caller identity.
- Hybrid drafts: local autosave at 1.5 s, server copy at 30 s idle and on
  close (Open question 2).
- The page sends a document, not HTML; the server renders. Quotes are lossy.
- No image node in the editor in 3b; pasted images become attachments.
- Sent copy carries a Bcc header; sent bytes do not (Open question 4).
- Sent-copy policy stored per account, defaulted from the preset (Open
  question 6).
- `unknown` state after a restart or a post-DATA failure; the owner chooses
  (Open question 9). APPEND retries automatically because it is idempotent.
- Reply all removes the addresses of every connected account; Gmail dot and
  plus variants are not folded.
- Outbox worker inside the existing background service; one SMTP connection
  per send, no pool.
- Pins: nodemailer 10.3.1, TipTap 3.32.2 (both ≥ 2 weeks old today).

## Open questions for the owner

1. **Upload transport.** The ruling was one-time tickets and an HTTP route.
   BB refuses non-JSON bodies on `local` routes (415) and routes have no
   caller identity. *Recommendation:* chunked base64 over owner-only RPC
   (about 33% overhead, no route, `refusePluginCaller` on every call).
2. **Draft strategy.** Server-only autosave (APPEND + expunge every few
   seconds) churns the server and needs the expunge exception constantly.
   *Recommendation:* hybrid — local autosave at 1.5 s; server copy after
   30 s idle, on close and on Save draft; expunge only our own previous uid
   with UIDPLUS; without UIDPLUS, server copy only on close and the old copy
   marked `\Deleted` (hidden here, never expunged).
3. **Foreign drafts.** When the owner continues a draft made in another
   client, may the plugin remove that original copy after saving its own?
   *Recommendation:* yes, for exactly that uid after the Message-ID and size
   guard, with UIDPLUS only; otherwise leave it and mark `\Deleted`.
4. **Bcc in the Sent copy.** "Same bytes" for send and Sent would lose the
   record of Bcc recipients. *Recommendation:* sent bytes without Bcc; the
   Sent copy is the same bytes with one `Bcc:` header added (what Apple Mail
   and Thunderbird do).
5. **Forward fidelity.** An inline TipTap quote flattens rich HTML.
   *Recommendation:* inline quote by default in 3b; add **Forward as
   attachment** (`message/rfc822`, exact original) as a follow-up item, not
   in 3b.
6. **Sent-copy policy.** Detect Gmail at send time, or store a per-account
   setting? *Recommendation:* per-account `sent_copy`, defaulted from the
   preset (Gmail `server`), and for Other accounts set to `server` when the
   session reports `X-GM-EXT-1`; no UI toggle in 3b.
7. **Size cap.** 25 MB may exceed iCloud's limit. *Recommendation:* cap at
   `min(25 MB, provider limit)`, set iCloud to 20 MB if the live check
   confirms it.
8. **Aliases and signatures.** *Recommendation:* defer both (backlog #45,
   #33); From lists accounts only.
9. **"May have been sent".** After a restart or a connection loss after
   DATA, the plugin cannot know. *Recommendation:* never resend
   automatically; show **Send again** / **Discard**; on Gmail check Sent by
   Message-ID first and settle it when found.
10. **Queued send across a restart.** A message queued with Undo pending
    when BB stops: send it after restart, or hold it? *Recommendation:* keep
    `send_after`; if it passed while BB was down, hold the row as `queued`
    with a fresh 10 s Undo window shown on next open instead of sending at
    once on startup.

## Not verified

- nodemailer 10.x option names and behaviour: `raw`, `envelope`,
  `requireTLS`, `disableFileAccess`/`disableUrlAccess`, MailComposer
  Bcc handling, default `X-Mailer`, early `SIZE` refusal; how it bundles
  under `bb plugin build`. (Package metadata, licence, exports and versions
  were read with `npm view`; nothing was installed.)
- TipTap: bundle size, working under BB's React shim and `react-dom`, whether
  underline and link are in starter-kit 3.x at the pinned version, whether an
  inert `DOMParser` parse loads anything.
- Code splitting in the BB build.
- iCloud: UIDPLUS, SMTP username form, message size limit.
- Gmail: effect of UID EXPUNGE in Drafts, absence of Sent duplicates when the
  plugin does not append.
- Plugin RPC and HTTP body-size limits: none found in BB 0.49.0 host code,
  none documented.

## Resolutions after the builder check

These override the sections above. Items marked *(owner)* wait for the owner's sign-off; until then the recommended form is the plan's default.

1. **Send boundary *(owner)*.** `refusePluginCaller` refuses only `kind: "plugin"`; the app, the `bb` CLI and agents with shell access are all `client` callers, so "only the owner sends" is an accepted limit, not a guarantee. Mitigations: every queued send publishes `outbox-changed` and any open Mail page shows its Undo toast; the Outbox is always reachable; a cap of 10 sends per minute per account.
2. **No `is_deleted` column.** `fetchFlags` does not return `\Deleted`, and hiding other clients' `\Deleted` mail is out of scope. Drop the column and `markDeleted`. Without UIDPLUS, drafts stay local only.
3. **Double send.** Outbox id = `requestId`. A partial unique index on `outbox(draft_id)` for live rows is checked in the queueing transaction together with the `baseRevision` compare-and-swap. `compose_save` answers `conflict` while the draft is queued. Undo deletes the outbox row; there is no `cancelled` state.
4. **Post-DATA errors.** New error kinds:
   - `rejected_message`: a 5xx after DATA. The send is failed and offers Edit.
   - `temporary`: a 4xx at any stage. The send is failed and offers Retry.
   - `unknown`: only when there is no reply after DATA (timeout, socket close, abort).
5. **Editor schema.** `StarterKit.configure` disables heading, code, codeBlock, strike and horizontalRule. The server strips unknown nodes and marks, keeping their text, instead of refusing the save.
6. **Restart with queued rows.** On start, overdue `queued` rows become `held`. The Outbox shows them with Send now and Edit; no timer runs.
7. **Per-account write queue.** The adapter runs APPEND, expunge and SMTP for one account through a single promise queue.
8. **Blob volume.**
   - Store `bcc_header TEXT` and splice it in at append time, instead of keeping a second MIME.
   - With attachments, the server copy is written only on close or Save draft, not on each autosave.
   - Run `PRAGMA incremental_vacuum` after a row reaches `done`.
9. **Reply-To.** Migration 4 adds `messages.reply_to_json`, filled by sync. A raw fetch is only the fallback for older rows.
10. **Abort during a send.** On abort the worker takes no new rows. An in-flight send keeps its own store handle and gets a short drain, so it is not recorded as `unknown`.
11. **SMTP settings for existing accounts.**
    - A new SMTP dialog.
    - `accountSchema.smtpConfigured`.
    - SMTP fields in `newAccountInputSchema` for Other.
12. **Stale draft row.** Right after `expungeOwn`, the store drops the old draft row locally with `deleteByUids`, so the draft and the Sent copy do not both show (their `dedup_key` differs).
13. **Subjects.** Reply strips only the leading run of reply markers, so `Fwd: x` becomes `Re: Fwd: x`. Forward strips only forward markers. The marker list is shared with `normalizeSubject`.
14. **Reply to one's own sent message.** Reply addresses the original To only; Cc goes only into Reply all.
15. **Addresses.** Non-ASCII local parts are refused in 3b (no SMTPUTF8). Domains are punycoded in core.
16. **Bcc.** The MIME is built once without Bcc; a pure core function inserts a folded, ASCII-only `Bcc:` line into the Sent copy only. A test asserts the SMTP bytes contain no Bcc. Gmail's own Sent copy does not show Bcc; this is documented.
17. **Nits.**
    - Tests are colocated next to the code.
    - Toasts stay in `app.tsx`, because `src/ui` cannot import `sonner`.
    - New tables keep ISO TEXT timestamps.
    - c, r, a and f are bound by `event.code`.
    - The architecture allow-list is exactly `@tiptap/react`, `@tiptap/core`, `@tiptap/pm` and `@tiptap/starter-kit`.
    - The live checks add iCloud `SEARCH HEADER Message-ID`.
    - Drafts synced from the server are visible to `mail_search`, and the docs say so.
18. **Dependencies *(owner)*.** nodemailer 10.x (MIT-0, no dependencies) plus the four TipTap packages at 3.32.2, exact pins.
19. **Expunge exception *(owner)*.** After a newer draft is appended, or after a send or discard, the previous draft copy is removed, under these conditions:
    - The server must support UIDPLUS, checked by the gateway before any command.
    - The uid comes from our own APPENDUID, or is the one foreign draft the owner explicitly continued (open question 3), with UIDVALIDITY unchanged.
    - A Message-ID and size guard fetch runs first.
    - The command is `UID EXPUNGE` of that single uid, never a plain `EXPUNGE`.
    - No UIDPLUS means drafts stay local only, and nothing is ever marked `\Deleted`.
20. **Open questions 1 and 4 *(owner)*.** Recommended:
    - Upload attachments over chunked RPC (open question 1); the 415 rule on local HTTP is confirmed.
    - Put the Bcc header in the Sent copy (open question 4).
