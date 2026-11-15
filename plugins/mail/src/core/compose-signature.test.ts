import { describe, expect, it } from "vitest";
import { ComposeError } from "./compose.ts";
import { docFromLines, renderDoc, type ComposeDoc, type ComposeParagraph } from "./compose-doc.ts";
import {
  SIGNATURE_MAX_BYTES,
  SIGNATURE_MAX_CHARS,
  normalizeSignature,
  signatureBlock,
  signatureText,
  stripOwnSignature,
  swapSignature,
  withSignature,
  type SignatureDoc,
} from "./compose-signature.ts";

const text = (value: string, marks?: unknown[]) => (marks ? { type: "text", text: value, marks } : { type: "text", text: value });
const p = (...content: unknown[]) => ({ type: "paragraph", content });
const para = (value: string): ComposeParagraph =>
  value === "" ? { type: "paragraph" } : { type: "paragraph", content: [{ type: "text", text: value }] };
const sigDoc = (...lines: string[]): SignatureDoc => ({ type: "doc", content: lines.map(para) });

function refuses(run: () => unknown): void {
  let caught: unknown = null;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ComposeError);
  expect((caught as ComposeError).kind).toBe("invalid");
}

describe("normalizeSignature", () => {
  it("keeps paragraphs and marks, flattening lists and quotes", () => {
    const result = normalizeSignature({
      type: "doc",
      content: [
        p(text("Anna", [{ type: "bold" }])),
        { type: "bulletList", content: [{ type: "listItem", content: [p(text("Item"))] }] },
        { type: "blockquote", content: [p(text("Quote"))] },
        { type: "signature", content: [p(text("Inner"))] },
      ],
    });
    expect(result).toEqual({
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "Anna", marks: [{ type: "bold" }] }] },
        para("Item"),
        para("Quote"),
        para("Inner"),
      ],
    });
  });

  it("drops a first line that is the delimiter", () => {
    expect(normalizeSignature({ type: "doc", content: [p(text("--")), p(text("Anna"))] })).toEqual(sigDoc("Anna"));
    expect(normalizeSignature({ type: "doc", content: [p(text("-- ")), p(text("Anna"))] })).toEqual(sigDoc("Anna"));
    expect(
      normalizeSignature({ type: "doc", content: [p(text("-- "), { type: "hardBreak" }, text("Anna"))] }),
    ).toEqual(sigDoc("Anna"));
    // Only the first line, and only exactly.
    expect(normalizeSignature({ type: "doc", content: [p(text("Anna")), p(text("--"))] })).toEqual(sigDoc("Anna", "--"));
    expect(normalizeSignature({ type: "doc", content: [p(text("--- Anna"))] })).toEqual(sigDoc("--- Anna"));
  });

  it("drops links with other protocols", () => {
    const result = normalizeSignature({
      type: "doc",
      content: [
        p(
          text("x", [{ type: "link", attrs: { href: "javascript:alert(1)" } }]),
          text("y", [{ type: "link", attrs: { href: "https://example.org/" } }]),
        ),
      ],
    });
    expect(result.content[0]).toEqual({
      type: "paragraph",
      content: [
        { type: "text", text: "x" },
        { type: "text", text: "y", marks: [{ type: "link", attrs: { href: "https://example.org/" } }] },
      ],
    });
  });

  it("refuses over 2 000 characters and over 16 KiB", () => {
    expect(() => normalizeSignature({ type: "doc", content: [p(text("a".repeat(SIGNATURE_MAX_CHARS)))] })).not.toThrow();
    refuses(() => normalizeSignature({ type: "doc", content: [p(text("a".repeat(SIGNATURE_MAX_CHARS + 1)))] }));
    const bold = [{ type: "bold" }, { type: "italic" }, { type: "underline" }];
    const many = Array.from({ length: 400 }, () => p(text("ab", bold)));
    expect(new TextEncoder().encode(JSON.stringify(many)).length).toBeGreaterThan(SIGNATURE_MAX_BYTES);
    refuses(() => normalizeSignature({ type: "doc", content: many }));
  });

  it("refuses what is not a document", () => {
    refuses(() => normalizeSignature("Anna"));
    refuses(() => normalizeSignature(null));
    refuses(() => normalizeSignature({ content: [] }));
  });

  it("gives an empty document for an empty signature", () => {
    expect(normalizeSignature({ type: "doc", content: [] })).toEqual({ type: "doc", content: [] });
  });
});

describe("signatureBlock", () => {
  it("wraps the paragraphs, or gives an empty block for none", () => {
    expect(signatureBlock(sigDoc("Anna"))).toEqual({ type: "signature", content: [para("Anna")] });
    expect(signatureBlock(null)).toEqual({ type: "signature", content: [] });
  });
});

