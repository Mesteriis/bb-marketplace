import { describe, expect, it } from "vitest";
import {
  composeDocInputSchema,
  docFromLines,
  docLosesContent,
  htmlFitsDoc,
  isDocEmpty,
  normalizeDoc,
  renderDoc,
  type ComposeDoc,
  ownerParagraphs,
} from "./compose-doc.ts";

const text = (value: string, marks?: unknown[]) => (marks ? { type: "text", text: value, marks } : { type: "text", text: value });
const p = (...content: unknown[]) => ({ type: "paragraph", content });
const doc = (...content: unknown[]) => ({ type: "doc", content });

function parse(input: unknown) {
  const result = composeDocInputSchema.safeParse(input);
  if (!result.success) throw new Error("expected the document to parse");
  return result.data;
}

function norm(input: unknown): ComposeDoc {
  return normalizeDoc(parse(input));
}

describe("composeDocInputSchema", () => {
  it("accepts a TipTap document with unknown nodes and attributes", () => {
    expect(
      composeDocInputSchema.safeParse(
        doc({ type: "heading", attrs: { level: 1 }, content: [text("Hi")] }, p(text("x", [{ type: "strike" }]))),
      ).success,
    ).toBe(true);
  });

  it("refuses shapes that are not nodes", () => {
    const parseOk = (input: unknown) => composeDocInputSchema.safeParse(input).success;
    expect(parseOk(null)).toBe(false);
    expect(parseOk("text")).toBe(false);
    expect(parseOk({ content: [] })).toBe(false);
    expect(parseOk(doc({ type: 1 }))).toBe(false);
    expect(parseOk(doc(p({ type: "text", text: 5 })))).toBe(false);
    expect(parseOk(doc(p(text("x", [{ attrs: {} }]))))).toBe(false);
  });

  it("refuses a document deeper than 32 levels without overflowing the stack", () => {
    const nest = (depth: number) => {
      let node: unknown = p(text("x"));
      for (let i = 0; i < depth; i += 1) node = { type: "blockquote", content: [node] };
      return doc(node);
    };
    expect(composeDocInputSchema.safeParse(nest(29)).success).toBe(true);
    expect(composeDocInputSchema.safeParse(nest(40)).success).toBe(false);
    expect(composeDocInputSchema.safeParse(nest(100_000)).success).toBe(false);
    let attrs: unknown = {};
    for (let i = 0; i < 100_000; i += 1) attrs = { a: attrs };
    expect(composeDocInputSchema.safeParse(doc({ type: "paragraph", attrs })).success).toBe(false);
  });

  it("refuses a document over 2 MB of JSON", () => {
    const big = "x".repeat(1024 * 1024);
    expect(composeDocInputSchema.safeParse(doc(p(text(big)))).success).toBe(true);
    expect(composeDocInputSchema.safeParse(doc(p(text(big)), p(text(big)))).success).toBe(false);
    // Counted in UTF-8 bytes: 700k three-byte characters are about 2.1 MB.
    expect(composeDocInputSchema.safeParse(doc(p(text("я".repeat(700_000) + "ж".repeat(400_000))))).success).toBe(false);
  });
});

