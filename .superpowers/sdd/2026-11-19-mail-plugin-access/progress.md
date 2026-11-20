# SDD ledger — plan: docs/superpowers/plans/2026-11-19-mail-plugin-access.md
Owner's constraint (2026-11-19): agent access must not break. Agent tools, CLI and mentions are registered through bb.agents/bb.cli, not RPC, so the guard does not touch them; no plugin in the repo or installed references makosh-mail. Each task keeps the agent-tool tests green.
Pre-flight: T1 guardHandlers/PluginCheck -> T3 check: same signature, ok. T2 store methods -> T3/T4/T6: names match. T3 PLUGIN_METHOD_RIGHT "google" marker -> T7: ok. T5 onGoogleGrant -> T7: ok. T7 plugin_grant_google is an owner method not listed in T3's PLUGIN_OWNER_METHODS — Ruling: add it to that list in T7 — plan omission — none.
Ruling: the guard logs each refused plugin call to the plugin log from Task 1 (plugin id and method only) — an unknown legitimate caller would otherwise break silently — one log line per refusal until Task 4's hourly limit.
Task 1: Ruling: the contract walk reads the registered handler map through a vi.mock wrapper of guardHandlers, not through the harness — the harness validates input first and would answer `invalid` before the guard — none.
Task 1: Ruling: two old tests read status_get and message_body as a plugin to observe state; they now read as the client — reads by a plugin are refused by design — none.
Task 1: Ruling: guard tests were written with the guard in one step (RED was the missing module only); the contract walk and the host-level read test were watched failing first — weaker RED for four unit tests.
Task 1: full check 4587/4587 incl. agent tools, build ok.
Task 1: complete (commits 4853998..cbcf614, tests: npx vitest run src/adapters/bb/plugin-guard.test.ts →    Duration  298ms (import 69%, transform 29%, tests 2%, worker 1%))
Task 2: Ruling: pluginLastCall() is left to Task 4, where the log that feeds it appears — the plan lists it under Task 2's port but says "filled in Task 4" — none.
Task 2: Ruling: core and store were written with their tests in one step; RED was not watched for them separately — the suite ran green after, 4597/4597 — weaker RED.
Task 2: complete (commits cbcf614..36bb26c, tests: npx vitest run src/core/plugin-access.test.ts →    Duration  115ms (import 38%, transform 37%, tests 13%, worker 12%))
Task 3: Ruling: a new request is announced over a realtime channel (plugin-access) instead of a server-side notification — Mail's notifications are raised by its page from realtime events, the server has no notification call — the owner is told only while BB's page is open; the request still waits in settings.
Task 3: Ruling: all plugin_* methods come from one object (pluginApiSchemas) and one list PLUGIN_METHODS in the positional contract tests — later tasks add methods without touching 15 filters — none.
Task 3: Ruling: the sixth request is refused with code conflict (the plan names only the message) — none.
Task 3: full check 4616/4616 after the test fix, build ok.
Task 3: complete (commits 36bb26c..3287d08, tests: npx vitest run src/adapters/bb/plugin-api-rpc.test.ts →    Duration  560ms (import 42%, tests 37%, transform 20%, worker 1%))
Task 4: Ruling: accountId is required in search, contacts and invites (the plan had it optional) — the store searches one account or all, and paging over a filtered "all" would leak positions and skip rows — a plugin calls once per account.
Task 4: Ruling: plugin_messages_search takes `query` in Mail's own search syntax instead of address/text/since fields — it is the agents' screened search, reused whole — plugins learn the operators from docs/plugin-api.md.
Task 4: Ruling: invitations are two methods: plugin_invites_list (messages with a calendar part, from the local store) and plugin_invite_read (one parsed invitation, fetched from the server) — parsing needs the raw message over IMAP, a list of parsed events would open a session per row — one more method than the spec's nine.
Task 4: Ruling: `snippet` in search answers is always empty — stored snippets are not redacted (the canary test holds a key in one) — plugins read the message for text.
Task 4: Ruling: sender, recipient and attachment names pass the same redaction as subjects — the canary seed hides secrets there for agents — none.
Task 4: Ruling: plugin_contacts_list has no cursor and attributes a person to the account that wrote with them last (the store's Contact.ownerAccount) — the store has no per-account contact read — a person shared by two accounts shows under one.
Task 4: Ruling: the log's refId holds "plugin:<id>" — the plan said "the plugin id in refId"; the prefix keeps it apart from proposal ids — none.
Task 4: finding for tests: createSqliteStore on a running server's connection replaces its scope SQL functions; test mail is seeded before load.
Task 4: full check 4630/4630, build ok.
Task 4: complete (commits 3287d08..43c6ba5, tests: npx vitest run src/adapters/bb/plugin-api-rpc.test.ts →    Duration  626ms (import 44%, tests 29%, transform 26%))
Task 5: Ruling: the section component was written before its tests; four mutations (Google cell enabled, all rights pre-checked, revoke without the call, refusal not shown) each fail one test, and the Russian test was watched RED — weaker RED for the rest.
Task 5: Ruling: a new request is announced with a toast and an Open action, not a BB system notification (see Task 3's ruling) — seen only with BB's page open.
Task 5: Ruling: Allow… pre-checks the asked rights for every account; Google keys are never pre-checked — a Google key needs its own sign-in per account — the owner unchecks accounts they do not want.
Task 5: full check 4641/4641, build ok. Browser check is part of Task 8.
Task 5: complete (commits 43c6ba5..ce6b342, tests: npx vitest run src/ui/settings/plugin-access-section.test.tsx →    Duration  499ms (tests 38%, environment 36%, import 19%, transform 6%))
Task 6: Ruling: version 1 proposes new letters only; `inReplyTo` is not accepted — a reply's plan fetches the source over IMAP to quote it, and an answer to an invitation needs a calendar part, not a plain reply — a plugin cannot thread a letter under an existing conversation yet.
Task 6: Ruling: the mark is shown in the composer only, not on the row of the Drafts folder — that list shows server messages, not drafts, and has no link to the draft's mark — the owner sees who prepared a letter only after opening it.
Task 6: Ruling: the draft keeps origin "owner" with a separate preparedBy field instead of a new origin value — origin also labels outbox rows and agent paths — none.
Task 6: Ruling: core, handler and badge were written before most of their tests; the tests were then run green — weaker RED; the plan's assertions are all present.
Task 6: full check 4649/4649, build ok.
Task 6: complete (commits ce6b342..3679e98, tests: npx vitest run src/core/plugin-propose.test.ts →    Duration  271ms (import 55%, transform 36%, tests 7%, worker 1%))
Task 7: NOT STARTED — blocked on the owner: step 1 needs a real Google account signed in through Mail with the calendar scope and the Calendar API enabled in the Google project; both Gmail accounts still sign in with app passwords. Nothing of Task 7 is in the code; plugin_google_token does not exist.
Task 7: Ruling: until Task 7 exists the settings table hides the two Google key rights (they would be switches that do nothing), and docs/plugin-api.md lists them as reserved — a plugin that asks for them is shown the request, but the owner cannot grant them yet.
Task 8: steps 1-4 done ahead of Task 7 (docs, overview at 4000/4000, README, manifests ok, check 4649/4649, build ok). Step 5 (end-to-end in the live BB, browser check) waits for the owner's go-ahead.
Final review (opus, 48539985..1afb5e83): ready with fixes — 1 Critical, 3 Important, 5 Minor; client path and agent tools unchanged.
Final: fixed Critical — plugin_contacts_list counted, named and matched mail of ungranted accounts — "contacts of one account count, name and match nothing from another account" (sqlite and fake) RED→GREEN, suite 4656/4656
Final: fixed Important — plugin_invite_read returned the event unredacted — "hides secrets in the event's text and in people's names" RED→GREEN
Final: fixed Important — plugin_invite_read signed in to the mail server without limit and for any message — "does not go to the mail server for a message without a calendar part", "reads at most 30 invitations an hour per plugin" RED→GREEN
Final: fixed Important — plugin_contacts_list with an empty query answered nothing while the docs showed an answer — query is required; "contacts come from shared mail of the granted account" now asserts a contact RED→GREEN
Final: fixed (re-graded from Minor: the owner gets a draft that cannot be sent) — a proposed subject with a line break — "a subject with a line break is refused, as the composer refuses it" RED→GREEN
Final: fixed (reviewer's objection to Task 5's ruling) — Allow… pre-checked every mailbox — now only when there is one — "Allow… opens the asked rights checked…", "with one mailbox Allow… checks the asked rights for it" RED→GREEN
Final: Ruling: plugin_contacts_list has no "everyone" list — the store ranks contacts by a query only; a top-contacts read is new work — a CRM cannot enumerate people without a query yet.
Final: minor (deferred): the 20-a-day proposal limit counts only drafts that still exist (a sent or discarded draft frees a slot).
Final: minor (deferred): plugin_accounts_list shows the address of an account whose AI access is "none".
Final: minor (deferred): a plugin refused outside the API is logged on every call, without the hourly limit.
Final: minor (deferred): app.tsx imports PLUGIN_ACCESS_CHANNEL as a value from core; the log label says "google key" in lower case.
Final: check 4656/4656, build ok, manifests ok.
Task 7 step 1 (2026-11-19, owner at the browser, personal Gmail, grant with mail + calendar): a refresh asking for the calendar scope alone answered 200 with scope = calendar only; tokeninfo of that token: calendar only, 3599 s; IMAP XOAUTH2 with it: refused (authentication failed); Gmail API profile: 403; control — the grant's full token logged in to IMAP. A refresh asking for a scope the grant lacks (contacts): 400 invalid_scope. calendarList answered 403: the Calendar API is not enabled in the Google project (the token's scope is right). The grant was revoked (200); the throwaway script is deleted. Verdict: narrowing works; Task 7 may proceed.
Google project: both of the owner's addresses were added as test users (owner's request); the app stays in Testing — Publish app is disabled until Branding has a home page and a privacy policy.
Task 7: Ruling: no plugin_grant_google method and no flow id — a Google key is granted by the ordinary plugin_grant_set, which checks that the mailbox signs in with Google and that its stored granted scopes hold the service; when they do not, settings offer "Sign in to Google with this access" (the existing sign-in with extraScopes) and the owner turns the key on after it — one less method and no state between a flow and a grant — two clicks instead of one.
Task 7: Ruling: narrowed tokens are cached until one minute before expiry (the plan said 60 seconds) and dropped by forget(); revoking a grant does not drop them — the cache is keyed by grant and scope, not by plugin, and another plugin may hold the same right — a revoked plugin could be handed nothing new (the grant check runs first), so only the already-issued token lives on, as the settings text says.
Task 7: owner's request during the task: a "Renew Google sign-in" button for a working Google mailbox in Mailboxes and sign-in, with a line on the 7-day limit of a test app — done with a test watched RED.
Task 7: the contract test that forbids token keys in outputs now names plugin_google_token.accessToken as the one deliberate exception.
Task 7: check 4668/4668, build ok, manifests ok.
Task 7: complete (commits b784fef..38d47ce, tests: npx vitest run src/adapters/bb/google-tokens.test.ts →    Duration  673ms (import 56%, transform 37%, tests 5%, worker 1%))
Final review 2 (opus, b784fef9..38d47ce2, Google keys): ready with fixes — no security finding; 2 Important, 6 Minor.
Final: fixed Important — a plugin asking only for a Google key could never get one (the sign-in offer existed only for plugins that already held a grant) — "a plugin that asks only for a Google key: a refused Save offers the sign-in in the request itself" RED→GREEN
Final: fixed Important — after the sign-in the toast said to turn the key on even when Google had not given the service — the key is now turned on right after the sign-in and a refusal is said plainly (no test: the path is in app.tsx behind a real sign-in poll)
Final: fixed Minor with it — a rejected sign-in start or poll is caught; one sign-in wait at a time, ended on leaving the page; docs refusal table.
Final: minor (deferred): a Google key switch stays on after the mailbox loses that service (the key call itself is refused).
Final: minor (deferred): plugin_google_token has no in-flight dedup or rate limit; every call writes a log row.
Final: minor (deferred): a superseded refresh token stays in the token cache until evicted and is not revoked at Google.
Final: minor (deferred): the sign-in started from Plugin access still selects the mailbox and closes an open account form when it finishes.
Final: check 4669 tests, 1 timing failure under load (passes alone); build ok.
2026-11-20 (finishing both threads): deferred minors fixed with tests — a plugin refused outside the API is reported once an hour per method; plugin_accounts_list names an account shared with no AI by id only; the log label says 'Google key'. Still deferred: the daily proposal limit counts only existing drafts; a Google key switch stays on after the mailbox loses the service; plugin_google_token has no dedup or rate limit; a superseded refresh token is not revoked at Google; the sign-in started from Plugin access selects the mailbox.
