// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { installTestPluginRuntime } from "@get-bb/plugin-sdk/testing/app";
import { useState } from "react";
import type { Editor } from "@tiptap/react";
import { afterEach, describe, expect, it } from "vitest";
import { ComposeEditor } from "./compose-editor.tsx";
import { ComposeToolbar, linkHref, modKeyLabel } from "./compose-toolbar.tsx";

installTestPluginRuntime();
afterEach(cleanup);

let editorRef: Editor | null = null;

function Harness() {
  const [editor, setEditor] = useState<Editor | null>(null);
  const [linkOpen, setLinkOpen] = useState(false);
  return (
    <div>
      <ComposeToolbar editor={editor} linkOpen={linkOpen} onLinkOpenChange={setLinkOpen} />
      <ComposeEditor
        label="Message"
        initialDoc={{ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Hello world" }] }] }}
        importFrom={null}
        onChange={() => undefined}
        onFiles={() => undefined}
        onReady={(e) => {
          editorRef = e;
          setEditor(e);
        }}
        onLinkShortcut={() => setLinkOpen(true)}
      />
    </div>
  );
}

function selectWord() {
  act(() => {
    editorRef!.commands.setTextSelection({ from: 1, to: 6 });
  });
}

describe("ComposeToolbar", () => {
  it("is one tab stop with arrow-key focus", () => {
    render(<Harness />);
    const toolbar = screen.getByRole("toolbar", { name: "Formatting" });
    const buttons = Array.from(toolbar.querySelectorAll("button"));
    expect(buttons.map((b) => b.tabIndex).filter((t) => t === 0)).toHaveLength(1);
    expect(buttons[0]!.tabIndex).toBe(0);

    buttons[0]!.focus();
    fireEvent.keyDown(toolbar, { key: "ArrowRight" });
    expect(document.activeElement).toBe(buttons[1]);
    expect(buttons[1]!.tabIndex).toBe(0);
    expect(buttons[0]!.tabIndex).toBe(-1);
    fireEvent.keyDown(toolbar, { key: "End" });
    expect(document.activeElement).toBe(buttons.at(-1));
    fireEvent.keyDown(toolbar, { key: "ArrowRight" });
    expect(document.activeElement).toBe(buttons[0]);
    fireEvent.keyDown(toolbar, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(buttons.at(-1));
    fireEvent.keyDown(toolbar, { key: "Home" });
    expect(document.activeElement).toBe(buttons[0]);
  });

  it("labels every tool and names the shortcut keys", () => {
    render(<Harness />);
    const mod = modKeyLabel();
    for (const name of [`Bold (${mod}B)`, `Italic (${mod}I)`, `Underline (${mod}U)`, `Link (${mod}K)`, "Bulleted list", "Numbered list", "Quote", "Clear formatting"]) {
      expect(screen.getByRole("button", { name })).toBeTruthy();
    }
    expect(modKeyLabel("MacIntel")).toBe("⌘");
    expect(modKeyLabel("Win32")).toBe("Ctrl+");
  });

  it("toggles marks and blocks on the selection, and shows them pressed", () => {
    render(<Harness />);
    selectWord();
    const bold = screen.getByRole("button", { name: /^Bold/ });
    fireEvent.click(bold);
    expect(editorRef!.isActive("bold")).toBe(true);
    expect(bold.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: /^Italic/ }));
    fireEvent.click(screen.getByRole("button", { name: /^Underline/ }));
    expect(editorRef!.isActive("italic") && editorRef!.isActive("underline")).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Bulleted list" }));
    expect(editorRef!.isActive("bulletList")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Numbered list" }));
    expect(editorRef!.isActive("orderedList")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Numbered list" }));
    expect(editorRef!.isActive("orderedList")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Quote" }));
    expect(editorRef!.isActive("blockquote")).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Clear formatting" }));
    expect(editorRef!.isActive("bold")).toBe(false);
    expect(editorRef!.isActive("blockquote")).toBe(false);
  });

  it("adds a link through the link field, keeping only web and mail addresses", () => {
    render(<Harness />);
    selectWord();
    fireEvent.click(screen.getByRole("button", { name: /^Link/ }));
    const field = screen.getByLabelText("Link address");
    fireEvent.change(field, { target: { value: "javascript:alert(1)" } });
    fireEvent.submit(field.closest("form")!);
    expect(screen.getByRole("alert").textContent).toMatch(/web address/);
    expect(editorRef!.isActive("link")).toBe(false);

    fireEvent.change(field, { target: { value: "example.org/page" } });
    fireEvent.submit(field.closest("form")!);
    expect(editorRef!.getAttributes("link").href).toBe("https://example.org/page");
    expect(screen.queryByLabelText("Link address")).toBeNull();
  });
});

describe("linkHref", () => {
  it("keeps http, https and mailto, completes bare hosts and addresses, refuses the rest", () => {
    expect(linkHref("https://example.org")).toBe("https://example.org");
    expect(linkHref("http://example.org/a")).toBe("http://example.org/a");
    expect(linkHref("example.org")).toBe("https://example.org");
    expect(linkHref("ada@example.org")).toBe("mailto:ada@example.org");
    expect(linkHref("mailto:ada@example.org")).toBe("mailto:ada@example.org");
    expect(linkHref("javascript:alert(1)")).toBeNull();
    expect(linkHref("data:text/html,x")).toBeNull();
    expect(linkHref("file:///etc/passwd")).toBeNull();
    expect(linkHref("has space.org")).toBeNull();
    expect(linkHref("")).toBeNull();
  });
});

describe("ComposeToolbar: Improve (slice 3f)", () => {
  it("shows Improve only when offered, off with the reason", () => {
    const { rerender } = render(<ComposeToolbar editor={null} linkOpen={false} onLinkOpenChange={() => undefined} />);
    expect(screen.queryByRole("button", { name: /Improve/ })).toBeNull();
    rerender(
      <ComposeToolbar
        editor={null}
        linkOpen={false}
        onLinkOpenChange={() => undefined}
        onImprove={() => undefined}
        improveDisabledReason="AI features need the Makosh AI plugin"
      />,
    );
    const off = screen.getByRole("button", { name: /Improve/ }) as HTMLButtonElement;
    expect(off.disabled).toBe(true);
    expect(off.closest("span")?.getAttribute("title")).toBe("AI features need the Makosh AI plugin");
  });

  it("Improve with an editor toggles its menu", () => {
    let opened = 0;
    function WithImprove() {
      const [editor, setEditor] = useState<Editor | null>(null);
      return (
        <div>
          <ComposeToolbar editor={editor} linkOpen={false} onLinkOpenChange={() => undefined} onImprove={() => opened++} improveOpen />
          <ComposeEditor
            label="Message"
            initialDoc={{ type: "doc", content: [{ type: "paragraph" }] }}
            importFrom={null}
            onChange={() => undefined}
            onFiles={() => undefined}
            onReady={setEditor}
            onLinkShortcut={() => undefined}
          />
        </div>
      );
    }
    render(<WithImprove />);
    const button = screen.getByRole("button", { name: /Improve/ });
    expect(button.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(button);
    expect(opened).toBe(1);
  });
});
