// The composer's typing aids as ProseMirror plugins inside the TipTap editor:
// autocorrect when a word ends (Backspace right after puts back what was
// typed), and the grey rest of a phrase the owner often writes (Tab takes
// it). The rules live in src/core; this file only reads the text around
// the cursor and applies what they return.
import { Extension } from "@tiptap/react";
import { Plugin, PluginKey, type EditorState } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import { correctWord, type Correction } from "../core/autocorrect.ts";
import { completion } from "../core/phrases.ts";

/** What the composer wants from the typing aids now; read on every key, so a setting applies at once. */
export interface TypingOptions {
  autocorrect: boolean;
  pairs: readonly Correction[];
  autocomplete: boolean;
  phrases: readonly string[];
  /** The templates `;` picks from; absent or empty: `;` is only a character. */
  snippets?: readonly { id: string; name: string }[];
  /** The list `;text` shows now, or null when it closes. */
  onSnippets?: (list: SnippetList | null) => void;
  /** A template was picked; its `;text` is already gone and the cursor is where it was. */
  onPickSnippet?: (id: string) => void;
}

/** What `;text` offers: the templates whose name holds the text, and the one Enter takes. */
export interface SnippetList {
  query: string;
  items: { id: string; name: string }[];
  highlight: number;
}

/** Every aid off. */
export const NO_TYPING: TypingOptions = { autocorrect: false, pairs: [], autocomplete: false, phrases: [] };

/** A fix just made: Backspace at `to` restores `typed` over `from..to`. */
type Undo = { from: number; to: number; typed: string; word: string };
type CorrectState = { undo: Undo | null; skip: ReadonlySet<string> };
type CorrectMeta = { undo: Undo | null; restored?: string };

const correctKey = new PluginKey<CorrectState>("makoshAutocorrect");

