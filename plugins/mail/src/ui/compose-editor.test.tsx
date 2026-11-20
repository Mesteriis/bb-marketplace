// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { installTestPluginRuntime } from "@get-bb/plugin-sdk/testing/app";
import type { Editor } from "@tiptap/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanEditorHtml, ComposeEditor, fencedPaste, ownerParagraphsOf, ownerRange, replaceOwnerRange, type EditorDoc } from "./compose-editor.tsx";
import { htmlFitsDoc, normalizeDoc, ownerParagraphs, renderDoc } from "../core/compose-doc.ts";

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
  const imports: EditorDoc[] = [];
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
      onImported={(doc) => imports.push(doc)}
      onLinkShortcut={() => undefined}
      {...props}
    />,
  );
  return { view, docs, imports, files, editor: () => editor! };
}

describe("ComposeEditor: a drafted reply the owner chose to use", () => {
  it("goes in with the quote as one load: saved once, the quote kept after it", () => {
    const { docs, imports } = mount({
      initialDoc: { type: "doc", content: [{ type: "paragraph" }, { type: "paragraph", content: [{ type: "text", text: "Ada wrote:" }] }] },
      importFrom: { html: "<p>Made-up original</p>", into: "quote" },
      initialOwn: ["Hello Ada,", "Tuesday works."],
    });
    expect(imports).toHaveLength(1);
    expect(docs).toEqual([]);
    expect(ownerParagraphs(normalizeDoc(imports[0]! as never)).paragraphs).toEqual(["Hello Ada,", "Tuesday works."]);
    // The attribution line stays between the text and the quote.
    const top = (imports[0]!.content ?? []).map((node) => (node.type === "paragraph" ? (node.content ?? []).map((n) => n.text ?? "").join("") : node.type));
    expect(top.slice(0, 4)).toEqual(["Hello Ada,", "Tuesday works.", "Ada wrote:", "blockquote"]);
  });

  it("without a quote it is an edit, so the composer saves it", () => {
    const { docs, imports } = mount({ initialOwn: ["Hello Ada,"] });
    expect(imports).toEqual([]);
    expect(docs.length).toBeGreaterThan(0);
    expect(ownerParagraphs(normalizeDoc(docs.at(-1)! as never)).paragraphs).toEqual(["Hello Ada,"]);
  });
});

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
    const { view, imports, editor } = mount({
      initialDoc: { type: "doc", content: [{ type: "paragraph" }, { type: "paragraph", content: [{ type: "text", text: "Ada wrote:" }] }] },
      importFrom: { html: HOSTILE, into: "quote" },
    });
    const doc = imports.at(-1)!;
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

  it("imports a continued draft's HTML as the body, once, and not as an edit", () => {
    const { docs, imports, editor, view } = mount({ importFrom: { html: "<p>Draft <i>body</i></p>", into: "body" } });
    expect(editor().getText()).toBe("Draft body");
    expect(docs).toEqual([]);
    expect(imports).toHaveLength(1);
    expect(imports[0]).toEqual(editor().getJSON());
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

  it("keeps only the server's schema: no headings, strike or rules; code blocks and inline code stay (slice 3g)", () => {
    const { editor } = mount();
    act(() => {
      editor().view.pasteHTML("<h1>Title</h1><pre><code>x()</code></pre><p><s>gone</s> <u>under</u> <code>c</code></p><hr>");
    });
    const { types } = typesAndHrefs(editor().getJSON());
    for (const banned of ["heading", "horizontalRule", "mark:strike"]) {
      expect(types.has(banned)).toBe(false);
    }
    expect(types.has("mark:underline")).toBe(true);
    expect(types.has("codeBlock")).toBe(true);
    expect(types.has("mark:code")).toBe(true);
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

describe("ComposeEditor: the signature block (slice 3d)", () => {
  const p = (text: string) => ({ type: "paragraph", content: [{ type: "text", text }] });
  const SIG = { type: "signature", content: [p("Made-up Name"), p("Example Ltd")] };
  const topTypes = (doc: EditorDoc) => (doc.content ?? []).map((node) => node.type);

  it("keeps a signature with its paragraphs through getJSON, and an empty one too", () => {
    const { editor } = mount({ initialDoc: { type: "doc", content: [{ type: "paragraph" }, SIG] } });
    expect(editor().getJSON()).toEqual({ type: "doc", content: [{ type: "paragraph" }, SIG] });
    const empty = mount({ initialDoc: { type: "doc", content: [{ type: "paragraph" }, { type: "signature" }] } });
    expect(topTypes(empty.editor().getJSON())).toEqual(["paragraph", "signature"]);
    expect(empty.view.container.querySelector("div.makosh-signature")).not.toBeNull();
  });

  it("renders div.makosh-signature and parses it back", () => {
    const { view, editor } = mount({ initialDoc: { type: "doc", content: [{ type: "paragraph" }, SIG] } });
    expect(view.container.querySelector("div.makosh-signature")?.textContent).toBe("Made-up NameExample Ltd");
    act(() => {
      editor().commands.setContent('<p>Hi</p><div class="makosh-signature"><p>Again</p></div>');
    });
    expect(editor().getJSON().content?.[1]).toEqual({ type: "signature", content: [p("Again")] });
  });

  it("survives select-all and type: the block stays as the empty placeholder after the text", () => {
    const { editor, docs } = mount({ initialDoc: { type: "doc", content: [p("Body"), SIG] } });
    act(() => {
      editor().chain().focus().selectAll().insertContent("New text").run();
    });
    const doc = docs.at(-1)!;
    expect(topTypes(doc)).toEqual(["paragraph", "signature"]);
    expect(doc.content?.[0]).toEqual(p("New text"));
    expect(doc.content?.[1]?.content ?? []).toEqual([]);
  });

  it("cannot sit inside a list or a quote: the schema allows it at the top level only", () => {
    const { editor } = mount();
    const schema = editor().schema;
    const signature = schema.nodes.signature!;
    expect(schema.nodes.listItem!.contentMatch.matchType(signature)).toBeNull();
    expect(schema.nodes.blockquote!.contentMatch.matchType(signature)).toBeNull();
    expect(schema.nodes.doc!.contentMatch.matchType(signature)).not.toBeNull();
    act(() => {
      editor().commands.setContent('<blockquote><div class="makosh-signature"><p>Inside</p></div></blockquote>');
    });
    // Parsing lifts it out of the quote; nothing nests it.
    const doc = editor().getJSON();
    const quote = doc.content?.find((node) => node.type === "blockquote");
    expect(JSON.stringify(quote)).not.toContain('"signature"');
    expect(topTypes(doc)).toContain("signature");
  });

  it("pasted HTML with the signature class becomes ordinary paragraphs", () => {
    const { editor } = mount();
    act(() => {
      editor().view.pasteHTML('<div class="makosh-signature"><p>Copied Name</p><p>Copied Ltd</p></div>');
    });
    const doc = editor().getJSON();
    expect(JSON.stringify(doc)).not.toContain('"signature"');
    expect(editor().getText()).toContain("Copied Name");
  });

  it("a reply to own mail drops the quoted signature; foreign mail keeps its text without the class", () => {
    const quoted = '<p>Earlier text</p><div class="makosh-signature"><p>Own Name</p></div>';
    const own = mount({
      initialDoc: { type: "doc", content: [{ type: "paragraph" }, SIG, p("Ada wrote:")] },
      importFrom: { html: quoted, into: "quote", stripSignature: true },
    });
    const ownDoc = own.imports.at(-1)!;
    expect(JSON.stringify(ownDoc)).not.toContain("Own Name");
    expect(JSON.stringify(ownDoc)).toContain("Earlier text");
    expect(topTypes(ownDoc).filter((t) => t === "signature")).toHaveLength(1);
    cleanup();

    const foreign = mount({
      initialDoc: { type: "doc", content: [{ type: "paragraph" }, SIG, p("Ada wrote:")] },
      importFrom: { html: quoted, into: "quote", stripSignature: false },
    });
    const foreignDoc = foreign.imports.at(-1)!;
    expect(JSON.stringify(foreignDoc)).toContain("Own Name");
    // Only the draft's own block is a signature; the quoted one is plain quoted text.
    expect(JSON.stringify(foreignDoc).match(/"signature"/g)).toHaveLength(1);
    const quote = foreignDoc.content?.find((node) => node.type === "blockquote");
    expect(JSON.stringify(quote)).toContain("Own Name");
  });

  it("a continued draft's body loses the class too, and no placeholder is forced in", () => {
    const { editor } = mount({
      initialDoc: { type: "doc", content: [{ type: "paragraph" }, { type: "signature" }] },
      importFrom: { html: '<p>Draft</p><div class="makosh-signature"><p>Theirs</p></div>', into: "body" },
    });
    expect(topTypes(editor().getJSON())).toEqual(["paragraph", "paragraph"]);
  });

  it("the template and signature editors have no signature node", () => {
    const { editor } = mount({ features: { signature: false } });
    expect(editor().schema.nodes.signature).toBeUndefined();
  });
});


describe("ComposeEditor: the owner's range for Improve (slice 3f)", () => {
  const text = (value: string, marks?: { type: string; attrs?: Record<string, unknown> }[]) =>
    marks === undefined ? { type: "text", text: value } : { type: "text", text: value, marks };
  const p = (...content: EditorDoc[]) => (content.length === 0 ? { type: "paragraph" } : { type: "paragraph", content });
  const br = { type: "hardBreak" };
  const QUOTE = { type: "blockquote", content: [p(text("Made-up original"))] };
  const SIG = { type: "signature", content: [p(text("Made-up Name"))] };
  const DOC: EditorDoc = {
    type: "doc",
    content: [
      p(text("Hello Ada,")),
      p(text("line one"), br, text("line two")),
      { type: "bulletList", content: [{ type: "listItem", content: [p(text("first"))] }, { type: "listItem", content: [p(text("second"))] }] },
      p(),
      p(text("See "), text("the page", [{ type: "link", attrs: { href: "https://example.org/page" } }])),
      QUOTE,
      p(text("after the quote")),
      SIG,
    ],
  };

  it("stops at the first quote or signature, joins hard breaks and list items, notes marks", () => {
    expect(ownerParagraphsOf(DOC)).toEqual({
      paragraphs: ["Hello Ada,", "line one\nline two", "first\nsecond", "", "See the page"],
      hasMarks: true,
    });
    expect(ownerParagraphsOf({ type: "doc", content: [p(text("plain")), SIG] })).toEqual({ paragraphs: ["plain"], hasMarks: false });
  });

  it("matches the server's ownerParagraphs over the saved draft", () => {
    const docs: EditorDoc[] = [
      DOC,
      { type: "doc", content: [p(text("tab\there\u0007")), SIG] },
      { type: "doc", content: [QUOTE, p(text("x"))] },
      { type: "doc", content: [{ type: "orderedList", content: [{ type: "listItem", content: [p(text("a")), p(text("b"))] }] }] },
      { type: "doc", content: [p(text("see")), { type: "codeBlock", attrs: { language: "ts" }, content: [{ type: "text", text: "a();\n  b();" }] }, QUOTE] },
    ];
    for (const doc of docs) {
      const server = ownerParagraphs(normalizeDoc(doc as never));
      const page = ownerParagraphsOf(doc);
      expect(page.paragraphs).toEqual(server.paragraphs);
      expect(page.hasMarks).toBe(server.marks);
    }
  });

  it("ownerRange of the real editor stops at the quote", () => {
    const { editor } = mount({ initialDoc: DOC });
    const range = ownerRange(editor());
    expect(range.paragraphs).toEqual(["Hello Ada,", "line one\nline two", "first\nsecond", "", "See the page"]);
    expect(range.hasMarks).toBe(true);
    expect(editor().state.doc.nodeAt(range.to)?.type.name).toBe("blockquote");
  });

  it("replaces the range in one Undo step; quote and signature stay byte-identical", () => {
    const { editor } = mount({ initialDoc: DOC });
    const before = editor().getJSON();
    const tail = JSON.stringify(before.content!.slice(5));
    act(() => replaceOwnerRange(editor(), ["Hi Ada,", "one\ntwo", "three"]));
    const after = editor().getJSON();
    expect(after.content!.slice(0, 3)).toEqual([p(text("Hi Ada,")), p(text("one"), br, text("two")), p(text("three"))]);
    expect(JSON.stringify(after.content!.slice(3))).toBe(tail);
    expect(JSON.stringify(after)).not.toContain("example.org/page");
    act(() => {
      editor().commands.undo();
    });
    expect(editor().getJSON()).toEqual(before);
  });

  it("fewer paragraphs, and a draft without a quote", () => {
    const { editor } = mount({ initialDoc: { type: "doc", content: [p(text("a")), p(text("b")), p(text("c")), SIG] } });
    act(() => replaceOwnerRange(editor(), ["only"]));
    expect(editor().getJSON().content).toEqual([p(text("only")), SIG]);
    const plain = mount({ initialDoc: { type: "doc", content: [p(text("a")), p(text("b"))] } });
    act(() => replaceOwnerRange(plain.editor(), ["x", "y", "z"]));
    expect(ownerRange(plain.editor()).paragraphs).toEqual(["x", "y", "z"]);
  });
});

describe("ComposeEditor: code blocks (slice 3g)", () => {
  const CODE_DOC: EditorDoc = {
    type: "doc",
    content: [
      { type: "paragraph", content: [{ type: "text", text: "Try " }, { type: "text", text: "run()", marks: [{ type: "code" }] }] },
      { type: "codeBlock", attrs: { language: "ts" }, content: [{ type: "text", text: "const a = 1;\n\tif (a) b();" }] },
    ],
  };

  it("round-trips a code block through the server's HTML and back into the editor", () => {
    const html = renderDoc(normalizeDoc(CODE_DOC as never)).html;
    expect(html).toContain('<pre><code class="language-ts">');
    expect(htmlFitsDoc(html)).toBe(true);
    const { editor, imports } = mount({ importFrom: { html, into: "body" } });
    const doc = imports.at(-1) ?? editor().getJSON();
    const block = (doc.content ?? []).find((node) => node.type === "codeBlock");
    expect(block?.attrs?.language).toBe("ts");
    expect((block?.content?.[0] as { text?: string } | undefined)?.text).toBe("const a = 1;\n\tif (a) b();");
    expect(JSON.stringify(doc)).toContain('"type":"code"');
  });

  it("keeps the plain part's code lines verbatim", () => {
    const { text } = renderDoc(normalizeDoc(CODE_DOC as never));
    expect(text).toContain("const a = 1;\n\tif (a) b();");
    expect(text).toContain("`run()`");
  });

  it("turns pasted text with a fence into a code block, and leaves other text alone", () => {
    expect(fencedPaste("no fence here")).toBeNull();
    expect(fencedPaste("```js\nopen only")).toBeNull();
    expect(fencedPaste("Look:\n```js\nx();\n```\nthanks")).toEqual([
      { type: "paragraph", content: [{ type: "text", text: "Look:" }] },
      { type: "codeBlock", attrs: { language: "js" }, content: [{ type: "text", text: "x();" }] },
      { type: "paragraph", content: [{ type: "text", text: "thanks" }] },
    ]);
    const { editor } = mount();
    const event = new Event("paste", { bubbles: true, cancelable: true }) as ClipboardEvent;
    Object.defineProperty(event, "clipboardData", {
      value: { files: [], items: [], types: ["text/plain"], getData: (type: string) => (type === "text/plain" ? "```\nls -la\n```" : "") },
    });
    act(() => {
      editor().view.dom.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);
    const block = (editor().getJSON().content ?? []).find((node) => node.type === "codeBlock");
    expect((block?.content?.[0] as { text?: string } | undefined)?.text).toBe("ls -la");
  });

  it("``` and Enter on an empty line starts a code block with the language", () => {
    const { editor } = mount();
    act(() => {
      editor().commands.insertContent("```py");
    });
    act(() => {
      editor().view.dom.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    });
    const first = editor().getJSON().content?.[0];
    expect(first?.type).toBe("codeBlock");
    expect(first?.attrs?.language).toBe("py");
    expect(first?.content).toBeUndefined();
  });

  it("the signature editor has no code", () => {
    const { editor } = mount({ features: { lists: false, quotes: false, code: false, signature: false } });
    expect(editor().schema.nodes.codeBlock).toBeUndefined();
    expect(editor().schema.marks.code).toBeUndefined();
  });
});
