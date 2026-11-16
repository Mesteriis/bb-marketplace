# Makosh Mail — slice 3i: security and privacy (sender checks and spoofing warnings, trackers and link cleaning, read receipts, signed and encrypted mail recognised)

Status: builder's design, proposed on 2026-11-16, **not yet accepted by the
owner**. Every decision below is marked *Proposed (owner to accept)* with a
safe default and a one-line rationale; the owner tends to accept sensible
safe defaults, so the open questions are kept few and each has a
recommendation. It follows 3a (organize and read), 3b (write and send), 3c
(agent proposals and translation), 3d (sending polish), 3e (inbox triage), 3f
(agent and mail), 3g (BB integration) and 3h (search, history, folders,
attachments), all on `feat/mail-imap-slice`. Everything in the slice-1,
slice-2 and 3a–3h specs holds unless this document changes it, and their
"Resolutions" sections are the binding form. In particular: nothing is ever
expunged except 3b's `expungeOwn` of the plugin's own drafts; every server
fetch is `BODY.PEEK`; 3f's AI access scope, redaction, untrusted framing and
content-free agent log hold for every path that can reach an agent; owner
writes refuse plugin callers (`refusePluginCaller`); 3g's "no BB patches, no
host entry, no terminal" holds; 3h's "no search words, folder, label or file
names in logs" holds.