describe("normalizeDoc", () => {
  it("keeps the allowed nodes and marks as they are", () => {
    const input = doc(
      p(text("Hello "), text("world", [{ type: "bold" }, { type: "italic" }]), { type: "hardBreak" }, text("u", [{ type: "underline" }])),
      { type: "bulletList", content: [{ type: "listItem", content: [p(text("one"))] }] },
      { type: "orderedList", content: [{ type: "listItem", content: [p(text("two"))] }] },
      { type: "blockquote", content: [p(text("quoted"))] },
    );
    expect(norm(input)).toEqual(input);
  });

  it("strips heading, code, image and table nodes and keeps their text", () => {
    const result = norm(
      doc(
        { type: "heading", attrs: { level: 2 }, content: [text("Title")] },
        { type: "codeBlock", content: [text("line one\nline two")] },
        p(text("see "), { type: "image", attrs: { src: "https://tracker.example.net/p.png" } }, text("this", [{ type: "code" }])),
        {
          type: "table",
          content: [
            { type: "tableRow", content: [{ type: "tableCell", content: [p(text("cell"))] }] },
          ],
        },
        { type: "horizontalRule" },
      ),
    );
    expect(result).toEqual(
      doc(
        p(text("Title")),
        p(text("line one"), { type: "hardBreak" }, text("line two")),
        p(text("see "), text("this")),
        p(text("cell")),
      ),
    );
    expect(JSON.stringify(result)).not.toMatch(/image|tracker|table|heading|code|attrs/);
  });

  it("keeps a link's href for http, https and mailto only", () => {
    const link = (href: unknown) => norm(doc(p(text("go", [{ type: "link", attrs: { href, target: "_blank", rel: "x" } }]))));
    expect(link("https://example.org/a?b=1")).toEqual(doc(p(text("go", [{ type: "link", attrs: { href: "https://example.org/a?b=1" } }]))));
    expect(link("http://example.org/")).toEqual(doc(p(text("go", [{ type: "link", attrs: { href: "http://example.org/" } }]))));
    expect(link("mailto:anna@example.org")).toEqual(doc(p(text("go", [{ type: "link", attrs: { href: "mailto:anna@example.org" } }]))));
    for (const bad of ["javascript:alert(1)", " JavaScript:alert(1)", "data:text/html,x", "vbscript:x", "file:///etc/passwd", "/relative", "", 7, "https://exa\nmple.org"]) {
      expect(link(bad)).toEqual(doc(p(text("go"))));
    }
  });

  it("drops unknown marks and duplicate marks", () => {
    expect(norm(doc(p(text("x", [{ type: "strike" }, { type: "bold" }, { type: "bold" }, { type: "textStyle", attrs: { color: "red" } }]))))).toEqual(
      doc(p(text("x", [{ type: "bold" }]))),
    );
  });

  it("repairs structure: stray text, items outside lists, empty containers", () => {
    expect(
      norm(
        doc(
          text("loose"),
          { type: "bulletList", content: [p(text("not an item")), { type: "listItem", content: [] }] },
          { type: "orderedList", content: [] },
          { type: "blockquote", content: [] },
          { type: "listItem", content: [p(text("orphan"))] },
        ),
      ),
    ).toEqual(
      doc(
        p(text("loose")),
        {
          type: "bulletList",
          content: [
            { type: "listItem", content: [p(text("not an item"))] },
            { type: "listItem", content: [{ type: "paragraph" }] },
          ],
        },
        p(text("orphan")),
      ),
    );
  });

  it("removes control characters and empty text, and never returns an empty doc", () => {
    expect(norm(doc(p(text("a\u0000b\u0007c"), text(""))))).toEqual(doc(p(text("abc"))));
    expect(norm(doc())).toEqual(doc({ type: "paragraph" }));
    expect(norm({ type: "paragraph", content: [text("root")] })).toEqual(doc(p(text("root"))));
  });
});

