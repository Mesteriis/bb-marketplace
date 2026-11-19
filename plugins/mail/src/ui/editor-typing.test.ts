// @vitest-environment jsdom
import { Editor } from "@tiptap/react";
import { afterEach, describe, expect, it } from "vitest";
import { composeExtensions } from "./compose-editor.tsx";
import { typingExtension, type TypingOptions } from "./editor-typing.ts";

const editors: Editor[] = [];
afterEach(() => {
  for (const editor of editors.splice(0)) editor.destroy();
});

function make(options: Partial<TypingOptions> = {}, content: unknown = { type: "doc", content: [{ type: "paragraph" }] }) {
  const current: TypingOptions = { autocorrect: true, pairs: [], autocomplete: false, phrases: [], ...options };
  const editor = new Editor({
    element: document.createElement("div"),
    extensions: [...composeExtensions({ signature: false }), typingExtension(() => current)],
    content: content as never,
  });
  editors.push(editor);
  editor.commands.focus("end");
  return { editor, options: current };
}

/** Types as a keyboard does: each character goes through the editor's text-input handlers first. */
function type(editor: Editor, text: string) {
  for (const char of Array.from(text)) {
    const { from, to } = editor.state.selection;
    const handled = editor.view.someProp("handleTextInput", (handle) => handle(editor.view, from, to, char, () => editor.state.tr.insertText(char, from, to)));
    if (handled !== true) editor.view.dispatch(editor.state.tr.insertText(char, from, to));
  }
}

function press(editor: Editor, key: string) {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  const handled = editor.view.someProp("handleKeyDown", (handle) => handle(editor.view, event));
  if (handled !== true && key === "Backspace") {
    const { from } = editor.state.selection;
    editor.view.dispatch(editor.state.tr.delete(from - 1, from));
  }
  return handled === true;
}

const text = (editor: Editor) => editor.getText({ blockSeparator: "\n" });

describe("autocorrect in the editor", () => {
  it("fixes a word when it ends, and the sentence's first letter", () => {
    const { editor } = make();
    type(editor, "teh cat. it recieve, i think");
    expect(text(editor)).toBe("The cat. It receive, I think");
  });

  it("Backspace right after a fix puts back what was typed, and the word is left alone from then on", () => {
    const { editor } = make();
    type(editor, "see teh ");
    expect(text(editor)).toBe("See the ");
    expect(press(editor, "Backspace")).toBe(true);
    expect(text(editor)).toBe("See teh ");
    expect(editor.state.selection.from).toBe(editor.state.doc.content.size - 1);
    // The next Backspace is an ordinary one.
    expect(press(editor, "Backspace")).toBe(false);
    expect(text(editor)).toBe("See teh");
    type(editor, " and teh ");
    expect(text(editor)).toBe("See teh and teh ");
  });

  it("a key in between ends the chance to undo", () => {
    const { editor } = make();
    type(editor, "teh x");
    expect(press(editor, "Backspace")).toBe(false);
    expect(text(editor)).toBe("The ");
  });

  it("uses the owner's replacements", () => {
    const { editor } = make({ pairs: [{ from: "brb", to: "be right back" }] });
    type(editor, "ok, brb.");
    expect(text(editor)).toBe("Ok, be right back.");
  });

  it("changes nothing in a code block, inside a link, in an address or with the setting off", () => {
    const code = make({}, { type: "doc", content: [{ type: "codeBlock", content: [{ type: "text", text: "x" }] }] });
    type(code.editor, " teh ");
    // The editor keeps an empty paragraph after a code block.
    expect(text(code.editor)).toBe("x teh \n");

    const link = make({}, {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "see", marks: [{ type: "link", attrs: { href: "https://example.com" } }] }] }],
    });
    link.editor.commands.focus("end");
    link.editor.view.dispatch(link.editor.state.tr.setStoredMarks(link.editor.state.selection.$from.marks()));
    type(link.editor, "teh");
    const before = text(link.editor);
    type(link.editor, " ");
    expect(text(link.editor)).toBe(`${before} `);

    const address = make();
    type(address.editor, "Write to teh@example.com or see example.com/teh now");
    expect(text(address.editor)).toBe("Write to teh@example.com or see example.com/teh now");

    const off = make({ autocorrect: false });
    type(off.editor, "teh cat ");
    expect(text(off.editor)).toBe("teh cat ");
  });

  it("follows the setting while the editor lives", () => {
    const { editor, options } = make({ autocorrect: false });
    type(editor, "teh ");
    options.autocorrect = true;
    type(editor, "teh ");
    expect(text(editor)).toBe("teh the ");
  });
});

describe("the grey rest of a phrase", () => {
  const phrases = ["Let me know if you have any questions.", "Thanks for the update!"];
  const ghost = (editor: Editor) => editor.view.dom.querySelector("[data-ghost]")?.textContent ?? null;
  const on = { autocorrect: false, autocomplete: true, phrases };

  it("shows after the start of a phrase and Tab writes it", () => {
    const { editor } = make(on);
    type(editor, "Let me");
    expect(ghost(editor)).toBeNull();
    type(editor, " know if");
    expect(ghost(editor)).toBe(" you have any questions.");
    expect(press(editor, "Tab")).toBe(true);
    expect(text(editor)).toBe("Let me know if you have any questions.");
    expect(ghost(editor)).toBeNull();
  });

  it("starts again after a sentence ends", () => {
    const { editor } = make(on);
    type(editor, "Got it. thanks for");
    expect(ghost(editor)).toBe(" the update!");
  });

  it("Escape hides it for this sentence; typing on keeps it hidden, the next sentence offers again", () => {
    const { editor } = make(on);
    type(editor, "Let me know if");
    expect(press(editor, "Escape")).toBe(true);
    expect(ghost(editor)).toBeNull();
    type(editor, " you");
    expect(ghost(editor)).toBeNull();
    type(editor, " can. Thanks for");
    expect(ghost(editor)).toBe(" the update!");
  });

  it("another key just types, and the grey text follows or goes", () => {
    const { editor } = make(on);
    type(editor, "Let me know if y");
    expect(ghost(editor)).toBe("ou have any questions.");
    type(editor, "es");
    expect(ghost(editor)).toBeNull();
    expect(text(editor)).toBe("Let me know if yes");
  });

  it("takes neither Tab nor Escape without grey text, and shows none with the setting off, in code or mid-line", () => {
    const plain = make(on);
    type(plain.editor, "Hello there");
    expect(press(plain.editor, "Tab")).toBe(false);
    expect(press(plain.editor, "Escape")).toBe(false);

    const off = make({ ...on, autocomplete: false });
    type(off.editor, "Let me know if");
    expect(ghost(off.editor)).toBeNull();

    const code = make(on, { type: "doc", content: [{ type: "codeBlock" }] });
    code.editor.commands.focus("start");
    type(code.editor, "Let me know if");
    expect(ghost(code.editor)).toBeNull();

    const mid = make(on);
    type(mid.editor, "Let me know if tail");
    mid.editor.commands.setTextSelection(15);
    expect(ghost(mid.editor)).toBeNull();
  });
});