Backlog (`docs/mail-feature-backlog.md`, group "Безопасность и приватность"),
checked on 2026-11-16 against the file and the code. No earlier slice note
defers anything to "3i" by name; 3g's spec says tracking parameters "are not
removed (that is backlog #40)" (3g spec line 561), and 3b/3d list read
receipts, S/MIME and PGP as non-goals.

| # | Item | Label now | Done today | In 3i |
| --- | --- | --- | --- | --- |
| 12 | Remote images only by consent | уже есть | — | untouched, but a sender who fails the check no longer gets "Always show" |
| 30 | Headers and metadata | уже есть | — | Details gains an "Authenticity" block |
| 46, 47, 58 | Agent log, AI scope, redaction | уже есть | — | untouched; agent text gains a sender-check line and cleaned links |
| 39 | Spoofing warnings (SPF/DKIM/DMARC, foreign Reply-To, lookalike domain) | кандидат | provider `Authentication-Results` are parsed for DKIM only, for one-click unsubscribe trust (`src/core/unsubscribe.ts` `trustOf`); nothing is shown | yes |
| 40 | Tracker blocking and link cleaning | кандидат | remote images, CSS loads and prefetch are blocked by default; once images are allowed every `https:` `<img>` loads, pixels included; links open as written | yes |
| 72 | Do not send read receipts | кандидат | Mail never sends one (no MDN code exists), but says nothing | yes: a note, and a test that pins "never" |
| 92 | PGP | позже | signed or encrypted mail shows as attachments (`signature.asc`, `encrypted.asc`) | **recognised only** (a badge, never "verified"); signing, encrypting and verifying **proposed for 3k** |
| 97 | S/MIME | позже | `smime.p7s` / `smime.p7m` show as attachments | **recognised only**, as #92; full support **proposed for 3k** |
| 93 | Local database encryption | позже | the plugin's SQLite file is the host's plain better-sqlite3 database; passwords alone are sealed (`vault.ts`) | **stays `[позже]`** (no host API for an encrypted database); one small step: deleted mail is overwritten on disk (`secure_delete`) |

Points the builder could not verify are marked **[unverified]** and collected
in "Not verified" at the end.

## Owner's decisions

Proposed by the builder on 2026-11-16. Each line is *Proposed (owner to
accept)*; the default given is what the design below implements unless the
owner changes it.

1. **Scope of 3i:** sender checks and spoofing warnings (#39), tracker
   blocking and link cleaning (#40), read receipts never sent and the request
   shown (#72), signed and encrypted mail recognised but not verified or
   decrypted (#92, #97 partial), deleted rows overwritten on disk (#93
   partial). *Proposed (owner to accept).* These are the security items that
   need no keys, accounts or new dependencies.
2. **Full PGP (#92) and S/MIME (#97) move to 3k.** Both need the owner to do
   things outside the code (create or import a key pair, get a certificate
   from a CA, collect correspondents' public keys or certificates) and each
   needs a new dependency (`openpgp` for PGP; a CMS/ASN.1 library such as
   `pkijs` for S/MIME, since `node:crypto` cannot parse CMS). *Proposed
   (owner to accept).* 3i lays the ground: the badge, the stored crypto kind,
   and the rule that an encrypted body never reaches an agent or a model.
3. **#93 stays `[позже]`.** `bb.storage.database()` hands out the host's own
   better-sqlite3 handle on a fixed file (sdk 19830–19851) with no
   encryption option, so encrypting the database would need a BB change
   (anti-goal) or field encryption that breaks the FTS5 search index; and the
   key would sit in the same plugin settings as `vaultKey`, readable by an
   agent with shell access, which the backlog's own risk note already says.
   *Proposed (owner to accept).* The partial step in decision 10 is cheap and
   honest.
4. **Sender check from the provider's own results only.** Mail does not
   verify DKIM or SPF itself (that needs DNS and a DKIM library). It reads
   the `Authentication-Results` the account's provider wrote at the top of
   the message, with the same "trusted authserv-id, topmost block only"
   rules 3e already uses for one-click unsubscribe (`TRUSTED_AUTHSERV`,
   `trustOf`). Gmail (`mx.google.com`) is trusted today; iCloud's id is
   pinned at the live check (3e left it empty, `unsubscribe.ts` 68–72);
   other servers get **Not checked**. *Proposed (owner to accept).* A forged
   result lower in the headers is ignored; nothing is fetched from the
   network.
5. **What a failed check does.** A message whose sender check is **failed**
   (DMARC fail, or no DMARC result and SPF fail with no DKIM pass aligned
   with From) shows a warning strip; does not load remote images through
   **Always show from** (per-message **Show images** still works); gets no
   dev class, so no Dev digest entry, no alert card and no rule match on dev
   fields; and never prepares or starts a mail rule (#82). Agent text gains
   one fixed line "Sender check: failed". *Proposed (owner to accept).* A
   spoofed GitHub, Sentry or bank mail must not steer automation or confirm
   an open.
6. **Warnings, not verdicts of trust.** Mail shows warnings only (failed
   check, foreign Reply-To, lookalike domain, a name that shows another
   address, mixed alphabets in a domain). A **pass** is shown in Details,
   never as a badge in the list or the header. *Proposed (owner to accept).*
   A green tick on a phishing domain that passes its own DMARC would mislead.
7. **Lookalike domains** are judged against domains the owner wrote to
   (Sent rows and `sent_recipients`) and the owner's own identity domains,
   computed when a message is opened, not stored. A From domain that is not
   itself known is flagged when its name equals a known one after mapping
   confusable characters, or is one edit away (names of 5+ characters), or
   mixes alphabets in one label. *Proposed (owner to accept).* Known
   correspondents are the domains a spoofer imitates; the owner's own mail is
   local and ready.
8. **Trackers are removed even when images are allowed.** In allowed mode,
   images that are tracking pixels (1x1 or hidden by size or style) and
   images from a short built-in list of open-tracking hosts are dropped; the
   image bar says "2 trackers blocked". Default mode is unchanged (nothing
   remote loads) and the bar says how many trackers the message carries.
   No setting. *Proposed (owner to accept).* It only removes loads the owner
   cannot see.
9. **Links are cleaned and shown before they open.** Every link Mail opens
   (message HTML, the PDF viewer's link list, alert cards, dev links) goes
   through one core function that removes known tracking parameters and
   unwraps known redirect wrappers whose target is in the URL itself
   (Google `/url?q=`, Outlook SafeLinks `?url=`, Facebook `l.php?u=`).
   Hovering or focusing a link in a message shows its real address in a
   status line under the message. A link whose visible text names a
   different site, or whose host is punycode or mixes alphabets, opens only
   after a dialog that shows the real host. Setting `cleanLinks` (default
   on) turns parameter removal and unwrapping off; the dialog and the status
   line stay. Click-tracking redirects that hide their target (an ESP's
   `/ls/click?...`) are never followed by Mail to find out; the status line
   names the tracking host. *Proposed (owner to accept).* Nothing new goes
   on the network; one choke point is easy to test.
10. **Deleted mail is overwritten on disk.** The plugin's connection runs
    `PRAGMA secure_delete = ON` once per load, so rows Mail deletes (Forget
    older mail, expired server hits, account removal, purges) are zeroed in
    the database file rather than left in free pages. *Proposed (owner to
    accept).* It is the part of #93 the plugin can do alone; the cost is
    extra writes on delete. README states that the WAL file and backups
    are outside this.
11. **Read receipts are never sent.** Mail has no code that sends a
    Message Disposition Notification and 3i keeps it that way; a test
    pins it. When a message asks for one (`Disposition-Notification-To`,
    `Return-Receipt-To`, `X-Confirm-Reading-To`), the reading pane shows a
    quiet line: "The sender asked for a read receipt. Makosh Mail does not
    send receipts." There is no **Send receipt** button. *Proposed (owner to
    accept).* The backlog says "ignored by default"; a button can come later
    if the owner ever wants one (open question 2).
12. **Older mail is checked when opened.** Rows synced before 3i have no
    stored sender check. Opening one (in the reading pane only) fetches its
    header fields once with `BODY.PEEK` through the account's queue, as 3e's
    `fetchUnsubscribeInfo` does (`server.ts` 2511–2545), and stores the
    result. Nothing is backfilled in bulk. *Proposed (owner to accept).* One
    round trip per opened old message, no server change.
13. **Signed and encrypted mail is recognised, never claimed valid.**
    `multipart/signed` (PGP or S/MIME), `multipart/encrypted` (PGP/MIME),
    `application/pkcs7-mime` and inline `-----BEGIN PGP MESSAGE-----` /
    `SIGNED MESSAGE-----` armor get a neutral badge: "Signed (PGP) — Mail
    does not check signatures" or "Encrypted (S/MIME) — Mail cannot read
    it". An encrypted body is never handed to an agent, a model, BB or the
    attachment-text index (it is ciphertext, but its presence is still
    nobody else's business). *Proposed (owner to accept).*
14. **One migration element (14)**, appended to `MIGRATIONS`; element 14
    joins the SHA pin. *Proposed (owner to accept).* Shipped elements 0–13
    stay frozen, as in every slice.
15. **No new dependency.** Domain handling uses the existing
    `toAsciiDomain` (`compose-address.ts` 47) and a small registrable-domain
    rule; the confusable map, tracking parameters, tracker hosts and
    redirect wrappers are short lists written for Mail, not ported.
    *Proposed (owner to accept).* `tldts` exists in `node_modules` only as
    jsdom's dev dependency and is not used.

## Goals

1. **Sender check** from the provider's `Authentication-Results` (SPF,
   DKIM, DMARC, alignment with From), stored at sync and for opened old
   mail; a warning when it fails (#39).
2. **Foreign Reply-To** warning in the reading pane and in the composer's
   "Before you send" (#39).
3. **Lookalike and disguised senders**: confusable or one-edit domains of
   known correspondents, mixed-alphabet domains, a display name that shows
   another address (#39).
4. **Failed checks do not drive automation**: no "Always show" images, no
   dev class, no rule run (#39, with #12, #37, #80, #82).
5. **Tracker blocking** in allowed-images mode and a tracker count in both
   modes (#40).
6. **Link cleaning**: tracking parameters removed, known wrappers unwrapped,
   real address shown on hover, a dialog for deceptive links (#40).
7. **Read receipts**: never sent, the request shown (#72).
8. **Signed and encrypted mail recognised** with honest wording (#92, #97
   partial).
9. **Deleted rows overwritten on disk** (#93 partial).

## Non-goals (later or backlog)

- Verifying DKIM signatures, SPF records or DMARC policy in Mail (DNS
  lookups, a DKIM library); ARC chain evaluation; BIMI logos.
- A positive "verified sender" badge in the list or the header.
- Per-account trusted authserv-ids typed by the owner for "other" servers
  (they stay **Not checked**; a later slice can add a setting).
- Following a click-tracking redirect to learn where it goes; any request
  to a link's host before the owner's click; link previews.
- A tracker list maintained from a third-party source, or updated over the
  network.
- Sending read receipts in any form.
- PGP and S/MIME signing, encryption, verification, key or certificate
  management (#92, #97 → **3k**, decision 2).
- Encrypting the local database (#93, decision 3); encrypting the WAL file
  or BB's own `bb.db`.
- Project binding (#81) changes: a binding only shows mail beside a
  project's threads and starts nothing, so a failed check leaves it as is
  (the warning strip still shows).
- Phishing detection from message text, attachments or URLs by a model.

## Anti-goals

- **A trust claim Mail cannot back.** No text says a message is genuine or a
  signature valid. Pass results appear only in Details, as the provider's
  words.
- **Network traffic caused by a check.** Sender checks read stored headers;
  link cleaning is string work; tracker detection is local. No DNS, no HTTP
  `HEAD`, no redirect probe.
- **Automation steered by a forged sender.** A failed check never feeds a
  rule, a dev class, an alert or an auto-loaded image.
- **Warnings built from message text as instructions.** Every warning is
  fixed text with values (domains, addresses) shown as data in their ASCII
  (punycode) form; nothing from the message is rendered as HTML or Markdown.
- **Content in logs.** The plugin log and the agent log get counts and
  outcome codes (`auth_fetch_failed`, `trackers=2`) only: no domains,
  addresses, URLs or header values.
- **A receipt, a tracker load or a cleaned URL sent anywhere but where the
  owner clicked.**

## Design

### Code, SDK and host facts this design relies on

Line numbers are in the current tree (`plugins/mail/…`) unless marked "sdk"
(`node_modules/@get-bb/plugin-sdk/bundled-types/bb-plugin-sdk.d.ts`, SDK
0.6.132).

| Fact | Where |
| --- | --- |
| Sync parses the whole source with postal-mime (`BODY.PEEK[]`) and keeps, per message, the unsubscribe and trace header lines in message order, lower-case keys, capped at 64 lines (`toUnsubscribeHeaders`, `capHeaderLines`). `replyTo` comes from the parsed headers, since ENVELOPE's reply-to defaults to From. | `src/adapters/bb/imapflow-gateway.ts` 988–1031, 1050–1078; `src/core/unsubscribe.ts` 116–145 |
| The trace header names per preset (`Received`, `Authentication-Results`, `ARC-*`, `Received-SPF`, `Return-Path`, `Delivered-To`, `X-Received`; Gmail adds `X-Google-*`, `X-Gm-*`), trusted authserv-ids (`gmail: ["mx.google.com"]`, `icloud: []`, `other: []`), and the header fields a PEEK header fetch asks for. | `src/core/unsubscribe.ts` 41–98 |
| `parseAuthResults` reads only `dkim=` entries (result, `header.d`/`header.i`, `header.s`, `header.b`); comments are stripped; `trustOf` counts only trusted A-R headers above the end of the provider's trace block and above the topmost `DKIM-Signature`. | `src/core/unsubscribe.ts` 263–322, 359–430 |
| `prepareMessage` is the one place a fetched message is judged before the store takes it (unsubscribe info, dev class); 3h's server-search and history jobs call it too. | `src/core/sync.ts` 857–890 |
| On-demand header fetch for a row synced before a slice: `fetchUnsubscribeInfo` (account queue, read-only session, `fetchHeaderFields`, UIDVALIDITY guard, store only where NULL, log gets the error kind). | `server.ts` 2511–2545; `src/core/ports.ts` 149 |
| HTML mail: DOMPurify with hooks; default CSP `img-src data:`, allowed mode `img-src data: https:`; `https:` `<img src>` is the one remote load kept in allowed mode, with `referrerpolicy="no-referrer"`; CSS `url()`, `@import`, `srcset` and loading attributes are always removed; `x-dns-prefetch-control: off`, `referrer: no-referrer`. `blockedRemoteImages` reports what Show images would reveal. | `src/ui/sanitize.ts` 11–15, 45–75, 425–455, 461–490 |
| Links: the sanitizer keeps `href` on `<a>`/`<area>` only, `http:`, `https:` and `mailto:` only (`isAllowedLinkUrl`). The frame is `sandbox="allow-same-origin"` (no scripts); the parent attaches `click`/`auxclick` listeners to `contentDocument` on load and calls `onOpenLink(href)`. | `src/ui/sanitize.ts` 228–236, 444–449; `src/ui/message-frame.tsx` 266–301, 312 |
| Every message, PDF and alert link reaches one page callback, `openLink` → `navigate.openUrl(url)` ("Open an HTTP(S) URL using this client's BB browser preference … Returns false for blocked or unsupported schemes"). | `app.tsx` 1587–1592, 3719, 3839; sdk 26511–26518 |
| Remote images per sender: `images_allowed` = an `image_senders` row for the account and the lower-cased From address; `allowImageSender` / `disallowImageSender`. | `src/adapters/bb/sqlite-store.ts` 3629–3644, 3964–3975 |
| Reply recipients use `replyTo` when the source has one (`compose-reply.ts` 47–48); the pre-send check's issue kinds are `attachment_mentioned`, `empty_subject`, `outside_conversation`, `new_recipients`, `bb_files`, `looks_secret`. | `src/core/compose-reply.ts` 12, 47–48; `src/core/presend.ts` 10–41 |
| Known correspondents: `sent_recipients(account_id, address, last_sent_at)` (Mail's own sends, 3d) and Sent-role rows' To/Cc (`addressesSentTo` scans them); own addresses: `ownIdentityAddresses`. | `sqlite-store.ts` 470–475, 4617–4645; `src/core/identities.ts` 106 |
| Public mail domains (never a domain rule) and the country second-level labels (`co`, `com`, `net`, `org`, `ne`, `or`) a pattern provider uses. | `src/core/blocking.ts` 17–44 |
| Mail rules match on `from`, `domains`, `list`, subject words, dev fields and accounts (`mailRuleMatches`, `RuleRow`); the dev class is computed at sync in `prepareMessage` and drives the Dev view, alerts and rule dev matches. | `src/core/mail-rules.ts` 53–60, 149–176; `src/core/sync.ts` 864–882; `src/core/alerts.ts` 86 |
| Agent text: `UNTRUSTED_NOTICE`, `renderMessageForAgentCounted` (From, To, Cc, …, redacted), `htmlToText` / `scanHtml` collect up to 200 hrefs. | `src/core/agent-text.ts` 12, 91–110, 355–380 |
| `messageHeaderSchema` (per message in `thread_get`), `messageBodySchema`, and `message_source` (headers and MIME structure for Details). | `src/core/model.ts` 256–276, 315–325; `src/core/contract.ts` 418–429, 499–509 |
| `parseStructuredHeader(value)` → `{ token, params }` for Content-Type-like values; `readHeaders` decodes RFC 2047 and strips control and bidi characters. | `src/core/headers.ts` 179–203, 276– |
| Passwords: AES-256-GCM under the `vaultKey` secret setting. The database: `bb.storage.database()` — the host's better-sqlite3 at `<dataDir>/plugins/<id>/data.db`, WAL, one handle per load; `migrate` is append-only and hash-checked. No encryption option in the SDK. | `src/adapters/bb/vault.ts` 1–40; `server.ts` 449, 1133–1134; sdk 19830–19851 |
| `MIGRATIONS` has elements 0–13 (13 = 3h); the pin test covers `MIGRATIONS.slice(0, 14)`. | `sqlite-store.ts` 148–910; `sqlite-store.test.ts` 761–788 |
| Settings so far end with `indexAttachmentText`, `mailView`, `darkMail`, `hideQuotes` (3h). | `server.ts` 441–640 |
| RPC output keys must not match `/pass\|secret\|seal\|key/i` (the contract test's credential walker). So the sender-check view uses `ok`/`failed`, never a `pass` key. | `src/core/contract.test.ts` 41, 758 |
| Core code may use the `URL` global (already in `dev-links.ts`, `unsubscribe.ts`, `compose-address.ts`); no `node:` imports. | `tests/architecture.test.ts` |
| No search hit for an MDN sender anywhere in Mail (`Disposition-Notification`, `disposition-notification` content, `Return-Receipt`). | `rg` over `src`, `server.ts`, `app.tsx` |
| No PGP or S/MIME code; `postal-mime` turns `signature.asc`, `smime.p7s`, `smime.p7m`, `encrypted.asc` into ordinary attachments. | `rg pkcs7\|pgp` over `src` (none); `imapflow-gateway.ts` 1012–1020 |

### User flows

1. **Failed check.** A message claiming to be from `billing@example.com`
   opens with a strip above the body: "**Sender not verified.** Your mail
   provider could not confirm this came from example.com (DMARC failed).
   Don't trust links or requests in it." Remote images stay hidden even
   though example.com's sender is on the always-show list; the image bar
   says "Images from this sender are not loaded automatically because the
   sender check failed · **Show images**".
2. **Foreign Reply-To.** Under the From line: "Replies go to
   **help@example-support.net**, not to example.com." Pressing Reply puts
   that address in To, and "Before you send" lists "Reply-To differs from
   the sender: help@example-support.net".
3. **Lookalike.** "**examp1e.com** looks like **example.com**, which you
   write to." / "This domain mixes alphabets: **xn--….com**
   (shown as it really is)." / "The name shows **ceo@example.com** but the
   address is **x@example.org**."
4. **Details.** Details starts with "Authenticity (from mx.google.com): SPF
   pass (example.com) · DKIM pass (example.com, aligned) · DMARC pass" or
   "Not checked: Mail does not read this server's results" — then the
   headers as before.
5. **Trackers.** Allowed mode: "Images shown · 2 trackers blocked". Default
   mode: "Remote images hidden · this message has 2 trackers · **Show
   images**" (trackers stay blocked after Show images).
6. **Links.** Hovering a link shows under the message: "→
   https://shop.example.com/sale (3 tracking parameters removed)" or "→
   via tracking redirect at click.example-esp.com". Clicking a link whose
   text says `www.example.com` but goes to `example.net.evil.org` opens a
   dialog: "This link says **www.example.com** but opens
   **evil.org**. Open evil.org?" **Open** / **Cancel**.
7. **Read receipt.** A muted line in the header: "The sender asked for a
   read receipt. Makosh Mail does not send receipts."
8. **Signed or encrypted.** A neutral chip next to the subject: "Signed
   (S/MIME)" with the tooltip "Mail does not check signatures"; "Encrypted
   (PGP)" with the body area saying "This message is encrypted. Open it in
   a mail client that has your key."

### Sender check (`src/core/sender-check.ts`, new)

Pure core. It generalizes 3e's A-R reading without changing `trustOf`'s
behaviour (its tests stay as they are).

```ts
export type AuthResult = "pass" | "fail" | "softfail" | "neutral" | "none" | "temperror" | "permerror" | "policy";
export type SenderCheck = {
  /** failed: the provider says the From domain is not authentic; unchecked: no trusted results. */
  state: "ok" | "failed" | "unchecked";
  authserv: string | null;
  spf: { result: AuthResult; domain: string | null } | null;
  dkim: { result: AuthResult; domain: string | null; aligned: boolean }[];   // at most 5
  dmarc: { result: AuthResult; domain: string | null } | null;
};
export function senderCheckOf(headers: HeaderLine[], preset: AccountPreset, fromAddress: string): SenderCheck;
export function orgDomain(domain: string): string;   // registrable-domain heuristic
```

- `trustedAuthResults(headers, preset)` is moved out of `trustOf` into a
  shared helper in `unsubscribe.ts` (same top-block rule: the provider's
  trace block and above the topmost `DKIM-Signature`; trusted authserv-ids
  only). `trustOf` calls it; `senderCheckOf` calls it.
- `parseAuthResults` is extended to keep every method entry (`spf`, `dkim`,
  `dmarc`) with its result and the properties `smtp.mailfrom`,
  `header.from`, `header.d`, `header.i`. Unknown methods are ignored.
  Values are bounded (each A-R value at most 4 KB, at most 20 method
  entries) before any regular expression runs; the existing pair regex is
  linear.
- **State.** `failed` when DMARC is `fail`; or, without a DMARC result,
  SPF is `fail` (not `softfail`) and no DKIM `pass` is aligned with From.
  `ok` when DMARC is `pass`, or a DKIM `pass` is aligned with From.
  Otherwise (`none`, `neutral`, softfail without DMARC, temp errors) `ok`
  is **not** claimed: the state is `unchecked` with the results kept for
  Details. **Aligned** means `orgDomain(signer) === orgDomain(fromDomain)`
  (relaxed alignment, RFC 7489 §3.1).
- **`orgDomain`**: ASCII (punycode) form, last two labels, or last three
  when the second-to-last label is one of `co com net org ac gov edu ne or
  go` and the last is two letters (`example.co.uk`). A heuristic without
  the public suffix list; errors make a warning appear or not, never block
  mail. README says so.
- **Where computed.** `prepareMessage` (`sync.ts` 864) adds
  `withSenderCheck(message, preset)` from `message.unsubscribeHeaders`
  (they already include From, A-R, DKIM-Signature and the trace block); the
  store keeps `messages.sender_check_json` (NULL = not known). The fields
  fetched for old rows (decision 12) become `SECURITY_HEADER_FIELDS` =
  `UNSUBSCRIBE_HEADER_FIELDS` plus `Reply-To`, `Content-Type`,
  `Disposition-Notification-To`, `Return-Receipt-To`,
  `X-Confirm-Reading-To`.
- **Own mail** (Sent, Drafts, the owner's identities in From) is not
  checked: state `unchecked`, no warnings.
- **iCloud**: `TRUSTED_AUTHSERV.icloud` is pinned during live step 1 from a
  real message's source (3e left this open). Until then iCloud mail is
  `unchecked`. That pin also enables 3e's one-click unsubscribe for iCloud,
  which is 3e's own rule.

### Disguise checks (`src/core/sender-disguise.ts`, new)

Computed when the reading pane asks for a thread (`thread_get`), per
message, from stored fields and a cached known-domain set; nothing stored.

```ts
export type DisguiseWarning =
  | { kind: "reply_to_elsewhere"; addresses: string[] }                 // ASCII form
  | { kind: "lookalike"; domain: string; like: string }
  | { kind: "mixed_script"; domain: string }
  | { kind: "name_shows_address"; shown: string; actual: string };
export function disguiseWarnings(input: {
  from: MailAddress; replyTo: MailAddress[]; bulk: boolean; listId: string | null;
  check: SenderCheck | null; known: KnownDomains; own: ReadonlySet<string>;
}): DisguiseWarning[];   // at most 4, fixed order
```

- **Reply-To elsewhere**: a Reply-To address whose `orgDomain` differs from
  From's and that is not own or known. For bulk mail (lists commonly set
  Reply-To to the list) only when the check is `failed`, or the Reply-To
  domain is neither From's nor the List-Id's domain.
- **Lookalike**: From's `orgDomain` not in the known set and, against each
  known `orgDomain` with the same TLD: equal after `skeleton()`, or a
  Damerau-Levenshtein distance of 1 on the first label when both first
  labels have 5+ characters. `skeleton()` lower-cases, maps a short
  hand-written confusable table (Cyrillic and Greek letters that look Latin,
  for example `\u0430`→`a`, `\u043e`→`o`, `\u0440`→`p`, `\u0435`→`e`,
  `\u0441`→`c`, `\u03bf`→`o`; and the ASCII pairs `rn`→`m`, `vv`→`w`, `0`→`o`,
  `1`→`l`, `I`→`l`) and drops `-`. Bounded: at most 5 000 known domains,
  first labels of at most 63 characters, early exit on length difference.
- **Mixed script**: a Unicode label (after `toUnicode` of an `xn--` label)
  with letters from more than one of Latin, Cyrillic, Greek. The warning
  shows the ASCII `xn--` form.
- **Name shows another address**: the display name contains something
  address-shaped (`local@domain.tld`) whose address differs from the real
  From. A name that merely contains a domain is not flagged (too common).
- **Known domains** (`KnownDomains`): own identity domains plus the
  `orgDomain` of every address in `sent_recipients` and in the To/Cc of
  Sent-role rows, built by one store query (`knownDomains(limit)`), cached
  in server memory and rebuilt after a send or a sync round that inserted
  Sent rows, at most once a minute. Public mail domains (`gmail.com`, …)
  stay in the set: `gmai1.com` is worth a warning.

### Effects of a failed check (decision 5)

- **Images** (`sqlite-store.ts` 3629–3644): `remoteImagesAllowed` is false
  when `sender_check_json` says `failed` or the message has a `lookalike`
  or `name_shows_address` warning; the bar explains why. The stored
  always-show entry is not removed.
- **Dev class**: `prepareMessage` skips `classifyDev` for a `failed` row,
  so no Dev entry, no alert card (`alertOf` needs a dev class), no rule
  dev match.
- **Mail rules**: `RuleRow` gains `senderFailed: boolean`;
  `mailRuleMatches` returns false for it, whatever the rule matches on.
- **Notifications**: unchanged (a toast is not an action); the toast text
  is unchanged.
- **Agent text**: `renderMessageForAgentCounted` adds one line after
  `From:` — `Sender check: failed` or, for any disguise warning,
  `Sender warning: reply-to elsewhere | lookalike domain | mixed alphabets |
  name shows another address` (fixed words; no domains, which the From line
  already carries). `renderInboxForAgent` adds the same marker per row.
  BB text (`bb-text.ts`) adds the same line to thread and task prompts.
  The line comes after `UNTRUSTED_NOTICE` and is Mail's, not the sender's.

### Pre-send (`src/core/presend.ts`)

New issue `{ kind: "reply_to_elsewhere"; addresses: string[] }` for a reply
or reply-all whose source message has a `reply_to_elsewhere` warning and
whose To still holds one of those addresses. Advisory like every pre-send
issue; it never refuses a send.

### Trackers (`src/ui/trackers.ts`, new; `sanitize.ts`)

- `isTrackerImage(img)`: width or height attribute ≤ 2, or inline style with
  `width`/`height` ≤ 2px, `display:none`, `visibility:hidden`,
  `opacity:0`, or a `src` host matching `TRACKER_HOSTS` (a short list of
  open-tracking host suffixes and path shapes written for Mail, kept in
  `src/core/trackers.ts` so the server can count too). The list is reviewed
  in the plan; entries are only hosts whose sole purpose is open tracking.
- `sanitizeEmailHtml` gains `trackers: number` in its result. In allowed
  mode a tracker `<img>` loses its `src` (like default mode) and is
  counted; in default mode the would-be trackers are counted among the
  blocked images and not offered by Show images. The CSP is unchanged.
- The image bar shows the count. A `data:` image is never a tracker.

### Links (`src/core/link-clean.ts`, new; `message-frame.tsx`, `app.tsx`)

```ts
export type CleanLink = {
  url: string;                    // what Mail opens
  original: string;
  removedParams: number;
  unwrapped: boolean;
  trackingHost: string | null;    // an opaque click-tracking redirect host
  host: string;                   // ASCII
  deceptive: { says: string } | null;
  unusualHost: "punycode" | "mixed_script" | null;
};
export function cleanLink(href: string, visibleText: string | null, options: { clean: boolean }): CleanLink | null;
```

- `null` for anything `isAllowedLinkUrl` refuses. `mailto:` is returned
  unchanged.
- **Parameters removed** (names, case-insensitive): `utm_*`, `fbclid`,
  `gclid`, `gbraid`, `wbraid`, `dclid`, `msclkid`, `yclid`, `ysclid`,
  `igshid`, `mc_cid`, `mc_eid`, `_hsenc`, `_hsmi`, `__hssc`, `__hstc`,
  `__hsfp`, `hsCtaTracking`, `mkt_tok`, `oly_anon_id`, `oly_enc_id`,
  `vero_id`, `_kx`, `trk`, `trkCampaign`, `sc_cid`, `s_cid`, `ref_src`.
  The fragment is kept. A URL whose only query was tracking loses its `?`.
- **Unwrapped** (target taken from the URL, never fetched): `google.*`
  `/url?q=` or `?url=`; `*.safelinks.protection.outlook.com/?url=`;
  `l.facebook.com/l.php?u=`, `lm.facebook.com/l.php?u=`. The target must
  itself pass `isAllowedLinkUrl`; one level only.
- **Deceptive**: `visibleText` (trimmed, at most 300 characters) looks like
  a URL or a bare host, and its `orgDomain` differs from the target's.
- **The frame**: `message-frame.tsx`'s load handler (266–301) also listens
  for `mouseover`/`focusin` on anchors and reports `{ href, text }` to the
  parent, which shows the status line under the frame (plain text, ASCII
  host). The click handler passes `{ href, text }` instead of `href`.
- **One choke point**: `app.tsx` `openLink` (1587–1592) takes `{ href,
  text }`, runs `cleanLink`, shows the dialog when `deceptive` or
  `unusualHost`, then calls `navigate.openUrl(clean.url)`. PDF links, alert
  links and dev links pass `text: null`.
- **Agent and BB text**: http(s) URLs in the text renderers' output (link
  targets from `scanHtml` and URLs in plain text) are passed through
  `cleanLink(..., { clean: true })`: an agent that fetches a link should not
  confirm a tracked open. The renderers already bound their input.
- **Setting** `cleanLinks` (boolean, default true): "Remove tracking from
  links I open". Off: no parameter removal or unwrapping; the status line,
  tracking-host note and dialog stay.

### Read receipts (#72)

- At sync, `prepareMessage` sets `receiptRequested` when any of
  `Disposition-Notification-To`, `Return-Receipt-To`,
  `X-Confirm-Reading-To` is present (from `parsed.headers`; the gateway adds
  them to the kept header lines). Stored as `messages.receipt_requested`
  (NULL unknown, 0, 1); old rows get it from the decision-12 fetch.
- The message header view gains `receiptRequested: boolean`.
- A test walks the outbox, the MIME builder and the SMTP transport and
  asserts no message with `Content-Type: multipart/report;
  report-type=disposition-notification` and no `Disposition-Notification-To`
  header can be built; Mail's own outgoing mail never asks for a receipt
  either.

### Signed and encrypted mail (#92, #97 partial)

- `cryptoKindOf(contentType, firstTextLines)` in `src/core/mail-crypto.ts`
  (new): `pgp_signed` (`multipart/signed; protocol="application/pgp-signature"`
  or inline `-----BEGIN PGP SIGNED MESSAGE-----` at a line start in the
  first 2 KB of text), `pgp_encrypted` (`multipart/encrypted;
  protocol="application/pgp-encrypted"` or inline `-----BEGIN PGP
  MESSAGE-----`), `smime_signed` (`multipart/signed;
  protocol="application/pkcs7-signature"` or `x-pkcs7-signature`, or
  `application/pkcs7-mime; smime-type=signed-data`), `smime_encrypted`
  (`application/pkcs7-mime` with `enveloped-data` or no `smime-type`).
  Uses `parseStructuredHeader`. Stored as `messages.crypto` (NULL none or
  unknown).
- **Encrypted** rows: `bodyText`/`bodyHtml` are not indexed in FTS beyond
  the subject, not offered to attachment text (#84), excluded from every
  agent, model and BB text path (the renderers print "[encrypted message —
  not readable]"), and the attachment list keeps the ciphertext part
  downloadable. **Signed** rows behave as today plus the chip.
- No code verifies or decrypts anything; no key material is read or
  stored.

### Deleted rows overwritten (#93 partial)

`server.ts` runs `db.pragma("secure_delete = ON")` right after
`bb.storage.database()` and before `migrate` (1133–1134). A store test
asserts the pragma reads back 1 on the test database. README: "Mail
overwrites mail it deletes from its database file. Copies in the database's
WAL file until the next checkpoint, in backups and in BB's own files are
outside this; the database itself is not encrypted."

### Data model and migration

Element 14 (slice 3i), appended:

```sql
ALTER TABLE messages ADD COLUMN sender_check_json TEXT;
ALTER TABLE messages ADD COLUMN receipt_requested INTEGER;
ALTER TABLE messages ADD COLUMN crypto TEXT;
```

No index (all three are read per opened message). `sender_check_json` is
bounded (at most 2 KB serialized; a larger one is not stored). Element 14
joins the SHA pin.

### RPC contract (`src/core/contract.ts`)

- `messageHeaderSchema` gains `senderCheck: { state: "ok" | "failed" |
  "unchecked"; summary: string | null }` (summary is fixed text built by
  the server, e.g. "DMARC failed"), `warnings: DisguiseWarning[]`,
  `receiptRequested: boolean`, `crypto: "pgp_signed" | "pgp_encrypted" |
  "smime_signed" | "smime_encrypted" | null`.
- `messageBodySchema` is unchanged; tracker counts are computed in the page
  by the sanitizer.
- `message_source` output gains `authenticity: { authserv: string | null;
  lines: string[] }` (fixed-format lines for Details).
- `sender_check_refresh { messageId } → { ok: boolean }` (owner only,
  refuses plugin callers): the decision-12 fetch, also used by Details'
  **Check again**. No other new method.
- No key in any new output matches the credential walker (`state`,
  `summary`, `warnings`, `authenticity`, `lines`, `authserv`).

### UI (summary)

- `src/ui/sender-warnings.tsx` (new): the warning strip (failed check) and
  the quieter warning lines (Reply-To, lookalike, mixed script, name), fixed
  strings, values in `<code>`-like spans, no links.
- `src/ui/link-status.tsx` (new): the status line and the deceptive-link
  dialog (vendored `dialog.tsx`).
- `message-frame.tsx`: hover/focus reporting; tracker count in the image
  bar; the "not loaded automatically" bar text.
- `reading-pane.tsx`: the crypto chip, the encrypted-body placeholder, the
  receipt line.
- Details: the Authenticity block and **Check again**.
- Composer "Before you send": the `reply_to_elsewhere` line.
- Keys: none new.

### Settings added

| Key | Type | Default | Label |
| --- | --- | --- | --- |
| `cleanLinks` | boolean | true | Remove tracking from links I open |

Sender checks, tracker blocking, receipt handling and `secure_delete` have
no setting (decisions 5, 8, 10, 11).

### Security and privacy

- **No new network traffic.** Sender checks read stored or PEEK-fetched
  headers; link cleaning and tracker detection are local string work; the
  decision-12 fetch is one read-only `BODY.PEEK[HEADER.FIELDS (...)]` per
  opened old message, on the owner's open, through the account queue.
- **Untrusted input everywhere.** A-R values, display names, Reply-To,
  link text and URLs are the sender's. Every parser is bounded before
  regular expressions run; domains are shown in ASCII; warnings are fixed
  text with values as data.
- **Forged results.** Only trusted authserv-ids, only in the top trace
  block, only above the topmost `DKIM-Signature` (3e's rule). A sender can
  add any A-R lower down; it is ignored. A provider that does not strip
  incoming A-R headers with its own id is the residual risk (RFC 8601 §5
  says it must); README states it.
- **Heuristics.** `orgDomain`, the confusable table, the tracker list and
  the parameter list are heuristics: they can miss a disguise or flag a
  harmless sender. No warning blocks anything but automation and automatic
  images.
- **Agents.** The sender-check line gives agents a fact they would
  otherwise guess; it does not grant them anything. Encrypted bodies never
  reach them. The shell limit (3c accepted limit) covers
  `sender_check_refresh` like every owner RPC; it reads nothing new.
- **Logs.** `sender_check: fetch failed (kind)`, `trackers=n`,
  `links: cleaned=n` at most; never a domain, address, URL or header value.
  The test that runs every path with secret- and address-filled fixtures
  (3f) gains the 3i paths.
- **Server changes:** none. 3i opens no IMAP write, SMTP send or outbound
  HTTP.

## Testing

Core with fakes, the store on real SQLite, adapters with fakes, UI with
Testing Library and jsdom, as before. Fixtures use made-up text and
addresses on `example.com` / `example.org` / `example.net`; A-R fixtures are
hand-written in Gmail's format.

- **Sender check** (`sender-check.test.ts`): DMARC pass/fail; SPF fail with
  and without aligned DKIM; softfail and none → `unchecked`; a forged A-R
  with the trusted id below the trace block or below the topmost
  `DKIM-Signature` ignored; untrusted authserv ignored; `other` and
  unpinned iCloud → `unchecked`; own mail unchecked; caps on A-R size and
  entry count; `orgDomain` table (`a.b.example.co.uk`, `example.com`,
  `xn--` labels). `unsubscribe.test.ts` passes unchanged (the shared helper
  refactor keeps `trustOf`).
- **Disguise** (`sender-disguise.test.ts`): Reply-To rules (bulk with list
  domain, bulk with failed check), lookalike by skeleton (Cyrillic letters
  written as `\u` escapes in the test source), by one edit, not for short
  labels or other TLDs, not when the domain is itself known; mixed script;
  name with another address; the 4-warning cap; 5 000-domain timing.
- **Effects**: images not auto-allowed for failed/lookalike rows (store
  test); `prepareMessage` skips dev class for failed rows (`sync.test.ts`);
  `mailRuleMatches` false for `senderFailed` (`rules.test.ts`); agent and BB
  renderers print the fixed line and never a header value
  (`agent-text.test.ts`, `bb-text.test.ts`).
- **Pre-send** (`presend.test.ts`): `reply_to_elsewhere` raised and cleared
  when the owner edits To.
- **Trackers** (`sanitize.test.ts`, `trackers.test.ts`): 1x1 by attribute and
  by style, hidden images, listed hosts, `data:` never counted, counts in
  both modes, allowed mode keeps real images, CSP unchanged.
- **Links** (`link-clean.test.ts`, `message-frame` tests, `app` link test):
  each parameter, case, empty query, fragment kept; each wrapper, nested
  wrapper not followed twice, a wrapper whose target is `javascript:`
  refused; deceptive text vs target; punycode and mixed-script hosts; the
  setting off; hover reporting; the dialog gate before `openUrl` (fake
  `navigate`).
- **Receipts** (`receipts.test.ts`): detection of the three headers; the
  no-MDN walk over outbox, MIME builder and transport fakes.
- **Crypto** (`mail-crypto.test.ts`): each content type and inline armor;
  encrypted rows excluded from agent text, BB text, attachment text and the
  FTS body.
- **Old rows** (server test): `sender_check_refresh` fetches header fields
  with PEEK through the queue, respects UIDVALIDITY, stores only where NULL,
  refuses plugin callers, logs only the error kind.
- **Contract** (`contract.test.ts`): the new fields, the credential-key
  walker, `sender_check_refresh` refused for plugin callers.
- **Migration**: element 14 on a copy of an element-13 database; the SHA pin
  for 0–14; `secure_delete` reads back 1.

### Live verification (owner's accounts and BB, after the build)

1. **iCloud authserv-id**: open Details of a real iCloud newsletter, read
   the top `Authentication-Results` id(s), pin them in `TRUSTED_AUTHSERV`
   (a code change in the same slice; owner shows the builder the header
   name and id only, no message text).
2. Gmail: a normal message shows no warning and Details shows SPF/DKIM/DMARC
   pass; a test message sent to self from another account with a foreign
   Reply-To shows the Reply-To line and the pre-send item.
3. A newsletter with images allowed: tracker count, real images still shown.
4. Links: status line on hover; a UTM link opens cleaned in BB's browser; a
   Google `/url?q=` link opens its target.
5. A message with `Disposition-Notification-To` (sent to self from another
   client that offers receipts): the line shows; nothing is sent (Sent and
   the other account's Inbox stay empty of receipts).
6. A signed message (S/MIME or PGP) if the owner has one; otherwise covered
   by fixtures only.
7. Opening an old message fills its sender check (Details shows results).

## Tasks

Each task ends with `npm run check`. The last also runs `npm run build` and
`node ../../scripts/check-manifests.mjs`. Paths are under `plugins/mail/`.

1. **Core: sender check.** Shared `trustedAuthResults` helper in
   `unsubscribe.ts` (no behaviour change), extended `parseAuthResults`,
   `sender-check.ts` with `orgDomain` (+ tests).
2. **Core: disguise, links, trackers, crypto, receipts.**
   `sender-disguise.ts`, `link-clean.ts`, `trackers.ts`, `mail-crypto.ts`,
   receipt detection, `presend.ts` issue, `RuleRow.senderFailed` (+ tests).
3. **Gateway and sync.** Receipt and crypto headers kept from the parsed
   source; `SECURITY_HEADER_FIELDS`; `prepareMessage` adds the check, skips
   dev class on failure (+ tests).
4. **Store and migration 14.** Columns, writes, `knownDomains`, images rule,
   `secure_delete`; encrypted rows out of FTS body and attachment text
   (+ tests, SHA pin).
5. **Server.** `thread_get` fields, known-domain cache, `message_source`
   authenticity, `sender_check_refresh`, the open-time fetch, agent/BB
   renderer lines and link cleaning, `cleanLinks` setting (+ tests).
6. **UI.** Warning strip and lines, crypto chip and placeholder, receipt
   line, Details block, tracker counts, link status and dialog, `openLink`
   choke point, pre-send line (+ tests).
7. **Docs and listing.** `README.md` (a "Security and privacy" section:
   what the sender check reads and its limits, trackers, links,
   receipts, signed/encrypted mail, `secure_delete` and what it does not
   cover; the shell-limit list gains `sender_check_refresh`),
   `PLUGIN_OVERVIEW.md`, `package.json` `bb.description` and the root
   `marketplace.json` entry together (only if the one-line description
   changes), `skills/mail/SKILL.md` (the "Sender check" and "Sender
   warning" lines in agent text), `CHANGELOG.md`,
   `docs/mail-feature-backlog.md`: 39, 40, 72 `[уже есть]` with "Срез 3i";
   92 and 97 `[позже]` with "распознавание — срез 3i; подпись и шифрование
   — срез 3k"; 93 `[позже]` with "затирание удалённого — срез 3i"; the
   header's date line. `THIRD_PARTY_NOTICES.md` unchanged (nothing ported).

## Calls made by me (not the owner)

- The check reuses 3e's trusted-results rule and the same header lines, so
  there is one definition of "the provider said so".
- `ok` is claimed only for DMARC pass or aligned DKIM pass; everything else
  without a failure is `unchecked`, so a softfail never shows as fine.
- Relaxed alignment by `orgDomain`, a heuristic without the public suffix
  list (no new dependency).
- Disguise warnings computed at read time against a cached known-domain
  set, not stored, so they follow the owner's correspondence.
- Lookalikes only against domains the owner wrote to, same TLD, edit
  distance 1 on 5+ character labels; different TLDs are not flagged
  (`example.de` vs `example.com` is too often legitimate).
- Trackers detected by size, hiding style and a short host list; never by
  fetching.
- Link cleaning at one page choke point plus the text renderers; hover via
  the existing same-origin listener path; no new iframe permission.
- Signed and encrypted mail detected from Content-Type and inline armor;
  encrypted bodies excluded from every text path.
- `secure_delete` set by the plugin on its own connection; no `VACUUM`.
- No new keys, no new settings beyond `cleanLinks`.

## Open questions for the owner

Each has a recommended default that the design above already implements.

1. **Unwrapping Outlook SafeLinks.** Unwrap Google, Outlook SafeLinks and
   Facebook wrappers (proposed), or leave SafeLinks alone because it is an
   employer's scanner? *Recommendation:* unwrap all three; the accounts are
   personal and the owner sees the target before opening.
2. **Read receipts.** Never send, show a note (proposed), or also offer a
   **Send receipt** button per message? *Recommendation:* never send.
3. **Failed check and automation.** Block rules, dev class and auto images
   for failed checks (proposed), or only warn? *Recommendation:* block; a
   forged GitHub or Sentry mail must not start an agent thread.
4. **Full PGP and S/MIME to 3k** (proposed), keeping 3i to recognition?
   *Recommendation:* yes. 3k needs the owner's keys or a CA certificate and
   a new dependency (`openpgp`; `pkijs` or similar for S/MIME), each an
   explicit owner decision there.
5. **`secure_delete`** on (proposed) or not? *Recommendation:* on; the
   extra writes happen only on deletes.

## Items proposed for another slice

- **#92 PGP and #97 S/MIME (signing, encryption, verification, keys and
  certificates) → 3k.** Owner action outside code: create or import keys,
  obtain a certificate, gather correspondents' keys; plus a new dependency
  each.
- **#93 database encryption** stays `[позже]` (needs a BB host capability,
  which is an anti-goal to patch).
- **Trusted authserv-ids for "other" servers** (a per-account setting) →
  later, unscheduled.

## Not verified

- iCloud's authserv-id(s) and whether iCloud strips incoming
  `Authentication-Results` carrying its id (live step 1). Until pinned,
  iCloud mail is **Not checked**.
- That Gmail's top block (with `X-Google-*` lines) fits the 64-line cap of
  `capHeaderLines` for every message, so the A-R is always kept; a message
  where it does not is `unchecked`.
- That `mouseover`/`focusin` listeners added from the parent on a
  `sandbox="allow-same-origin"` frame fire in BB desktop as `click` does
  (the click path is shipped and works).
- That `navigate.openUrl` shows nothing that would reveal the original
  (uncleaned) URL; that BB's browser preference does not itself prefetch.
- That `PRAGMA secure_delete` set on the host-provided handle stays for the
  whole load (the SDK says the handle is reused per load) and its cost on
  large deletes (Forget older mail at 20 000 rows).
- The tracker host list and parameter list: reviewed by hand, not measured
  against real mail volume; false positives on 1x1 spacer images are
  harmless (they are invisible).
- Real S/MIME and PGP messages from the owner's mail (fixtures only unless
  the owner has some).