describe("renderDoc", () => {
  it("renders only whitelisted tags inside a fixed skeleton, text escaped", () => {
    const { html } = renderDoc(
      norm(
        doc(
          p(text("<script>alert(1)</script> & \"q\" 'a'"), text("b", [{ type: "bold" }])),
          p(text("link", [{ type: "link", attrs: { href: "https://example.org/?a=1&b=\"2\"" } }, { type: "italic" }])),
          { type: "bulletList", content: [{ type: "listItem", content: [p(text("one"))] }] },
          { type: "orderedList", content: [{ type: "listItem", content: [p(text("two"), { type: "hardBreak" }, text("u", [{ type: "underline" }]))] }] },
          { type: "blockquote", content: [p()] },
        ),
      ),
    );
    expect(html).toBe(
      '<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>' +
        "<p>&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;q&quot; &#39;a&#39;<strong>b</strong></p>" +
        '<p><a href="https://example.org/?a=1&amp;b=%222%22"><em>link</em></a></p>' +
        "<ul><li><p>one</p></li></ul>" +
        "<ol><li><p>two<br><u>u</u></p></li></ol>" +
        "<blockquote><p><br></p></blockquote>" +
        "</body></html>",
    );
    const tags = [...html.matchAll(/<\/?([a-z!]+)/gi)].map((m) => m[1]?.toLowerCase());
    expect(new Set(tags)).toEqual(
      new Set(["!doctype", "html", "head", "meta", "body", "p", "strong", "a", "em", "ul", "li", "ol", "br", "u", "blockquote"]),
    );
    expect(html.replace(/<meta charset="utf-8">/, "").match(/ [a-z-]+=/g)).toEqual([" href="]);
  });

  it("renders the text alternative: links, lists, quotes, blank lines between blocks", () => {
    const { text: plain } = renderDoc(
      norm(
        doc(
          p(text("Hello "), text("there", [{ type: "link", attrs: { href: "https://example.org/x" } }])),
          p(text("https://example.org/same", [{ type: "link", attrs: { href: "https://example.org/same" } }])),
          { type: "bulletList", content: [{ type: "listItem", content: [p(text("one"))] }, { type: "listItem", content: [p(text("two"))] }] },
          { type: "orderedList", content: [{ type: "listItem", content: [p(text("first"))] }, { type: "listItem", content: [p(text("second"), { type: "hardBreak" }, text("more"))] }] },
          { type: "blockquote", content: [p(text("quoted")), p(text("again"))] },
          p(),
          p(text("Bye")),
        ),
      ),
    );
    expect(plain).toBe(
      [
        "Hello there <https://example.org/x>",
        "",
        "https://example.org/same",
        "",
        "- one",
        "- two",
        "",
        "1. first",
        "2. second",
        "   more",
        "",
        "> quoted",
        ">",
        "> again",
        "",
        "",
        "",
        "Bye",
      ].join("\n"),
    );
  });

  it("wraps the text alternative at 76 columns, prefixes included, long words kept whole", () => {
    const words = Array.from({ length: 40 }, (_, i) => `word${i}`).join(" ");
    const long = "x".repeat(90);
    const { text: plain } = renderDoc(
      norm(doc(p(text(words)), { type: "blockquote", content: [p(text(words))] }, p(text(long)))),
    );
    const lines = plain.split("\n");
    for (const line of lines) {
      if (line !== long) expect(line.length).toBeLessThanOrEqual(76);
    }
    expect(lines.filter((line) => line.startsWith("> ")).length).toBeGreaterThan(1);
    expect(lines).toContain(long);
    expect(plain.replace(/\n(> )?/g, " ")).toContain("word38 word39");
  });

  it("renders a mailto link as text <url>", () => {
    expect(
      renderDoc(norm(doc(p(text("Write me", [{ type: "link", attrs: { href: "mailto:anna@example.org" } }]))))).text,
    ).toBe("Write me <mailto:anna@example.org>");
  });
});

describe("docFromLines", () => {
  it("makes one paragraph per line and a blockquote for the quote", () => {
    expect(docFromLines(["", "On 14 Nov 2026 09:05 UTC, anna@example.org wrote:"], ["Hi", "", "Anna"])).toEqual(
      doc(
        { type: "paragraph" },
        p(text("On 14 Nov 2026 09:05 UTC, anna@example.org wrote:")),
        { type: "blockquote", content: [p(text("Hi")), { type: "paragraph" }, p(text("Anna"))] },
      ),
    );
    expect(docFromLines([])).toEqual(doc({ type: "paragraph" }));
  });

  it("keeps markup in lines as text", () => {
    const result = docFromLines(["<b>x</b>"]);
    expect(renderDoc(result).html).toContain("<p>&lt;b&gt;x&lt;/b&gt;</p>");
  });
});

describe("isDocEmpty", () => {
  it("is true when only whitespace and breaks remain", () => {
    expect(isDocEmpty(docFromLines([]))).toBe(true);
    expect(isDocEmpty(norm(doc(p(text("  "), { type: "hardBreak" }), { type: "bulletList", content: [{ type: "listItem", content: [p()] }] })))).toBe(true);
    expect(isDocEmpty(docFromLines(["", "x"]))).toBe(false);
    expect(isDocEmpty(norm(doc({ type: "blockquote", content: [p(text("q"))] })))).toBe(false);
  });
});