/** The characters that end a word. */
const ENDS_WORD = /^[\s.,!?;:)\]}"»”]$/u;
/** A sentence ended before this text (or the block starts here). */
const SENTENCE_END = /(^|[.!?…]["')\]»”]*\s+)$/u;
/** The text ends with an abbreviation and a space: a dotted one (e.g., p.m.) or a common one (etc., vs.). */
const ABBREVIATION = /(^|[\s(])((\p{L}{1,3}\.){2,}|(etc|vs|approx|incl|excl|no|fig|mr|mrs|ms|dr|prof|inc|ltd|co|st|\u0441\u043c|\u0441\u0442\u0440|\u0440\u0443\u0431|\u0442\u044b\u0441|\u043c\u043b\u043d|\u043c\u043b\u0440\u0434|\u0443\u043b|\u0433|\u0438\u043c|\u0433\u0433)\.)\s+$/iu;
/** A whole word of letters, with apostrophes inside. */
const WORD = /^[\p{L}][\p{L}'’]*$/u;

/** The word that ends at the cursor, when autocorrect may touch it. */
function wordBefore(state: EditorState, pos: number, pairs: readonly Correction[] = []): { start: number; word: string; sentenceStart: boolean } | null {
  const $pos = state.doc.resolve(pos);
  const parent = $pos.parent;
  if (!parent.isTextblock || parent.type.spec.code === true) return null;
  if ($pos.marks().some((mark) => mark.type.name === "link" || mark.type.name === "code")) return null;
  // Inline nodes count as one character, so offsets in this text are offsets in the block.
  const before = parent.textBetween(0, $pos.parentOffset, undefined, "￼");
  // A line break (an inline node) starts a word as a space does.
  const token = /[^\s\ufffc]+$/u.exec(before)?.[0] ?? "";
  if (token === "") return null;
  // A leading bracket or quote is not part of the word; anything else odd (an address, a path) is left alone.
  const word = token.replace(/^[("'\[{«“]+/u, "");
  // The owner's own replacement may have digits or signs on its left side (b4, w/): then the whole token is the word.
  const own = pairs.some((pair) => pair.from === word || (pair.from === pair.from.toLocaleLowerCase() && pair.from === word.toLocaleLowerCase()));
  if (!WORD.test(word) && !own) return null;
  const lead = before.slice(0, before.length - word.length).replace(/[("'\[{\u00ab\u201c]+$/u, "");
  // After a line break, as at the block's start; never after an abbreviation (e.g., etc., p.m.).
  const sentenceStart = /\ufffc\s*$/u.test(lead) || (SENTENCE_END.test(lead) && !ABBREVIATION.test(lead));
  return { start: pos - word.length, word, sentenceStart };
}

function autocorrectPlugin(options: () => TypingOptions): Plugin<CorrectState> {
  const fix = (view: EditorView, pos: number, beforeDot = false): { start: number; word: string; fixed: string } | null => {
    const current = options();
    if (!current.autocorrect) return null;
    const found = wordBefore(view.state, pos, current.pairs);
    if (found === null) return null;
    const skip = correctKey.getState(view.state)?.skip ?? new Set<string>();
    const fixed = correctWord(found.word, { sentenceStart: found.sentenceStart && !beforeDot, pairs: current.pairs, skip });
    return fixed === null ? null : { start: found.start, word: found.word, fixed };
  };
  return new Plugin<CorrectState>({
    key: correctKey,
    state: {
      init: () => ({ undo: null, skip: new Set<string>() }),
      apply(tr, value) {
        const meta = tr.getMeta(correctKey) as CorrectMeta | undefined;
        if (meta !== undefined) {
          return { undo: meta.undo, skip: meta.restored === undefined ? value.skip : new Set([...value.skip, meta.restored]) };
        }
        // Anything else typed, deleted or clicked ends the chance to undo.
        return value.undo !== null && (tr.docChanged || tr.selectionSet) ? { ...value, undo: null } : value;
      },
    },
    props: {
      handleTextInput(view, from, to, text) {
        if (from !== to || !ENDS_WORD.test(text)) return false;
        // A dot may go on into a host name or an abbreviation (github.com, e.g.): only a slip is fixed before it, no capital.
        const found = fix(view, from, text === ".");
        if (found === null) return false;
        const inserted = found.fixed + text;
        const tr = view.state.tr.insertText(inserted, found.start, from);
        const meta: CorrectMeta = { undo: { from: found.start, to: found.start + inserted.length, typed: found.word + text, word: found.word } };
        view.dispatch(tr.setMeta(correctKey, meta));
        return true;
      },
      handleKeyDown(view, event) {
        if (event.key === "Enter" && !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey) {
          // The word before a new line is finished too; the key then does its usual work.
          const { from, empty } = view.state.selection;
          const found = empty ? fix(view, from) : null;
          if (found !== null) view.dispatch(view.state.tr.insertText(found.fixed, found.start, from));
          return false;
        }
        if (event.key !== "Backspace" || event.metaKey || event.ctrlKey || event.altKey) return false;
        const undo = correctKey.getState(view.state)?.undo ?? null;
        const { from, empty } = view.state.selection;
        if (undo === null || !empty || from !== undo.to) return false;
        const meta: CorrectMeta = { undo: null, restored: undo.word };
        view.dispatch(view.state.tr.insertText(undo.typed, undo.from, undo.to).setMeta(correctKey, meta));
        return true;
      },
    },
  });
}

/** Escape hid the grey text for the sentence that starts here. */
type GhostState = { hiddenAt: number | null };
const ghostKey = new PluginKey<GhostState>("makoshGhost");

/** The sentence the cursor ends, when grey text may follow it: its start and its text so far. */
function sentenceBefore(state: EditorState): { start: number; text: string } | null {
  const { $from, empty } = state.selection;
  const parent = $from.parent;
  if (!empty || !parent.isTextblock || parent.type.spec.code === true) return null;
  // Only at the end of the block: grey text in the middle of a line would push the rest around.
  if ($from.parentOffset !== parent.content.size) return null;
  if ($from.marks().some((mark) => mark.type.name === "link" || mark.type.name === "code")) return null;
  const before = parent.textBetween(0, $from.parentOffset, undefined, "\ufffc");
  const cut = Math.max(before.lastIndexOf(". "), before.lastIndexOf("! "), before.lastIndexOf("? "), before.lastIndexOf("\u2026 "));
  const text = cut === -1 ? before : before.slice(cut + 2);
  return { start: $from.pos - text.length, text };
}

/** The grey text to show now: the rest of a phrase, and where its sentence starts. */
export function ghostOf(state: EditorState, options: TypingOptions): { rest: string; start: number } | null {
  if (!options.autocomplete || options.phrases.length === 0) return null;
  const sentence = sentenceBefore(state);
  if (sentence === null || ghostKey.getState(state)?.hiddenAt === sentence.start) return null;
  const rest = completion(options.phrases, sentence.text);
  return rest === null ? null : { rest, start: sentence.start };
}

function ghostPlugin(options: () => TypingOptions): Plugin<GhostState> {
  return new Plugin<GhostState>({
    key: ghostKey,
    state: {
      init: () => ({ hiddenAt: null }),
      apply(tr, value) {
        const hide = tr.getMeta(ghostKey) as number | undefined;
        if (hide !== undefined) return { hiddenAt: hide };
        // The mark follows the text; it ends when another sentence is being written.
        return value.hiddenAt !== null && tr.docChanged ? { hiddenAt: tr.mapping.map(value.hiddenAt, -1) } : value;
      },
    },
    props: {
      decorations(state) {
        const ghost = ghostOf(state, options());
        if (ghost === null) return null;
        const widget = Decoration.widget(
          state.selection.from,
          () => {
            const span = document.createElement("span");
            span.dataset.ghost = "";
            span.setAttribute("aria-hidden", "true");
            span.className = "pointer-events-none select-none text-muted-foreground opacity-60";
            span.textContent = ghost.rest;
            return span;
          },
          { side: 1, key: `ghost:${ghost.rest}` },
        );
        return DecorationSet.create(state.doc, [widget]);
      },
      handleKeyDown(view, event) {
        if (event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return false;
        if (event.key !== "Tab" && event.key !== "Escape") return false;
        const ghost = ghostOf(view.state, options());
        // Without grey text the key is not ours: Tab moves the focus, Escape closes what it closes.
        if (ghost === null) return false;
        if (event.key === "Tab") view.dispatch(view.state.tr.insertText(ghost.rest));
        else view.dispatch(view.state.tr.setMeta(ghostKey, ghost.start));
        return true;
      },
    },
  });
}

type SnippetState = { highlight: number; dismissedAt: number | null };
type SnippetMeta = { highlight?: number; dismissedAt?: number | null };
const snippetKey = new PluginKey<SnippetState>("makoshSnippet");
const SNIPPETS_SHOWN = 8;

/** `;text` right before the cursor, with `;` at a word's start. */
function triggerBefore(state: EditorState): { from: number; query: string } | null {
  const { $from, empty } = state.selection;
  const parent = $from.parent;
  if (!empty || !parent.isTextblock || parent.type.spec.code === true) return null;
  if ($from.marks().some((mark) => mark.type.name === "link" || mark.type.name === "code")) return null;
  const before = parent.textBetween(0, $from.parentOffset, undefined, "\ufffc");
  const found = /(?:^|\s);([^\s;]{0,30})$/u.exec(before);
  return found === null ? null : { from: $from.pos - found[1]!.length - 1, query: found[1]! };
}

/** The list `;text` shows now and where the text starts; null when there is nothing to pick. */
export function snippetsOf(state: EditorState, options: TypingOptions): (SnippetList & { from: number }) | null {
  const all = options.snippets ?? [];
  if (all.length === 0) return null;
  const trigger = triggerBefore(state);
  const own = snippetKey.getState(state);
  if (trigger === null || own?.dismissedAt === trigger.from) return null;
  const wanted = trigger.query.toLocaleLowerCase();
  const items = all.filter((item) => item.name.toLocaleLowerCase().includes(wanted)).slice(0, SNIPPETS_SHOWN);
  if (items.length === 0) return null;
  return { from: trigger.from, query: trigger.query, items, highlight: Math.min(own?.highlight ?? 0, items.length - 1) };
}

/** Takes a template from the list: its `;text` goes, then the host inserts it. */
export function takeSnippet(view: EditorView, id: string, options: TypingOptions): void {
  const list = snippetsOf(view.state, options);
  if (list === null) return;
  view.dispatch(view.state.tr.delete(list.from, view.state.selection.from));
  options.onPickSnippet?.(id);
}

function snippetPlugin(options: () => TypingOptions): Plugin<SnippetState> {
  // What the host was last told; a closed list is "null".
  let told = "null";
  return new Plugin<SnippetState>({
    key: snippetKey,
    state: {
      init: () => ({ highlight: 0, dismissedAt: null }),
      apply(tr, value, _old, next) {
        const meta = tr.getMeta(snippetKey) as SnippetMeta | undefined;
        if (meta !== undefined) return { ...value, ...meta };
        if (!tr.docChanged && !tr.selectionSet) return value;
        // Typing narrows the list from its top; a closed list forgets where it was dismissed.
        const trigger = triggerBefore(next);
        return { highlight: 0, dismissedAt: trigger !== null && value.dismissedAt === trigger.from ? value.dismissedAt : null };
      },
    },
    view() {
      return {
        update(view) {
          const current = options();
          const list = snippetsOf(view.state, current);
          const shown = list === null ? null : { query: list.query, items: list.items, highlight: list.highlight };
          const key = JSON.stringify(shown);
          if (key === told) return;
          told = key;
          current.onSnippets?.(shown);
        },
        destroy() {
          if (told !== "null") options().onSnippets?.(null);
        },
      };
    },
    props: {
      handleKeyDown(view, event) {
        // With a modifier the key is someone else's (Shift+Enter is a line break).
        if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return false;
        const current = options();
        const list = snippetsOf(view.state, current);
        if (list === null) return false;
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          const step = event.key === "ArrowDown" ? 1 : -1;
          const meta: SnippetMeta = { highlight: (list.highlight + step + list.items.length) % list.items.length };
          view.dispatch(view.state.tr.setMeta(snippetKey, meta));
          return true;
        }
        if (event.key === "Enter" || event.key === "Tab") {
          takeSnippet(view, list.items[list.highlight]!.id, current);
          return true;
        }
        if (event.key === "Escape") {
          const meta: SnippetMeta = { dismissedAt: list.from };
          view.dispatch(view.state.tr.setMeta(snippetKey, meta));
          return true;
        }
        return false;
      },
    },
  });
}

/** The typing aids as one editor extension; `options` is read on every key. */
export function typingExtension(options: () => TypingOptions) {
  return Extension.create({
    name: "makoshTyping",
    // Before the editor's own keys, so Backspace can undo a fix.
    priority: 1000,
    addProseMirrorPlugins() {
      // The `;` list takes its keys first; then autocorrect (Backspace, Enter), then the grey text (Tab, Escape).
      return [snippetPlugin(options), autocorrectPlugin(options), ghostPlugin(options)];
    },
  });
}
