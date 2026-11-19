// The composer's typing aids as ProseMirror plugins inside the TipTap editor:
// autocorrect when a word ends (Backspace right after puts back what was
// typed). The rules live in src/core; this file only reads the text around
// the cursor and applies what they return.
import { Extension } from "@tiptap/react";
import { Plugin, PluginKey, type EditorState } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import { correctWord, type Correction } from "../core/autocorrect.ts";

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

/** The typing aids as one editor extension; `options` is read on every key. */
export function typingExtension(options: () => TypingOptions) {
  return Extension.create({
    name: "makoshTyping",
    // Before the editor's own keys, so Backspace can undo a fix.
    priority: 1000,
    addProseMirrorPlugins() {
      return [autocorrectPlugin(options)];
    },
  });
}
