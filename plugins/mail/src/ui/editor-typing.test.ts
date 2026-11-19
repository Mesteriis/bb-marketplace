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