describe("htmlFitsDoc", () => {
  it("accepts our own rendered HTML and plain schema markup", () => {
    const doc = normalizeDoc({
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "Hi", marks: [{ type: "bold" }, { type: "link", attrs: { href: "https://example.org/" } }] }] },
        { type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "a" }] }] }] },
        { type: "blockquote", content: [{ type: "paragraph" }] },
      ],
    });
    expect(htmlFitsDoc(renderDoc(doc).html)).toBe(true);
    expect(htmlFitsDoc("<div>Line<br></div><div><i>two</i> <a href=\"mailto:a@example.org\">x</a></div>")).toBe(true);
  });

  it("refuses images, tables, headings, styles and links the editor drops", () => {
    for (const html of [
      '<p>Hi <img src="cid:part1"></p>',
      "<table><tr><td>cell</td></tr></table>",
      "<h1>Title</h1>",
      '<p style="color:red">red</p>',
      "<style>p{color:red}</style><p>x</p>",
      '<p><font color="red">x</font></p>',
      '<p><a href="ftp://example.org/f">file</a></p>',
      "<pre>code</pre>",
      "<s>gone</s>",
    ]) {
      expect(htmlFitsDoc(html), html).toBe(false);
    }
  });
});

describe("docLosesContent", () => {
  it("is false for the schema the server keeps, whatever attributes TipTap adds", () => {
    expect(
      docLosesContent({
        type: "doc",
        content: [
          { type: "orderedList", attrs: { start: 1, type: null }, content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "x", marks: [{ type: "link", attrs: { href: "https://example.org/", target: "_blank", rel: null } }] }] }] }] },
          { type: "paragraph", content: [{ type: "text", text: "y" }, { type: "hardBreak" }] },
        ],
      }),
    ).toBe(false);
  });

  it("is true when normalizeDoc would strip a node, a mark or a link", () => {
    expect(docLosesContent({ type: "doc", content: [{ type: "heading", content: [{ type: "text", text: "x" }] }] })).toBe(true);
    expect(docLosesContent({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "x", marks: [{ type: "strike" }] }] }] })).toBe(true);
    expect(docLosesContent({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "x", marks: [{ type: "link", attrs: { href: "javascript:alert(1)" } }] }] }] })).toBe(true);
    expect(docLosesContent({ type: "doc", content: [{ type: "image", attrs: { src: "cid:x" } }] })).toBe(true);
  });
});

