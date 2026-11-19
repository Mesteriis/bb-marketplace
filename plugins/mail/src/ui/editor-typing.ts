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
/** A whole word of letters, with apostrophes inside. */
const WORD = /^[\p{L}][\p{L}'’]*$/u;

/** The word that ends at the cursor, when autocorrect may touch it. */
function wordBefore(state: EditorState, pos: number): { start: number; word: string; sentenceStart: boolean } | null {
  const $pos = state.doc.resolve(pos);
  const parent = $pos.parent;
  if (!parent.isTextblock || parent.type.spec.code === true) return null;
  if ($pos.marks().some((mark) => mark.type.name === "link" || mark.type.name === "code")) return null;
  // Inline nodes count as one character, so offsets in this text are offsets in the block.
  const before = parent.textBetween(0, $pos.parentOffset, undefined, "￼");
  const token = /\S+$/u.exec(before)?.[0] ?? "";
  if (token === "") return null;
  // A leading bracket or quote is not part of the word; anything else odd (an address, a path) is left alone.
  const word = token.replace(/^[("'\[{«“]+/u, "");
  if (!WORD.test(word)) return null;
  const lead = before.slice(0, before.length - word.length);
  return { start: pos - word.length, word, sentenceStart: SENTENCE_END.test(lead.replace(/[("'\[{«“]+$/u, "")) };
}

function autocorrectPlugin(options: () => TypingOptions): Plugin<CorrectState> {
  const fix = (view: EditorView, pos: number): { start: number; word: string; fixed: string } | null => {
    const current = options();
    if (!current.autocorrect) return null;
    const found = wordBefore(view.state, pos);
    if (found === null) return null;
    const skip = correctKey.getState(view.state)?.skip ?? new Set<string>();
    const fixed = correctWord(found.word, { sentenceStart: found.sentenceStart, pairs: current.pairs, skip });
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
        const found = fix(view, from);
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

/** The typing aids as one editor extension; `options` is read on every key. */
export function typingExtension(options: () => TypingOptions) {
  return Extension.create({
    name: "makoshTyping",
    // Before the editor's own keys, so Backspace can undo a fix.
    priority: 1000,
    addProseMirrorPlugins() {
      return [autocorrectPlugin(options), ghostPlugin(options)];
    },
  });
}
