# Makosh Mail — slice 3i: security and privacy (sender checks and spoofing warnings, trackers and link cleaning, read receipts, signed and encrypted mail recognised)

Status: builder's design, **accepted by the owner on 2026-11-16**: every
decision below is marked *(owner, accepted 2026-11-16)*, and open questions
1–5 are closed as recommended (SafeLinks unwrapped; read receipts never
sent; a failed check stops rules, the dev class and automatic images; full
PGP and S/MIME in 3k; `secure_delete` on). The owner also answered the
builder check's three questions (resolution 1). The "Resolutions after the
builder check" at the end override every section above them. Part B of 3i
(`2026-11-16-mail-slice-3i-part-b-keyboard-reading-flow-design.md`) adds
keys and the reading flow; where the two parts meet, part B's resolutions
section "Interactions with part A" is binding for both.

It follows 3a (organize and read), 3b (write and send), 3c (agent proposals and translation), 3d (sending polish), 3e (inbox triage), 3f
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

Proposed by the builder and accepted by the owner on 2026-11-16. Each line
is marked *(owner, accepted 2026-11-16)*; where a later resolution changes a
decision, the resolution wins.

1. **Scope of 3i:** sender checks and spoofing warnings (#39), tracker
   blocking and link cleaning (#40), read receipts never sent and the request
   shown (#72), signed and encrypted mail recognised but not verified or
   decrypted (#92, #97 partial), deleted rows overwritten on disk (#93
   partial). *(owner, accepted 2026-11-16).* These are the security items that
   need no keys, accounts or new dependencies.
2. **Full PGP (#92) and S/MIME (#97) move to 3k.** Both need the owner to do
   things outside the code (create or import a key pair, get a certificate
   from a CA, collect correspondents' public keys or certificates) and each
   needs a new dependency (`openpgp` for PGP; a CMS/ASN.1 library such as
   `pkijs` for S/MIME, since `node:crypto` cannot parse CMS). *(owner, accepted
   2026-11-16).* 3i lays the ground: the badge, the stored crypto kind,
   and the rule that an encrypted body never reaches an agent or a model.
3. **#93 stays `[позже]`.** `bb.storage.database()` hands out the host's own
   better-sqlite3 handle on a fixed file (sdk 19830–19851) with no
   encryption option, so encrypting the database would need a BB change
   (anti-goal) or field encryption that breaks the FTS5 search index; and the
   key would sit in the same plugin settings as `vaultKey`, readable by an
   agent with shell access, which the backlog's own risk note already says.
   *(owner, accepted 2026-11-16).* The partial step in decision 10 is cheap and
   honest.
4. **Sender check from the provider's own results only.** Mail does not
   verify DKIM or SPF itself (that needs DNS and a DKIM library). It reads
   the `Authentication-Results` the account's provider wrote at the top of
   the message, with the same "trusted authserv-id, topmost block only"
   rules 3e already uses for one-click unsubscribe (`TRUSTED_AUTHSERV`,
   `trustOf`). Gmail (`mx.google.com`) is trusted today; iCloud's id is
   pinned at the live check (3e left it empty, `unsubscribe.ts` 68–72);
   other servers get **Not checked**. *(owner, accepted 2026-11-16).* A forged
   result lower in the headers is ignored; nothing is fetched from the
   network.
5. **What a failed check does.** A message whose sender check is **failed**
   (DMARC fail, or no DMARC result and SPF fail with no DKIM pass aligned
   with From) shows a warning strip; does not load remote images through
   **Always show from** (per-message **Show images** still works); gets no
   dev class, so no Dev digest entry, no alert card and no rule match on dev
   fields; and never prepares or starts a mail rule (#82). Agent text gains
   one fixed line "Sender check: failed". *(owner, accepted 2026-11-16).* A
   spoofed GitHub, Sentry or bank mail must not steer automation or confirm
   an open.
6. **Warnings, not verdicts of trust.** Mail shows warnings only (failed
   check, foreign Reply-To, lookalike domain, a name that shows another
   address, mixed alphabets in a domain). A **pass** is shown in Details,
   never as a badge in the list or the header. *(owner, accepted 2026-11-16).*
   A green tick on a phishing domain that passes its own DMARC would mislead.
7. **Lookalike domains** are judged against domains the owner wrote to
   (Sent rows and `sent_recipients`) and the owner's own identity domains,
   computed when a message is opened, not stored. A From domain that is not
   itself known is flagged when its name equals a known one after mapping
   confusable characters, or is one edit away (names of 5+ characters), or
   mixes alphabets in one label. *(owner, accepted 2026-11-16).* Known
   correspondents are the domains a spoofer imitates; the owner's own mail is
   local and ready.
8. **Trackers are removed even when images are allowed.** In allowed mode,
   images that are tracking pixels (1x1 or hidden by size or style) and
   images from a short built-in list of open-tracking hosts are dropped; the
   image bar says "2 trackers blocked". Default mode is unchanged (nothing
   remote loads) and the bar says how many trackers the message carries.
   No setting. *(owner, accepted 2026-11-16).* It only removes loads the owner
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
   names the tracking host. *(owner, accepted 2026-11-16).* Nothing new goes
   on the network; one choke point is easy to test.
10. **Deleted mail is overwritten on disk.** The plugin's connection runs
    `PRAGMA secure_delete = ON` once per load, so rows Mail deletes (Forget
    older mail, expired server hits, account removal, purges) are zeroed in
    the database file rather than left in free pages. *(owner, accepted 2026-11-16).* It is the part of #93 the plugin can do alone; the cost is
    extra writes on delete. README states that the WAL file and backups
    are outside this.
11. **Read receipts are never sent.** Mail has no code that sends a
    Message Disposition Notification and 3i keeps it that way; a test
    pins it. When a message asks for one (`Disposition-Notification-To`,
    `Return-Receipt-To`, `X-Confirm-Reading-To`), the reading pane shows a
    quiet line: "The sender asked for a read receipt. Makosh Mail does not
    send receipts." There is no **Send receipt** button. *(owner, accepted 2026-11-16).* The backlog says "ignored by default"; a button can come later
    if the owner ever wants one (open question 2).
12. **Older mail is checked when opened.** Rows synced before 3i have no
    stored sender check. Opening one (in the reading pane only) fetches its
    header fields once with `BODY.PEEK` through the account's queue, as 3e's
    `fetchUnsubscribeInfo` does (`server.ts` 2511–2545), and stores the
    result. Nothing is backfilled in bulk. *(owner, accepted 2026-11-16).* One
    round trip per opened old message, no server change.
13. **Signed and encrypted mail is recognised, never claimed valid.**
    `multipart/signed` (PGP or S/MIME), `multipart/encrypted` (PGP/MIME),
    `application/pkcs7-mime` and inline `-----BEGIN PGP MESSAGE-----` /
    `SIGNED MESSAGE-----` armor get a neutral badge: "Signed (PGP) — Mail
    does not check signatures" or "Encrypted (S/MIME) — Mail cannot read
    it". An encrypted body is never handed to an agent, a model, BB or the
    attachment-text index (it is ciphertext, but its presence is still
    nobody else's business). *(owner, accepted 2026-11-16).*
14. **One migration element (14)**, appended to `MIGRATIONS`; element 14
    joins the SHA pin. *(owner, accepted 2026-11-16).* Shipped elements 0–13
    stay frozen, as in every slice.
15. **No new dependency.** Domain handling uses the existing
    `toAsciiDomain` (`compose-address.ts` 47) and a small registrable-domain
    rule; the confusable map, tracking parameters, tracker hosts and
    redirect wrappers are short lists written for Mail, not ported.
    *(owner, accepted 2026-11-16).* `tldts` exists in `node_modules` only as
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

All five are **closed on 2026-11-16 as recommended** (the owner accepted
every recommendation).

1. **Unwrapping Outlook SafeLinks.** Unwrap Google, Outlook SafeLinks and
   Facebook wrappers (proposed), or leave SafeLinks alone because it is an
   employer's scanner? **Answer (2026-11-16): unwrap all three.**
2. **Read receipts.** Never send, show a note (proposed), or also offer a
   **Send receipt** button per message? **Answer: never send; the note
   only, no button.**
3. **Failed check and automation.** Block rules, dev class and auto images
   for failed checks (proposed), or only warn? **Answer: block.** Resolution
   5 extends "auto images" to lookalike and "name shows another address"
   warnings (builder-check owner question 3).
4. **Full PGP and S/MIME to 3k** (proposed), keeping 3i to recognition?
   **Answer: yes, 3k.**
5. **`secure_delete`** on (proposed) or not? **Answer: on** (resolution 8
   adds the FTS5 option).

## Items proposed for another slice

- **#92 PGP and #97 S/MIME (signing, encryption, verification, keys and
  certificates) → 3k.** Owner action outside code: create or import keys,
  obtain a certificate, gather correspondents' keys; plus a new dependency
  each.
- **#93 database encryption** stays `[позже]` (needs a BB host capability,
  which is an anti-goal to patch).
- **Trusted authserv-ids for "other" servers** (a per-account setting) →
  later, unscheduled.
- **Cleaning quoted content on reply and forward** (the original's tracking
  links and pixels travel onward in the quote) → later, unscheduled
  (resolution 20).

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

## Resolutions after the builder check

These override every section above. The owner accepted every decision and
closed open questions 1–5 as recommended on 2026-11-16, and answered the
builder check's three questions (resolution 1). Every blocking finding
(B1–B7), gap (G1–G12) and nit of the builder check is resolved below; the
builder's proposed resolution is taken unless a resolution says why not.
Names were re-checked against the tree at commit `168abbb5` (no Mail code
changed after `e6c41bbe`): `src/core/sync.ts`, `src/core/unsubscribe.ts`,
`src/core/agent-text.ts`, `src/core/presend.ts`, `src/core/file-kinds.ts`,
`src/ui/sanitize.ts`, `src/ui/message-frame.tsx`, `src/ui/reading-pane.tsx`,
`src/adapters/bb/sqlite-store.ts`, `src/adapters/bb/bb-rpc.ts`, `server.ts`,
`server.test.ts`, `src/core/contract.test.ts`. Interactions with part B are
in part B's resolutions ("Interactions with part A") and bind this part too.

1. **The owner's answers to the builder check's questions** (2026-11-16).
   - **Link text names one site, the target is a known click-tracking
     host** (most newsletters): no dialog. The status line says "→ via
     tracking redirect at `click.example-esp.com`; Mail cannot see where it
     ends", and the link opens on the first click. The known hosts are a
     short list `TRACKING_REDIRECT_HOSTS` in `src/core/trackers.ts` (ESP
     click hosts only, exact host or a listed suffix after a dot, reviewed in
     the plan). The dialog stays for every other mismatch: an unknown or
     unlisted target, a host that mixes alphabets, and a lookalike of a known
     domain (resolution 10). The owner accepts that a phish sent through a
     listed ESP skips the dialog; the status line still names the tracking
     host.
   - **Punycode-only hosts** (`.рф` and other IDN without mixed alphabets or
     a lookalike match): no dialog; the status line shows the `xn--` form.
     `unusualHost: "punycode"` stays in `CleanLink` for the status line and
     no longer gates the dialog (G3).
   - **Lookalike and "name shows another address" also stop automatic
     images**, as the design text says; **Show images** per message still
     works. Decision 5 is read with this addition (B4).

2. **A failed row never gets a dev class, not even from the backfill (B1).**
   Replaces "`prepareMessage` skips `classifyDev`" in "Effects of a failed
   check".
   - For a `failed` row `prepareMessage` sets `dev: null` (stored as `''`,
     "checked, not dev"), whatever `context.classifyDev` says. The store's
     write at `sqlite-store.ts` 3183 then writes `''`.
   - `devUnclassified` (`sqlite-store.ts` 6383–6389) adds
     `AND (sender_check_json IS NULL OR json_extract(sender_check_json, '$.state') <> 'failed')`,
     so `devBackfill` (`src/core/dev-backfill.ts` 35) never classifies a
     failed row from From and subject.
   - When the open-time refresh (resolution 7) turns a row `failed`, the
     same store write clears its dev columns to `''` (Dev view, alert card
     and rule dev matches drop it on the next read).
   - Tests: all three paths (sync, backfill query, refresh write).

3. **Own mail is exempt by folder role only (B2).** Replaces "Own mail (Sent,
   Drafts, the owner's identities in From) is not checked".
   - A message in a Sent or Drafts role folder, and the plugin's own outbox
     copies, are `unchecked` with no warnings. Every other folder judges the
     message from its A-R whoever From claims, so mail forged from the
     owner's own address into the Inbox is checked like any other.
   - `PrepareContext` (`sync.ts` 134–140) gains `folderRole: SpecialUse |
     null`. `syncFolder` passes the folder's role; the 3h server-search and
     history jobs build their own context (`server-search-jobs.ts` 323) and
     pass it too. A test feeds a forged Inbox message from an owner address
     with a trusted `dmarc=fail` and expects `failed`.

4. **The A-R reading rules (B3).** Added to "Sender check"; `trustOf` and its
   tests stay unchanged.
   1. `senderCheckOf` uses only the **topmost** trusted A-R header (the
      provider prepends its own, so a sender cannot write above it). Other
      trusted A-R headers below it are ignored for the state; Details may
      list them as "also present".
   2. Within that header the **worst result per method wins**: any
      `dmarc=fail` gives `failed`, and a pass never cancels a fail.
   3. A `dmarc` entry counts only when its `header.from` equals the message's
      From domain (ASCII, lower case). A `dmarc` entry for another domain is
      kept for Details and does not decide the state.
   4. `parseAuthResults`' `;` split becomes quote-aware, and `stripComments`
      tracks quoted strings inside comments, so a quoted `smtp.mailfrom`
      local part containing `;` or `)` cannot inject an entry. Bounds (4 KB
      per value, 20 entries) run first, as designed.
   5. More than one From header line, or more than one mailbox in From, is
      never `ok`: the state is `failed` when the results say so, else
      `unchecked`.
   - Tests: a forged `Received:` plus a trusted-id A-R above From with no
     `DKIM-Signature` (only the topmost trusted header counts, and it is the
     provider's); duplicate `dmarc` entries (fail wins); a quoted `;`; an
     unbalanced `)` inside a comment; two From lines.

5. **Where automatic images are decided (B4, owner answer 3).** Replaces the
   "Images" bullet of "Effects of a failed check", which put the rule in the
   store; disguise warnings are computed at read time and never stored.
   - A pure `autoImagesAllowed(check, warnings)` in `src/core/sender-check.ts`:
     true only when the state is `ok` or `unchecked` and there is no
     `lookalike` or `name_shows_address` warning. `unknown` (resolution 7) is
     **not** allowed until the refresh has judged the row; an old message
     from an always-show sender therefore loads its images one round trip
     later, and stays blocked (with **Show images**) if the refresh fails.
   - The server's `message_body` returns `remoteImagesAllowed =
     stored images_allowed && autoImagesAllowed(...)` (the store keeps
     answering the stored rule only, `sqlite-store.ts` 3620–3647).
   - The page's own paths are gated too: `remoteImages` in
     `reading-pane.tsx` 959–960 becomes `remoteImageIds.has(id) ||
     (imageSenders.has(sender) && autoImagesAllowed(header.senderCheck,
     header.warnings))`, and the "Images … are always shown" region and
     **Always show** (`senderTrusted`, `reading-pane.tsx` 345) are hidden for
     such a message, with the bar text "Images from this sender are not
     loaded automatically because …" (fixed reasons: the check failed / the
     domain looks like another / the name shows another address / the
     sender check has not run yet). The stored always-show row is never
     removed.
   - Tests in the server (`message_body`) and the page (`app.test.tsx`: an
     always-show sender with a failed check loads nothing; **Show images**
     still loads), not in the store.

6. **Encrypted bodies are dropped before the store (B5).** Replaces the
   "Encrypted rows" bullet of "Signed and encrypted mail".
   - For `pgp_encrypted` and `smime_encrypted`, `prepareMessage` sets
     `bodyText` and `bodyHtml` to null and the snippet to empty before the
     store sees the message. Every reader of `store.getBody` (`server.ts`
     964, 1000, 4567, 4579; `bb-rpc.ts` 305, 554, 1336, 1397, 1528;
     `slice-3h-rpc.ts` 781; `translate-jobs.ts` 116; `compose.ts` 255) and
     the three direct `htmlToText` callers (`ai-input.ts` 162,
     `agent-propose.ts` 430, `translate.ts` 149) are then safe by
     construction. The FTS triggers of frozen element 1 stay as they are; a
     null body indexes nothing.
   - The pane shows the placeholder from `crypto`; agent and BB text print
     "[encrypted message — not readable]" from the same field.
   - The ciphertext stays reachable through the attachment list and
     **Download .eml**. `attachmentTextCandidates` (`sqlite-store.ts`
     6290–6300) adds `AND (m.crypto IS NULL OR m.crypto NOT IN
     ('pgp_encrypted', 'smime_encrypted'))`, so an armored `text/plain` part
     of an encrypted message is never indexed (builder addition: postal-mime
     can hand such a part over as text).
   - An old row that the refresh finds encrypted (resolution 7) has its
     body nulled in the same write; the existing update trigger removes it
     from `messages_fts`.

7. **The old-row check: an `unknown` state and one refresh RPC (B6).**
   Replaces decision 12's "stores the result" detail, the contract's
   `senderCheck.state` and `sender_check_refresh` in "RPC contract".
   - `senderCheck.state` is `"ok" | "failed" | "unchecked" | "unknown"`;
     `unknown` is a NULL `sender_check_json`. A stored `unchecked` with
     `authserv: null` on a preset whose `TRUSTED_AUTHSERV` is no longer
     empty also reads as `unknown`, so pinning iCloud's id rechecks old
     iCloud mail on open.
   - `sender_check_refresh { messageIds: string[] (1–50); force?: boolean }
     → { refreshed: number; failed: number }`, owner only (refuses plugin
     callers). The server groups the ids per account and folder and runs one
     read-only session per folder through the account queue (PEEK header
     fetch, UIDVALIDITY guard, as `fetchUnsubscribeInfo`, `server.ts`
     2511–2545). Without `force` it writes only where the row is `unknown`;
     `force` (Details' **Check again**) overwrites.
   - The page calls it only for **expanded** messages whose state is
     `unknown`, after the conversation has stayed open briefly (part B's
     interaction I3), never for collapsed or stacked ones. A 50-message old
     thread is one call and one session per folder.
   - The same write fills `receipt_requested` and `crypto` where NULL (the
     header fields include `Content-Type`; inline armor is judged from the
     stored body's first non-blank line), and nulls an encrypted body
     (resolution 6) and the dev columns of a failed row (resolution 2).
   - `message_source` already fetches the raw message (`server.ts`
     2899–2906): it computes `authenticity` from those full headers (no
     64-line cap) and stores the check where the row is `unknown`.

8. **`secure_delete` covers the search indexes, and the shipped line is
   tested (B7).** Replaces "Deleted rows overwritten (#93 partial)" and the
   migration test line "`secure_delete` reads back 1".
   - An exported `hardenDatabase(db)` in `sqlite-store.ts` runs
     `PRAGMA secure_delete = ON`, then, each in its own try/catch,
     `INSERT INTO messages_fts(messages_fts, rank) VALUES('secure-delete', 1)`
     and the same for `attachment_text_fts` (the FTS5 option, SQLite 3.42+;
     it is stored in the FTS config, so repeating it each load is harmless).
     It returns `{ pragma: boolean; fts: boolean }`.
   - `server.ts` calls it once per load, right after `migrate` (the FTS
     tables exist only then; 1133–1134). The store test asserts the pragma
     reads back 1 and both FTS options are set on the test database after
     `hardenDatabase`; a server test asserts the server calls it (fake
     database records the call).
   - The host's SQLite version is not known. If the FTS option fails, the
     server logs `secure_delete: fts option unavailable` once, and README
     says the search index may keep words of deleted mail until SQLite
     merges it. README's sentence names the WAL file, backups and BB's own
     files as outside, as designed.
   - The "test that runs every path with secret- and address-filled
     fixtures (3f)" is the canary block in `server.test.ts` ("Agent paths
     (slice 3f) … the canary test", from line 5187, `CANARY`, `CANARIES`);
     the plan adds the 3i paths there.

9. **Links that leave Mail by other routes are cleaned too (G1).** Added to
   "Links".
   - `sanitizeEmailHtml` gains `cleanLinks: boolean` and rewrites each kept
     `href` through `cleanLink(..., { clean: cleanLinks })` (with the
     anchor's text). A rewritten anchor carries Mail's own
     `data-mk-cleaned="n"` and `data-mk-unwrapped` marks for the status
     line; the sanitizer already drops every `data-mk-*` attribute the mail
     brings (`sanitize.ts` 418), so the sender cannot forge them. That one
     change covers the frame, print and the saved printable page
     (`print.ts` 57–60, `app.tsx` 3625–3633), the host's copy-link and
     link drag.
   - `htmlToPlainText` (`sanitize.ts` 497–503) gets the same option, so
     "Show plain text" prints cleaned `<url>`s.
   - `devLinks` are cleaned where the server computes them (`bb-rpc.ts`
     1364), with `{ clean: true }`.
   - The click handler still runs `cleanLink` (idempotent) for the dialog.
     `openLink` refuses when `cleanLink` returns null ("This link cannot be
     opened here."), so a PDF-viewer or alert-card link with a custom scheme
     never reaches `navigate.openUrl` (which would launch application links,
     sdk 26513). Other exits were checked and are fine (PDF links, alert
     card, dev strip all reach `openLink`; there is no `window.open` or
     `openExternal`).

10. **When the deceptive-link dialog opens (G2, G3, owner answers 1–2).**
    Replaces "A link whose visible text names a different site, or whose
    host is punycode or mixes alphabets, opens only after a dialog".
    - `CleanLink.deceptive` is set when the visible text looks like a URL or
      bare host and its `orgDomain` differs from the final target's, **and**
      the target host is not on `TRACKING_REDIRECT_HOSTS`. A listed tracking
      host sets `trackingHost` and gets the status-line note only.
    - The dialog opens for `deceptive`, for `unusualHost: "mixed_script"`,
      and for a target whose `orgDomain` is a lookalike of a known domain
      (`skeleton` match, resolution 11; the page passes the known-domain
      skeleton set it already receives for the open thread). Punycode alone
      never opens it.
    - The dialog wording names what it found ("says X but opens Y" / "mixes
      alphabets" / "looks like Y, which you write to") and shows the host in
      ASCII.

11. **A hand-written punycode decoder in core (G4).** Added to "Disguise
    checks" and Task 2. `toUnicode` does not exist and `node:` imports are
    forbidden in `src/core`. `src/core/punycode.ts` implements RFC 3492
    decoding for one label (bounded to 63 characters input, refusing bad
    digits and overflow) and `toUnicodeDomain(ascii)`. Tests use the RFC
    3492 section 7.1 samples with the Unicode written as `\u` escapes.
    `skeleton()` drops the dead `I`→`l` entry (inputs are lower-cased
    first).

12. **Parameter removal and unwrapping rules (G5).** Added to "Links".
    - Tracking parameters are removed at string level: matching `name=value`
      segments are cut from the query and the rest is kept byte for byte
      (no `URLSearchParams` re-serialization, which re-encodes and can break
      signed links). A test asserts the other parameters are byte-identical.
    - Order: unwrap one level, then clean the target, then run the
      deceptive, mixed-script and lookalike checks on the final URL.
    - Wrapper hosts match exactly (`www.google.<tld>`, `google.<tld>` with
      `<tld>` one or two labels from the `orgDomain` rule;
      `*.safelinks.protection.outlook.com`; `l.facebook.com`,
      `lm.facebook.com`), never by substring: `google.evil.example` is not
      a wrapper.
    - The unwrapped target must be `http:` or `https:`; `mailto:` and
      anything else leave the wrapper URL as it is.

13. **Trackers against the sanitizer (G6).** Replaces "in default mode the
    would-be trackers are counted among the blocked images" in "Trackers".
    - `blockedRemoteImages` excludes trackers; `trackers` is a separate
      count. A message whose only remote images are trackers shows the count
      and no **Show images**. The sanitizer comment at `sanitize.ts`
      436–437 is corrected.
    - In allowed mode a tracker `<img>` is **removed**, not only stripped of
      its `src`, so `markQuotes`' "any `<img>` is content" check
      (`clone.querySelector("img")`) decides as for mail without the pixel.
    - `print.ts` 60 uses the non-tracker blocked flag for "Remote images are
      not printed".
    - `TRACKER_HOSTS` lists real open-tracking hosts only. The existing
      fixture `https://tracker.example.org/pixel.gif` (`sanitize.test.ts`
      28, 195) must stay a non-tracker in allowed mode, so neither
      `tracker.example.org` nor a bare `/pixel.gif` path shape is listed.
    - Limit stated in README: an image hidden by a `<style>` class or a
      hidden parent is not detected (no layout). Dark mail (3h) does not
      interact.
    - `src/core/trackers.ts` holds `TRACKER_HOSTS` and
      `TRACKING_REDIRECT_HOSTS`; the "so the server can count too" remark
      is dropped (no server consumer).

14. **The status line (G7).** Replaces "shows the status line under the
    frame". The frame is as tall as its content (`message-frame.tsx` 315),
    so the line is sticky at the bottom of the reading pane's scroll area,
    one per pane (the hovered message's). It clears on `mouseout` /
    `focusout` of the anchor and on a new `srcDoc`. The listeners are added
    in the frame's existing load handler beside `click`/`auxclick` and
    removed by the same detach (no new sandbox token).

15. **The agent line and agent link cleaning (G8).** Added to "Effects of a
    failed check" and "Links".
    - The "Sender check: failed" / "Sender warning: …" line sits in Mail's
      header block directly after `From:`. `skills/mail/SKILL.md` says that
      only header-block lines are Mail's, that a "sender check" sentence in
      the body is the sender's text, and that Mail never prints a positive
      result.
    - Link cleaning in agent and BB text is a URL pass over the rendered
      body text **before** `redactSecrets` (`agent-text.ts` 393), not a
      change inside `scanHtml` / `htmlToText`, whose output also feeds
      snippets, dev links and stored text. It always uses `{ clean: true }`,
      whatever `cleanLinks` says (intended: an agent fetching a link must
      not confirm a tracked open).
    - Inbox rows for agents (`renderInboxForAgent`) get only the stored
      `failed` marker; disguise warnings stay per message.

16. **Receipt and content-type headers stay out of `unsubscribeHeaders`
    (G9).** Replaces "the gateway adds them to the kept header lines".
    `FetchedMessage` gains `receiptRequested: boolean` and `contentType:
    string | null`, read from `parsed.headers` in the gateway. The kept
    trace/unsubscribe lines are unchanged, so `trustOf`'s block end and the
    64-line cap are unaffected. The old-row fetch asks for
    `SECURITY_HEADER_FIELDS` but filters the block to the unsubscribe names
    before judging, so sync-time and open-time verdicts agree.

17. **Contract and plumbing (G10).** Added to "RPC contract" and "Pre-send".
    - `PresendIssue` gains `{ kind: "reply_to_elsewhere"; addresses:
      string[] }`; `PresendInput` gains `replyToElsewhere: string[]` (the
      source's flagged addresses). Pre-send runs in core with the store,
      not in the page: `checkDraft` (`src/core/sending-settings.ts`
      204–225) and the agent proposal checks (`agent-proposals.ts` 535)
      compute it from the source message's stored From and Reply-To through
      `disguiseWarnings`. The issue also renders on the agent send card
      (`agent-send-card.tsx` 365).
    - `messageHeaderSchema` gains `senderCheck`, `warnings`,
      `receiptRequested`, `crypto` with zod defaults (`{ state: "unknown",
      summary: null }`, `[]`, `false`, `null`), so existing fixtures and
      `src/core/testing/fakes.ts` (979) need no churn beyond new tests.
    - `thread_get` and `message_body` keep serving plugin callers
      (`server.ts` 2836–2848). The new `warnings` hold only addresses and
      domains such a caller can already read there; this is a known and
      accepted exposure, not an oversight. `sender_check_refresh` refuses
      plugin callers.

18. **Logs (G11).** Replaces the "Logs" bullet of "Security and privacy".
    The plugin log gets `sender_check: fetch failed (kind)` with the message
    id (as `server.ts` 2542 does) and `secure_delete: fts option
    unavailable`; nothing else. `trackers=n` and `links: cleaned=n` are
    dropped (page-side numbers with no log path). No address, domain, URL or
    header value reaches the plugin log, the agent log or realtime
    (realtime payloads stay ids and tokens).

19. **Tests added (G12).** Added to "Testing".
    - The tests named in resolutions 2–8.
    - Page: an always-show sender does not load images for a failed,
      lookalike or name-shows-address message, nor for an `unknown` one
      before its refresh.
    - Print and the saved printable page carry cleaned hrefs; the plain view
      prints cleaned URLs.
    - `cleanLink` returning null blocks `openUrl` (fake `navigate`).
    - Wrapper-host spoof `google.evil.example`; a SafeLinks wrapper whose
      target is `mailto:` stays wrapped.
    - Punycode decoder RFC samples.
    - `hardenDatabase` sets the pragma and both FTS options; the server
      calls it.
    - Read receipts, concretely: the MIME built for every compose kind (new,
      reply, reply all, forward, draft resume, outbox send) has no
      `Disposition-Notification-To`, `Return-Receipt-To` or
      `X-Confirm-Reading-To` header and no `multipart/report`; and a source
      scan of `src`, `server.ts`, `app.tsx` finds those header names only in
      the detection file (`src/core/receipts.ts`) and its test.
    - Timing: `disguiseWarnings` for a 200-message thread against 5 000
      known domains, one call, generous bound; the known set is indexed by
      skeleton and by TLD and first-label length (about 10^6 cheap
      comparisons at worst).
    - The canary block in `server.test.ts` (resolution 8) covers
      `sender_check_refresh`, the new header fields and the agent line.

20. **Nits.**
    - `smime_encrypted` matches `smime-type` `enveloped-data`,
      `authEnveloped-data` or absent only; `compressed-data` and
      `certs-only` are not encrypted.
    - Inline PGP armor counts only as the **first non-blank line** of the
      text, so mail that quotes armor further down is not flagged.
    - Opaque-signed S/MIME (`smime-type=signed-data`) has no readable body:
      `smime_signed` with a body placeholder "This signed message's text is
      inside the signature. Open it in a mail client that reads S/MIME."
    - README says a failed check can be a mailing list or a forwarder (Mail
      does not evaluate ARC); the strip's "could not confirm" wording
      already fits.
    - Reply and forward quoting still carry the original's tracking links
      and pixels onward: listed under "Items proposed for another slice".
    - `disguiseWarnings` considers at most 10 Reply-To addresses.

21. **Not verified, updated.** Still open: iCloud's authserv-id (live step
    1); whether Gmail strips incoming A-R headers with its own id
    (resolution 4 does not depend on it); the host BB's SQLite version and
    so whether the FTS `secure-delete` option applies (resolution 8);
    whether `mouseover`/`focusin` from the parent fire in BB desktop.
    Verified by the builder check: `db.pragma("secure_delete = ON")` is
    callable on the SDK handle and reads back 1 (better-sqlite3 in the
    plugin's `node_modules`, SQLite 3.53.2).

## Resolutions after the review

The slice review (after the build) changed three behaviours of this part.
These override the sections and resolutions above where they differ.

1. **An anomaly is a failed check (review findings 1 and 9).** Replaces
   resolution 4.5's "`unchecked`" and the "never `ok`" rule for a
   malformed header. A check is `failed` (with `decidedBy: null`) when From
   holds more than one sender, when the provider's header could not be read
   in full (a value over 64 KB, more than 20 DKIM entries, or a quote or
   comment left open), or when every DMARC entry names a domain other than
   the From domain (an entry naming none decides nothing). `failed` is
   chosen over a separate flag so that one state drives every effect
   already keyed to it: no dev class (sync, backfill query, refresh), no
   rule match, no alert, no automatic images, the agent marker and the
   strip. The strip's summary names the anomaly ("more than one sender in
   From", "the provider's results could not be read in full", "the
   provider's DMARC result names another domain"). `readStoredCheck`
   applies the same rule to a check stored before the review. Reading
   itself changed with it: SPF and DMARC entries are read past the DKIM cap
   and through the whole value (up to 64 KB, in linear time); an
   unbalanced value is read a second time with comments taken out whole and
   every non-`pass` answer of that reading counts too.
2. **A stored check is cut, never dropped (finding 3).** Replaces "over
   2 KB, not stored". `fitSenderCheck` removes Details' extras until the
   JSON fits `SENDER_CHECK_MAX_BYTES`: DMARC for other domains, then DKIM
   entries (not aligned first), then the domains, then the authserv-id.
   The state, basis and `decidedBy` always stay, so a failure is stored and
   its dev class cleared like any other.
3. **Details does not count a result the sender wrote under its own
   headers (finding 12).** `message_source` judges the whole raw header
   block: the first header outside the kept names stays as an empty marker,
   so the provider's top block ends where it really does. Sync and the
   refresh still see only the fields they fetch (unchanged).