describe("signature block", () => {
  const sig = (...content: unknown[]) => ({ type: "signature", content });

  it("keeps one top-level signature and flattens a second one into paragraphs", () => {
    const result = norm(doc(p(text("Hi")), sig(p(text("Anna"))), sig(p(text("Second")))));
    expect(result.content).toEqual([
      { type: "paragraph", content: [{ type: "text", text: "Hi" }] },
      { type: "signature", content: [{ type: "paragraph", content: [{ type: "text", text: "Anna" }] }] },
      { type: "paragraph", content: [{ type: "text", text: "Second" }] },
    ]);
  });

  it("flattens a signature nested in a quote or a list, keeping its text", () => {
    const result = norm(
      doc(
        { type: "blockquote", content: [sig(p(text("Quoted sig")))] },
        { type: "bulletList", content: [{ type: "listItem", content: [sig(p(text("Listed sig")))] }] },
      ),
    );
    expect(JSON.stringify(result)).not.toContain('"signature"');
    expect(renderDoc(result).text).toContain("> Quoted sig");
    expect(renderDoc(result).text).toContain("- Listed sig");
  });

  it("keeps only paragraphs inside a signature", () => {
    const result = norm(
      doc(
        sig(
          p(text("Anna")),
          { type: "bulletList", content: [{ type: "listItem", content: [p(text("Item"))] }] },
          { type: "blockquote", content: [p(text("Quote"))] },
        ),
      ),
    );
    expect(result.content).toEqual([
      {
        type: "signature",
        content: [
          { type: "paragraph", content: [{ type: "text", text: "Anna" }] },
          { type: "paragraph", content: [{ type: "text", text: "Item" }] },
          { type: "paragraph", content: [{ type: "text", text: "Quote" }] },
        ],
      },
    ]);
  });

  it("keeps an empty signature as the placeholder", () => {
    expect(norm(doc(p(), sig())).content).toEqual([{ type: "paragraph" }, { type: "signature", content: [] }]);
    expect(norm(doc(p(), sig(p()))).content).toEqual([
      { type: "paragraph" },
      { type: "signature", content: [{ type: "paragraph" }] },
    ]);
  });

  it("renders an empty signature as nothing", () => {
    const rendered = renderDoc(norm(doc(p(text("Hello")), sig(p()))));
    expect(rendered.html).not.toContain("makosh-signature");
    expect(rendered.text).toBe("Hello");
  });

  it("writes the -- delimiter when the signature is the last block", () => {
    const rendered = renderDoc(norm(doc(p(text("Hello")), sig(p(text("Anna")), p(text("Example Ltd"))))));
    expect(rendered.html).toContain(
      '<div class="makosh-signature"><p>-- </p><p>Anna</p><p>Example Ltd</p></div>',
    );
    expect(rendered.text).toBe("Hello\n\n-- \nAnna\nExample Ltd");
  });

  it("leaves no blank lines inside the signature text", () => {
    const rendered = renderDoc(norm(doc(p(text("Hello")), sig(p(text("Anna")), p(), p(text("Ltd"))))));
    expect(rendered.text).toBe("Hello\n\n-- \nAnna\nLtd");
  });

  it("writes no -- delimiter when anything follows the signature", () => {
    const rendered = renderDoc(
      norm(
        doc(
          p(text("Thanks")),
          sig(p(text("Anna"))),
          p(text("On Mon, Bob wrote:")),
          { type: "blockquote", content: [p(text("Question"))] },
        ),
      ),
    );
    expect(rendered.html).toContain('<div class="makosh-signature"><p>Anna</p></div>');
    expect(rendered.html).not.toContain("<p>-- </p>");
    expect(rendered.text).toBe("Thanks\n\nAnna\n\nOn Mon, Bob wrote:\n\n> Question");
    expect(rendered.text).not.toContain("-- ");
  });

  it("never takes the class from the page", () => {
    const rendered = renderDoc(
      norm(doc(sig({ type: "paragraph", attrs: { class: "x\" onclick=\"y" }, content: [text("A")] }))),
    );
    expect(rendered.html).toContain('<div class="makosh-signature"><p>-- </p><p>A</p></div>');
    expect(rendered.html).not.toContain("onclick");
  });

  it("isDocEmpty ignores the signature", () => {
    expect(isDocEmpty(norm(doc(p(), sig(p(text("Anna"))))))).toBe(true);
    expect(isDocEmpty(norm(doc(p(text("x")), sig(p(text("Anna"))))))).toBe(false);
  });

  it("docLosesContent keeps a signature", () => {
    expect(docLosesContent(doc(p(text("x")), sig(p(text("Anna")))) as never)).toBe(false);
  });
});

describe("ownerParagraphs (slice 3f)", () => {
  it("takes the text before the quote or signature: hardBreak lines and list items as lines, marks reported", () => {
    const text = (value: string, marks?: { type: "bold" }[]) => ({ type: "text" as const, text: value, ...(marks ? { marks } : {}) });
    const doc = {
      type: "doc" as const,
      content: [
        { type: "paragraph" as const, content: [text("Line one"), { type: "hardBreak" as const }, text("line two")] },
        {
          type: "bulletList" as const,
          content: [
            { type: "listItem" as const, content: [{ type: "paragraph" as const, content: [text("Item a")] }] },
            { type: "listItem" as const, content: [{ type: "paragraph" as const, content: [text("Item b")] }] },
          ],
        },
        { type: "paragraph" as const },
        { type: "blockquote" as const, content: [{ type: "paragraph" as const, content: [text("Quoted")] }] },
        { type: "paragraph" as const, content: [text("After the quote")] },
      ],
    };
    expect(ownerParagraphs(doc)).toEqual({ paragraphs: ["Line one\nline two", "Item a\nItem b", ""], marks: false });
    const marked = { type: "doc" as const, content: [{ type: "paragraph" as const, content: [text("Bold", [{ type: "bold" }])] }] };
    expect(ownerParagraphs(marked)).toEqual({ paragraphs: ["Bold"], marks: true });
  });
});
