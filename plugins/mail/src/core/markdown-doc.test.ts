import { describe, expect, it } from "vitest";
import { MARKDOWN_INPUT_MAX, markdownToDoc } from "./markdown-doc.ts";
import { renderDoc } from "./compose-doc.ts";

const t = (text: string, marks?: unknown[]) => (marks ? { type: "text", text, marks } : { type: "text", text });
const p = (...content: unknown[]) => (content.length > 0 ? { type: "paragraph", content } : { type: "paragraph" });

describe("markdownToDoc", () => {
  it("makes paragraphs with hard breaks", () => {
    expect(markdownToDoc("First line\nsecond line\n\nNext paragraph")).toEqual({
      type: "doc",
      content: [p(t("First line"), { type: "hardBreak" }, t("second line")), p(t("Next paragraph"))],
    });
  });

  it("makes bullet and ordered lists", () => {
    expect(markdownToDoc("- one\n* two\n\n1. first\n2) second").content).toEqual([
      { type: "bulletList", content: [{ type: "listItem", content: [p(t("one"))] }, { type: "listItem", content: [p(t("two"))] }] },
      { type: "orderedList", content: [{ type: "listItem", content: [p(t("first"))] }, { type: "listItem", content: [p(t("second"))] }] },
    ]);
  });

  it("makes block quotes", () => {
    expect(markdownToDoc("> quoted\n> more\n\nafter").content).toEqual([
      { type: "blockquote", content: [p(t("quoted"), { type: "hardBreak" }, t("more"))] },
      p(t("after")),
    ]);
  });

  it("makes fenced code blocks with a language", () => {
    expect(markdownToDoc("Run:\n\n```bash\nnpm ci\n  npm test\n```\nDone").content).toEqual([
      p(t("Run:")),
      { type: "codeBlock", attrs: { language: "bash" }, content: [t("npm ci\n  npm test")] },
      p(t("Done")),
    ]);
  });

  it("turns headings into bold paragraphs", () => {
    expect(markdownToDoc("## Summary\nText").content).toEqual([p(t("Summary", [{ type: "bold" }])), p(t("Text"))]);
  });

  it("links https [text](url) and bare https URLs only", () => {
    expect(markdownToDoc("See [the PR](https://github.com/example-org/demo/pull/1) and https://example.org/x.").content).toEqual([
      p(
        t("See "),
        t("the PR", [{ type: "link", attrs: { href: "https://github.com/example-org/demo/pull/1" } }]),
        t(" and "),
        t("https://example.org/x", [{ type: "link", attrs: { href: "https://example.org/x" } }]),
        t("."),
      ),
    ]);
    for (const literal of ["[x](javascript:alert(1))", "[x](http://example.org/)", "http://example.org/"]) {
      expect(markdownToDoc(literal).content, literal).toEqual([p(t(literal))]);
    }
  });

  it("keeps everything else literal", () => {
    expect(markdownToDoc("**bold** and `code` | a | b |").content).toEqual([p(t("**bold** and `code` | a | b |"))]);
  });

  it("renders to escaped HTML", () => {
    expect(renderDoc(markdownToDoc("<script>x</script>")).html).toContain("&lt;script&gt;x&lt;/script&gt;");
  });

  it("reads at most 100 000 characters", () => {
    const doc = markdownToDoc("a".repeat(MARKDOWN_INPUT_MAX + 5_000));
    const first = doc.content[0] as { content: { text: string }[] };
    expect(first.content[0]!.text.length).toBe(MARKDOWN_INPUT_MAX);
    expect(markdownToDoc("").content).toEqual([{ type: "paragraph" }]);
  });
});
