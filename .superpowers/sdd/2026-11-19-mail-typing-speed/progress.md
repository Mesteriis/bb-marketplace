# SDD ledger — plan: docs/superpowers/plans/2026-11-19-mail-typing-speed.md
Spec: docs/superpowers/specs/2026-11-19-mail-typing-speed-design.md (approved in advance by the owner's "Завершай все что наметили"; my reading)
Pre-flight: Task 1 produces editor-typing.ts plugins / Task 2 and 4 add plugins to the same file — one typingExtension taking all options; Task 3 produces template fields / Task 4 consumes TemplateView in the popover — same type. No conflicts.
Task 1: Ruling: the owner's replacements are one text setting (`from => to` separated by `;` or new lines) in Mail settings → Templates → Typing, not a list editor — the page's settings controls have a one-line text field only — costs comfort past a dozen pairs.
Task 1: Ruling: `THe` → `The` applies from three letters, except a two-letter acronym's plural (IDs, PRs) — the spec's own example is three letters.
Task 1: Ruling: Enter also finishes a word (fixed without an undo step of its own; Mod+Z still undoes).
Task 1: note: the editor tests were written with the plugin, not before it; the core rules were RED first.
Task 1: complete (commits 5dd8c39..1074340, tests: npx vitest run src/core/autocorrect.test.ts src/ui/editor-typing.test.ts src/core/page-settings.test.ts →    Duration  277ms (environment 43%, import 26%, tests 20%, transform 10%, worker 2%))
Task 2: Ruling: the phrases are rebuilt on the first phrases_list after ten minutes (the page asks when a composer opens), not at start and after each send — the same freshness with no work for an owner who never writes — costs: a phrase from a letter sent a minute ago shows up to ten minutes later.
Task 2: Ruling: the grey text shows only with the cursor at the end of its paragraph (mid-line it would push the text after it); a phrase is a sentence without digits, addresses or links.
Task 2: Ruling: new method lists of this project share one list TYPING_METHODS in the contract (in every "later" filter once).
Task 2: note: core and plugin tests were written with the code; the server test was run after it.
Task 2: complete (commits 1074340..d243c7e, tests: npx vitest run src/core/phrases.test.ts src/ui/editor-typing.test.ts src/core/contract.test.ts →    Duration  634ms (environment 38%, tests 32%, import 20%, transform 9%, worker 1%))
Task 3: Ruling: the subject and recipients live in one JSON column (`extras_json`), not four columns — one migration step, read whole anyway.
Task 3: Ruling: a template's file bytes travel through the draft's compose_attachment_chunk, keyed `template:<id>` in the upload book; only begin and finish are new methods — no second chunk protocol.
Task 3: Ruling: files are added to a saved template only (the form says "Save the template first"); recipients are typed as one comma-separated line per field.
Task 3: Ruling: `{first_name}` uses the first To recipient after the template's own recipients are merged; a role address (info@, sales@) or a code gives no name and the variable stays, flagged by the pre-send check as `placeholder_left`.
Task 3: Ruling: the limit refusals of a template's files use the upload book's text ("Attachments are over the size limit", code invalid).
Task 3: note: three commits (store, server, UI); tests written with or just before the code; the composer and server tests were RED first.
Task 3: complete (commits d243c7e..a2b1a3e, tests: npx vitest run src/core/snippets.test.ts src/ui/settings/templates-section.test.tsx src/core/sending-settings.test.ts →    Duration  534ms (import 34%, tests 28%, environment 23%, transform 15%, worker 1%))
Task 4: Ruling: the `;` list shows under the composer's toolbar (where the Templates popover opens), not floating at the cursor — no positioning code, same place for both ways to pick — costs the eye a jump on a long message.
Task 4: Ruling: the list filters by the name containing the letters (not only starting with them), shows at most 8, and Tab takes like Enter.
Task 4: complete (commits a2b1a3e..380d500, tests: npx vitest run src/ui/editor-typing.test.ts →    Duration  313ms (environment 46%, tests 33%, import 14%, transform 7%, worker 1%))
Task 5: Ruling: the introducer is the reply's first To recipient as the draft was prepared; the offer line needs intro words in the subject or the first 600 characters, the key (Ctrl/Cmd+Shift+I) works in any reply with someone else in it.
Task 5: Ruling: the thank-you line is in the page's language, "Thank you! …" without a name when the sender has none.
Task 5: Ruling: a quoted selection is plain text (formatting of the original is not kept), each line its own quoted paragraph, as stored-text quotes already are.
Task 5 and 6 share one commit (the code of 5, README, CHANGELOG, overview and the sheet of 6).
Task 6: Step 4 (live BB) not done: batched with the next deploy.
Task 5: complete (commits 380d500..076afc7, tests: npx vitest run src/core/intro.test.ts src/ui/quick-quote.test.ts src/core/compose.test.ts →    Duration  204ms (environment 42%, import 23%, tests 19%, transform 14%, worker 2%))
Task 6: complete (commits 380d500..076afc7, tests: npx vitest run src/ui/shortcut-sheet.test.tsx src/ui/shortcuts.test.ts →    Duration  413ms (environment 52%, import 23%, tests 19%, transform 5%, worker 1%))
Final review: one opus reviewer on 5dd8c393..076afc7e; one fix pass, commit after it. Suite 4892/4892, exit 0.
Final: fixed an owner's replacement written with capitals (US, IT) rewriting the plain words — "an owner's replacement written with capitals applies to exactly that spelling" RED→GREEN.
Final: fixed real words and chosen short forms in the slip lists (defiantly, calender, wont, cant, whit, payed, ненужно, pls, спс, щас, im, publically, cancelation and six more removed) — "%s is a word or a chosen short form" RED→GREEN.
Final: fixed a capital after e.g., etc., т.е., p.m. and at the start of a host name; the first word after a line break is now fixed — "does not capitalize after an abbreviation…" RED→GREEN.
Final: fixed the owner's signature lines becoming phrases (a reply has no mark above them); placeholders and over-long sentences are no phrases; a template save rebuilds the list; each body is read up to 8 000 characters — "never takes the owner's signature lines…" RED→GREEN. The server's passing of signatures is not tested by itself.
Final: fixed a selection left in a message's frame shaping every later reply (used once, then cleared) and a selection in the header row counting as a quote — "ignores a selection in the message's header…" RED→GREEN; the page also says "Replying with only the selected text quoted".
Final: Ruling: two capitals (THe) are fixed only where a sentence starts — inside a sentence such words are units and brands (MHz, MBps, VMware) — costs: "HEllo" typed mid-sentence stays.
Final: Ruling (reverses Task 5): the thank-you line is in the conversation's language (Russian when the subject has Cyrillic, else English), not the page's.
Final: fixed the intro offer on "meet" and "представляет", on CSS text of the original, and when the owner answers their own message; the sender leaves Cc too — intro tests RED→GREEN.
Final: fixed Shift+Enter taking a template from the `;` list — RED→GREEN; Russian plural forms of "recipients" and "files"; a failed template_apply shown as its own line.
Final: minor (deferred): an owner's replacement whose left side has digits or punctuation (b4, 2moro) is accepted and never applies.
Final: minor (deferred): {first_name} takes the first word of a display name, so "Иванов Иван" greets by surname, "Smith, John" gives no name, McDonald becomes Mcdonald.
Final: minor (deferred): Mod+Z after a fix undoes the letters typed in the same half second with it (Backspace is the exact undo).
Final: minor (deferred): attribution lines in French and German, and Gmail's Russian date form without ">" quotes, do not end the owner's text for phrases.
Final: minor (deferred): the spec's "composer's menu" entry for Move sender to Bcc does not exist (the offer line and the key do); Ctrl+Shift+I may be taken by developer tools on Windows and Linux.
Final: minor (deferred): applying the same template twice attaches its files twice; a failure in the middle of applying leaves the files already attached unseen until the draft is reopened.
Final: minor (deferred): the settings form's own failure texts ("Could not save the template.") are shown in English, as the older ones there are.
2026-11-20 (taken over from thread thr_nu8v4cxa5z): deferred minors fixed with tests — an owner's replacement with digits or signs on its left side applies (b4, w/, 2moro); {first_name} reads 'Smith, John' and a Russian surname written first, and keeps a name's own capitals (McKenzie); a template applied twice does not attach its files twice; the template form's own failure texts are translated. Still deferred: Mod+Z after a fix; French and German attribution lines for phrases; a menu entry for Move sender to Bcc; a failure in the middle of applying a template; the eight plugin-access minors.