describe("withSignature", () => {
  const sig = sigDoc("Anna");
  const block = { type: "signature", content: [para("Anna")] };

  it("puts the signature after an empty first line for a new message", () => {
    const doc: ComposeDoc = { type: "doc", content: [{ type: "paragraph" }] };
    expect(withSignature(doc, sig, "new").content).toEqual([{ type: "paragraph" }, block]);
    expect(withSignature(doc, null, "new").content).toEqual([{ type: "paragraph" }, { type: "signature", content: [] }]);
  });

  it("puts it above the attribution and the quote of a reply, reply all and forward", () => {
    const doc = docFromLines(["", "On Mon, Bob wrote:"], ["Question"]);
    for (const kind of ["reply", "reply_all", "forward"] as const) {
      const result = withSignature(doc, sig, kind);
      expect(result.content.map((b) => b.type)).toEqual(["paragraph", "signature", "paragraph", "blockquote"]);
      expect(result.content[1]).toEqual(block);
    }
    // An HTML original: the quote is imported later, the signature still sits above the attribution.
    const html = docFromLines(["", "On Mon, Bob wrote:"]);
    expect(withSignature(html, sig, "reply").content.map((b) => b.type)).toEqual(["paragraph", "signature", "paragraph"]);
  });

  it("puts it before the trailing quote of an agent reply, else at the end", () => {
    const reply = docFromLines(["Thanks", "See you"], ["On Mon, Bob wrote:", "Question"]);
    expect(withSignature(reply, sig, "agent_reply").content.map((b) => b.type)).toEqual([
      "paragraph",
      "paragraph",
      "signature",
      "blockquote",
    ]);
    const fresh = docFromLines(["Hello"]);
    expect(withSignature(fresh, sig, "agent_new").content.map((b) => b.type)).toEqual(["paragraph", "signature"]);
    expect(withSignature(fresh, sig, "agent_reply").content.map((b) => b.type)).toEqual(["paragraph", "signature"]);
  });

  it("leaves a document that already has a signature alone", () => {
    const doc: ComposeDoc = { type: "doc", content: [{ type: "paragraph" }, { type: "signature", content: [] }] };
    expect(withSignature(doc, sig, "new")).toEqual(doc);
  });

  it("renders the -- delimiter for a new message and none for a reply", () => {
    const fresh = withSignature({ type: "doc", content: [para("Hello")] }, sig, "new");
    expect(renderDoc(fresh).text).toBe("Hello\n\n-- \nAnna");
    const reply = withSignature(docFromLines(["Hi", "On Mon, Bob wrote:"], ["Question"]), sig, "reply");
    expect(renderDoc(reply).text).toBe("Hi\n\nAnna\n\nOn Mon, Bob wrote:\n\n> Question");
  });
});

describe("swapSignature", () => {
  const previous = sigDoc("Anna");
  const next = sigDoc("Anna Example", "Sales");
  const docWith = (content: ComposeParagraph[]): ComposeDoc => ({
    type: "doc",
    content: [para("Hello"), { type: "signature", content }],
  });

  it("leaves a document without a signature block unchanged", () => {
    const doc: ComposeDoc = { type: "doc", content: [para("Hello")] };
    expect(swapSignature(doc, previous, next)).toEqual({ doc, kept: false });
  });

  it("fills an empty block", () => {
    expect(swapSignature(docWith([]), null, next).doc).toEqual(docWith(next.content));
    expect(swapSignature(docWith([{ type: "paragraph" }]), previous, next)).toEqual({ doc: docWith(next.content), kept: false });
  });

  it("replaces a block equal to the previous signature", () => {
    expect(swapSignature(docWith(previous.content), previous, next)).toEqual({ doc: docWith(next.content), kept: false });
  });

  it("keeps a block the owner edited", () => {
    const edited = docWith([para("Anna, on holiday")]);
    expect(swapSignature(edited, previous, next)).toEqual({ doc: edited, kept: true });
    expect(swapSignature(edited, null, next)).toEqual({ doc: edited, kept: true });
  });

  it("empties the block when the next identity has none", () => {
    expect(swapSignature(docWith(previous.content), previous, null)).toEqual({ doc: docWith([]), kept: false });
  });
});

describe("stripOwnSignature", () => {
  it("drops the delimiter and the lines up to the first blank line", () => {
    expect(stripOwnSignature(["Hello", "", "-- ", "Anna", "Example Ltd", "", "> older"])).toEqual([
      "Hello",
      "",
      "",
      "> older",
    ]);
  });

  it("drops to the end when no blank line follows", () => {
    expect(stripOwnSignature(["Hello", "", "-- ", "Anna"])).toEqual(["Hello", ""]);
  });

  it("drops only the last delimiter", () => {
    expect(stripOwnSignature(["Hi", "-- ", "Old sig", "", "Body", "", "-- ", "Anna"])).toEqual([
      "Hi",
      "-- ",
      "Old sig",
      "",
      "Body",
      "",
    ]);
  });

  it("leaves lines without a delimiter unchanged", () => {
    const lines = ["Hello", "--", "Anna", "---"];
    expect(stripOwnSignature(lines)).toEqual(lines);
  });

  it("handles a delimiter at the end", () => {
    expect(stripOwnSignature(["Hello", "-- "])).toEqual(["Hello"]);
  });
});

describe("signatureText", () => {
  it("gives the signature's lines, or null", () => {
    expect(signatureText({ type: "doc", content: [para("Hi"), { type: "signature", content: [para("Anna"), para("Ltd")] }] })).toBe(
      "Anna\nLtd",
    );
    expect(signatureText({ type: "doc", content: [para("Hi"), { type: "signature", content: [] }] })).toBeNull();
    expect(signatureText({ type: "doc", content: [para("Hi")] })).toBeNull();
  });
});
