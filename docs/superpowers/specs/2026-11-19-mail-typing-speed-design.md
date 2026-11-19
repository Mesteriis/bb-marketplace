# Makosh Mail: typing speed — design

Date: 2026-11-19. Status: approved in advance (the owner, 2026-11-19:
"Завершай все что наметили"; decisions below are the builder's and are
listed in the final report). Second of nine projects that bring Superhuman
Mail's features to Makosh Mail.

## Intent

Writing a reply should take fewer keystrokes. Superhuman does it with five
things: snippets that fill more than the body, autocorrect, autocomplete,
a reply that quotes only what was selected, and a one-key answer to an
introduction. Makosh Mail has templates (a name and a body) and none of the
rest.

## Goals

- **Snippets.** A template can also carry a subject, To/Cc/Bcc and files.
  Inserting it fills what it carries. Typing `;` and a few letters in the
  body picks one without leaving the keyboard. `{first_name}` in a template
  becomes the first recipient's first name.
- **Autocorrect.** Common misspellings, a small `i`, a lower-case sentence
  start and two capitals at a word's start are fixed as the owner types,
  in English and Russian; the owner's own replacements too. Backspace right
  after a fix puts back what was typed.
- **Autocomplete.** The rest of a phrase the owner often writes is offered
  as grey text after the cursor; Tab accepts it. The phrases come from the
  owner's own sent mail and templates, on this computer.
- **Quick quote.** With text selected in a message, Reply quotes only the
  selection.
- **Instant intro.** In a reply to an introduction, one command moves the
  introducer to Bcc and writes the thank-you line.

## Non-goals

- Completion written by AI (project 3) and spelling by a dictionary of a
  whole language: the browser's own spell check stays as it is.
- Team snippets (team features are not done).
- Snippets in the agent's proposals.

## Anti-goals

- A correction the owner cannot undo with one key.
- Anything typed leaving the computer: the phrases are computed locally from
  mail already stored, and are never sent to an AI provider or logged.
- Grey text that steals a key the owner uses: Tab is taken only while a
  suggestion is shown; any other key just keeps typing.
- Text of other people offered as the owner's phrase: quoted lines and
  signatures of others are left out of the phrases.

## Constraints

- `src/core` and `src/ui` import no host code; the editor is TipTap
  (ProseMirror) and stays the only editor.
- Templates are stored as a document (`doc_json`), at most `TEMPLATES_MAX`;
  a draft's attachments are uploaded in chunks and counted against the
  message size limit.
- The composer saves the document only, never HTML.

## Approaches

1. **Extend templates; ProseMirror plugins for the three typing aids;
   phrases computed on the server from Sent mail** (chosen). One concept
   for the owner (a template is a snippet), the typing aids are small pure
   functions in the core with thin editor plugins, and the phrase list is a
   read-only method.
2. A separate "snippets" entity beside templates. Two lists that do the
   same thing.
3. Autocomplete from an AI model. Belongs to project 3, costs a call per
   pause and sends the draft out.

## Design

### Snippets

