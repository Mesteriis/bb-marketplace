import { describe, expect, it } from "vitest";
import { ComposeError } from "./compose.ts";
import {
  MAIL_TEMPLATES_ANSWER_MAX_BYTES,
  MAIL_TEMPLATES_TEXT_MAX,
  TEMPLATES_MAX,
  TEMPLATE_MAX_BYTES,
  TEMPLATE_MAX_CHARS,
  TEMPLATE_NAME_MAX,
  normalizeTemplate,
  templateBlocks,
  templateName,
  templateNameKey,
  templateText,
  templatesForAgent,
} from "./templates.ts";

const text = (value: string, marks?: unknown[]) => (marks ? { type: "text", text: value, marks } : { type: "text", text: value });
const p = (...content: unknown[]) => ({ type: "paragraph", content });
const doc = (...content: unknown[]) => ({ type: "doc", content });

function refusal(run: () => unknown): ComposeError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ComposeError);
    expect((error as ComposeError).kind).toBe("invalid");
    return error as ComposeError;
  }
  throw new Error("expected a refusal");
}

describe("limits", () => {
  it("are the spec's", () => {
    expect([TEMPLATES_MAX, TEMPLATE_MAX_BYTES, TEMPLATE_MAX_CHARS, TEMPLATE_NAME_MAX]).toEqual([200, 32 * 1024, 10_000, 80]);
    expect([MAIL_TEMPLATES_TEXT_MAX, MAIL_TEMPLATES_ANSWER_MAX_BYTES]).toEqual([2_000, 64 * 1024]);
  });
});

describe("templateNameKey", () => {
  it("ignores case, outer and repeated inner spaces, and full-width forms", () => {
    expect(templateNameKey("  Thanks   For  Your Order ")).toBe("thanks for your order");
    expect(templateNameKey("Ｔｈａｎｋｓ")).toBe("thanks");
    expect(templateNameKey("Спасибо\u00a0Заказ")).toBe("спасибо заказ");
  });
});

describe("templateName", () => {
  it("keeps a one-line name of 1 to 80 characters, trimmed", () => {
    expect(templateName("  Order received ")).toBe("Order received");
    expect(templateName("a".repeat(80))).toBe("a".repeat(80));
  });

  it("refuses empty, overlong and multi-line names", () => {
    refusal(() => templateName("   "));
    refusal(() => templateName("a".repeat(81)));
    refusal(() => templateName("one\ntwo"));
    refusal(() => templateName("one\rtwo"));
    refusal(() => templateName("one\u2028two"));
    refusal(() => templateName(42 as unknown as string));
  });
});

describe("normalizeTemplate", () => {
  it("keeps paragraphs, lists and marks", () => {
    const result = normalizeTemplate(
      doc(
        p(text("Thanks ", [{ type: "bold" }]), text("here", [{ type: "link", attrs: { href: "https://example.org/" } }])),
        { type: "bulletList", content: [{ type: "listItem", content: [p(text("One"))] }] },
      ),
    );
    expect(result.content.map((b) => b.type)).toEqual(["paragraph", "bulletList"]);
    expect(templateText(result)).toBe("Thanks here <https://example.org/>\n\n- One");
  });

  it("refuses a quote, at any depth", () => {
    const error = refusal(() => normalizeTemplate(doc({ type: "blockquote", content: [p(text("q"))] })));
    expect(error.message).toBe("Templates cannot hold quotes");
    refusal(() =>
      normalizeTemplate(
        doc({ type: "bulletList", content: [{ type: "listItem", content: [{ type: "blockquote", content: [p(text("q"))] }] }] }),
      ),
    );
  });

  it("refuses a signature block", () => {
    refusal(() => normalizeTemplate(doc(p(text("Hi")), { type: "signature", content: [p(text("Anna"))] })));
  });

  it("refuses over 10 000 characters and over 32 KiB", () => {
    expect(() => normalizeTemplate(doc(p(text("a".repeat(TEMPLATE_MAX_CHARS)))))).not.toThrow();
    refusal(() => normalizeTemplate(doc(p(text("a".repeat(TEMPLATE_MAX_CHARS + 1))))));
    const marks = [{ type: "bold" }, { type: "italic" }, { type: "underline" }];
    refusal(() => normalizeTemplate(doc(...Array.from({ length: 800 }, () => p(text("ab", marks))))));
  });

  it("refuses what is not a document", () => {
    refusal(() => normalizeTemplate("text"));
    refusal(() => normalizeTemplate(null));
  });
});

describe("templateBlocks", () => {
  it("gives copies of the blocks", () => {
    const template = normalizeTemplate(doc(p(text("One")), p(text("Two"))));
    const blocks = templateBlocks(template);
    expect(blocks).toEqual(template.content);
    expect(blocks[0]).not.toBe(template.content[0]);
  });
});

describe("templatesForAgent", () => {
  it("redacts each template before its cut (slice 3f)", () => {
    const token = "ghp_" + "CanaryToken0123456789abcdefXYZ";
    const plain = normalizeTemplate(doc(p(text(`My PIN: 4402 and ${token}`))));
    const [entry] = templatesForAgent([{ name: "Secrets", doc: plain }]);
    expect(entry!.text).not.toContain("4402");
    expect(entry!.text).not.toContain("ghp_");
    const straddling = normalizeTemplate(doc(p(text(`${"b ".repeat(995)}${token}`))));
    const [cut] = templatesForAgent([{ name: "Long", doc: straddling }]);
    expect(cut!.text).not.toContain("ghp_");
    expect(cut!.text).not.toContain("Canary");
  });

  it("cuts long texts with an ellipsis", () => {
    const long = normalizeTemplate(doc(p(text("b".repeat(3_000)))));
    const [entry] = templatesForAgent([{ name: "Long", doc: long }]);
    expect(entry!.name).toBe("Long");
    expect([...entry!.text]).toHaveLength(MAIL_TEMPLATES_TEXT_MAX);
    expect(entry!.text.endsWith("…")).toBe(true);
  });

  it("keeps the whole answer within 64 KiB and 200 entries", () => {
    const body = normalizeTemplate(doc(p(text("я".repeat(1_900)))));
    const rows = Array.from({ length: 250 }, (_, i) => ({ name: `T${i}`, doc: body }));
    const answer = templatesForAgent(rows);
    expect(answer.length).toBeLessThanOrEqual(TEMPLATES_MAX);
    expect(answer.length).toBeGreaterThan(0);
    expect(new TextEncoder().encode(JSON.stringify(answer)).length).toBeLessThanOrEqual(MAIL_TEMPLATES_ANSWER_MAX_BYTES);
    const small = normalizeTemplate(doc(p(text("ok"))));
    expect(templatesForAgent(Array.from({ length: 250 }, (_, i) => ({ name: `T${i}`, doc: small })))).toHaveLength(200);
  });
});
