// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { installTestPluginRuntime } from "@get-bb/plugin-sdk/testing/app";
import type { Editor } from "@tiptap/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanEditorHtml, ComposeEditor, type EditorDoc } from "./compose-editor.tsx";

installTestPluginRuntime();
// jsdom has no ClipboardEvent; EditorView.pasteHTML builds one.
if (typeof globalThis.ClipboardEvent === "undefined") {
  (globalThis as { ClipboardEvent?: unknown }).ClipboardEvent = class extends Event {
    clipboardData = null;
  };
}
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** Every trick quoted mail could carry; all hosts are made up. */
const HOSTILE = [
  "<script>window.hacked = 1</script>",
  '<p onclick="window.hacked = 2" onerror="x">Hello <b>there</b></p>',
  '<img src="https://tracker.example.com/p.gif" alt="pixel">',
  '<img src="data:image/png;base64,iVBORw0KGgo=">',
  '<img src="cid:logo@example.com">',
  '<img srcset="https://tracker.example.com/a.png 2x">',
  "<style>p { background: url(https://tracker.example.com/s.png) }</style>",
  '<a href="javascript:alert(1)">bad link</a>',
  '<a href="https://example.org/page">good link</a>',
  '<svg><image href="https://tracker.example.com/i.png"></image></svg>',
  '<form action="https://evil.example.com/post"><input name="q"></form>',
  '<base href="https://evil.example.com/">',
  '<picture><source srcset="https://tracker.example.com/w.webp"></picture>',
  '<div style="background-image: url(https://tracker.example.com/b.png)">styled text</div>',
  '<link rel="stylesheet" href="https://evil.example.com/x.css">',
  '<iframe src="https://evil.example.com/frame"></iframe>',
].join("");

function walk(node: EditorDoc, visit: (node: EditorDoc) => void) {
  visit(node);
  for (const child of node.content ?? []) walk(child, visit);
}

function typesAndHrefs(doc: EditorDoc) {
  const types = new Set<string>();
  const hrefs: string[] = [];
  walk(doc, (node) => {
    types.add(node.type ?? "");
    for (const mark of node.marks ?? []) {
      types.add(`mark:${mark.type}`);
      if (mark.type === "link") hrefs.push(String(mark.attrs?.href));
    }
  });
  return { types, hrefs, text: JSON.stringify(doc) };
}

function mount(props: Partial<Parameters<typeof ComposeEditor>[0]> = {}) {
  let editor: Editor | null = null;
  const docs: EditorDoc[] = [];
  const files: File[][] = [];
  const view = render(
    <ComposeEditor
      label="Message"
      initialDoc={{ type: "doc", content: [{ type: "paragraph" }] }}
      importFrom={null}
      onChange={(doc) => docs.push(doc)}
      onFiles={(f) => files.push(f)}
      onReady={(e) => {
        editor = e;
      }}
      onLinkShortcut={() => undefined}
      {...props}
    />,
  );
  return { view, docs, files, editor: () => editor! };
}

describe("cleanEditorHtml", () => {
  it("keeps text and safe links, and drops scripts, styles, images and remote loads", () => {
    const clean = cleanEditorHtml(HOSTILE);
    expect(clean).toContain("Hello");
    expect(clean).toContain("good link");
    expect(clean).toContain("https://example.org/page");
    for (const banned of ["<script", "<img", "<style", "<svg", "<form", "<base", "<link", "<iframe", "<picture", "javascript:", "srcset", "url(", "onclick", "onerror", "tracker.example.com", "evil.example.com"]) {
      expect(clean.toLowerCase()).not.toContain(banned);
    }
  });
});

describe("ComposeEditor", () => {
  it("imports quoted hostile HTML as a blockquote with no image, script, style or javascript: link, and loads nothing", () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { view, docs, editor } = mount({
      initialDoc: { type: "doc", content: [{ type: "paragraph" }, { type: "paragraph", content: [{ type: "text", text: "Ada wrote:" }] }] },
      importFrom: { html: HOSTILE, into: "quote" },
    });
    const doc = docs.at(-1)!;
    const { types, hrefs, text } = typesAndHrefs(doc);
    expect(types.has("blockquote")).toBe(true);
    expect([...types].some((t) => /image|img/i.test(t))).toBe(false);
    expect(hrefs).toEqual(["https://example.org/page"]);
    expect(text).not.toContain("hacked");
    expect(text).not.toContain("javascript:");
    expect(text).not.toContain("tracker.example.com");
    // The quote follows the header line; the editor keeps a paragraph after it to type in.
    const top = (doc.content ?? []).map((node) => node.type);
    expect(top.indexOf("blockquote")).toBeGreaterThan(1);
    expect(view.container.querySelector("img, script, style, iframe, svg")).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(editor().getJSON()).toEqual(doc);
    vi.unstubAllGlobals();
  });

  it("imports a continued draft's HTML as the body, once", () => {
    const { docs, editor, view } = mount({ importFrom: { html: "<p>Draft <i>body</i></p>", into: "body" } });
    expect(editor().getText()).toBe("Draft body");
    const count = docs.length;
    view.rerender(
      <ComposeEditor
        label="Message"
        initialDoc={{ type: "doc", content: [{ type: "paragraph" }] }}
        importFrom={{ html: "<p>Draft <i>body</i></p>", into: "body" }}
        onChange={(doc) => docs.push(doc)}
        onFiles={() => undefined}
        onReady={() => undefined}
        onLinkShortcut={() => undefined}
      />,
    );
    expect(docs.length).toBe(count);
    expect(editor().getText()).toBe("Draft body");
  });

  it("cleans pasted HTML before the schema sees it", () => {
    const { editor } = mount();
    act(() => {
      editor().view.pasteHTML(HOSTILE);
    });
    const { types, hrefs, text } = typesAndHrefs(editor().getJSON());
    expect([...types].some((t) => /image|img/i.test(t))).toBe(false);
    expect(hrefs.every((href) => /^https?:|^mailto:/.test(href))).toBe(true);
    expect(text).not.toContain("javascript:");
    expect(text).not.toContain("hacked");
  });

  it("keeps only the server's schema: no headings, code, strike or rules", () => {
    const { editor } = mount();
    act(() => {
      editor().view.pasteHTML("<h1>Title</h1><pre><code>x()</code></pre><p><s>gone</s> <u>under</u> <code>c</code></p><hr>");
    });
    const { types } = typesAndHrefs(editor().getJSON());
    for (const banned of ["heading", "codeBlock", "horizontalRule", "mark:strike", "mark:code"]) {
      expect(types.has(banned)).toBe(false);
    }
    expect(types.has("mark:underline")).toBe(true);
  });

  it("hands a pasted image file to onFiles instead of the document", () => {
    const { editor, files } = mount();
    const image = new File([new Uint8Array([137, 80, 78, 71])], "shot.png", { type: "image/png" });
    const event = new Event("paste", { bubbles: true, cancelable: true }) as ClipboardEvent;
    Object.defineProperty(event, "clipboardData", {
      value: { files: [image], items: [], types: ["Files"], getData: () => "" },
    });
    act(() => {
      editor().view.dom.dispatchEvent(event);
    });
    expect(files).toEqual([[image]]);
    expect(event.defaultPrevented).toBe(true);
    expect(JSON.stringify(editor().getJSON())).not.toContain("shot.png");
  });

  it("emits document JSON on every change", () => {
    const { editor, docs } = mount();
    act(() => {
      editor().commands.insertContent("Hi");
    });
    expect(docs.at(-1)).toEqual({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Hi" }] }] });
  });
});