- A template gains optional `subject` (1–200 characters), `to`, `cc`, `bcc`
  (addresses, at most 20 in all) and files (at most 5, 10 MB together,
  stored with the template in the plugin's database).
- Inserting a template: its body goes in at the cursor; its subject is set
  when the draft's subject is empty; its recipients are added where not
  already present; its files are attached (the draft's size limit applies:
  a file that does not fit is named in a note, the rest is inserted).
- `{first_name}` in the body or the subject is replaced on insert with the
  first name of the first To recipient (the display name's first word, else
  the address's local part up to a dot, capitalized); with no recipient it
  stays as typed and is highlighted by the pre-send check as a placeholder
  left in.
- In the body, `;` at the start of a word opens the template list at the
  cursor; the letters typed after it filter by name; Enter or Tab inserts
  (the `;text` is replaced), Escape or a space with no match closes it and
  leaves the text.
- Mail settings → Templates edits the new fields; the list shows what each
  template carries.

### Autocorrect

- Applies when a word ends (a space, punctuation or Enter), in the body
  only, never inside a code block, a link or an address.
- Rules, in this order: the owner's replacements (exact word, case kept);
  the built-in misspellings (about 150 English, about 60 Russian); `i` →
  `I` in English text; two capitals at a word's start (`THe` → `The`); the
  first letter after a sentence end or at a paragraph's start.
- Backspace as the very next key undoes the fix (and Mod+Z as always).
  A word the owner restored this way is not fixed again in this draft.
- Settings: `autocorrect` (on by default), and the owner's replacements as
  a list of `from → to` pairs (at most 200) in Mail settings → Templates.

### Autocomplete

- The server keeps a list of the owner's phrases: from the owner's own text
  of the newest 2 000 sent messages (quoted lines, the signature and
  forwarded text left out) and from templates. A phrase is a sentence or a
  line start of 3 to 12 words that occurs at least 3 times (templates count
  as 3). At most 500 phrases, the most frequent first. Rebuilt at start and
  after a send, at most once in 10 minutes.
- `phrases_list` returns them to the page; they are never logged, never
  part of an agent's or a plugin's read.
- In the body, when the text from the sentence's start to the cursor is at
  least 2 words and 8 characters and is the beginning of a phrase (case
  ignored), the rest is shown in grey after the cursor. Tab inserts it;
  Escape hides it for this sentence; anything else keeps typing.
- Setting `autocomplete` (on by default).

### Quick quote

- With a selection inside one message's body, Reply, Reply all and their
  keys make a reply whose quote is the selected text only (plain text, up
  to 20 000 characters), under the usual "On … wrote:" line. Without a
  selection nothing changes.

### Instant intro

- In a reply or reply-all draft with the original's sender in To and at
  least one other recipient, **Move sender to Bcc** (composer's menu, and
  Mod+Shift+I) moves that address from To to Bcc and puts
  "Thank you, {first name}! (Moving you to Bcc.)" as the first line, in the
  page's language. Running it again does nothing.
- When replying to a message from A that has B in To or Cc and whose
  subject or first lines look like an introduction ("intro", "introduc",
  "meet", "знакомьтесь", "знакомлю", "представляю"), the composer offers
  the command in a quiet line above the body. The line is an offer; nothing
  moves by itself.

### Methods and data

- Migration: `templates` gains `subject`, `to_json`, `cc_json`, `bcc_json`;
  a table `template_files` (template id, name, type, size, bytes).
- `templates_list` returns the new fields and each file's name, type and
  size; `template_save` takes them (files by upload id);
  `template_file_begin/chunk/finish/remove` mirror the draft's upload;
  `template_apply { draftId, templateId }` attaches the template's files to
  the draft and returns what did not fit.
- `compose_prepare` takes `quote?: string`.
- `phrases_list {}` → `{ phrases: string[] }`.
- Settings `autocorrect`, `autocomplete` (booleans) and
  `autocorrectPairs` (text, one `from => to` per line).

### Code structure

- `src/core/autocorrect.ts` — the rules as pure functions and the word
  lists; `src/core/phrases.ts` — phrases from texts, and the match;
  `src/core/snippets.ts` — variables, what a template carries;
  `src/core/intro.ts` — the introduction check and the thank-you line.
- `src/ui/editor-typing.ts` — the ProseMirror plugins (autocorrect, grey
  text, the `;` trigger) over those functions.
- The store: the migration, template files, the sent texts for phrases.

## Verification

- `npm run check`, `npm run build`, manifests.
- Pure rules by table tests with explicit expected text; the plugins in the
  editor's jsdom tests; server tests for apply, quote and phrases.
- In a browser at 480, 768 and 1280 px: the `;` list, grey text, the
  template form with files, the intro offer.

## Open, with the default taken

- Autocorrect and autocomplete are on by default.
- The trigger is `;` as in Superhuman.
- Phrases come from Sent mail of every account together.
- Files of a template live in the database (10 MB a template, 5 files).

## Left to the builder

- The word lists.
- How the owner's own text is cut from a sent message.
- The look of the grey text and of the offer line within BB's tokens.
