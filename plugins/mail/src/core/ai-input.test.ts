import { describe, expect, it } from "vitest";
import {
  AI_INPUT_CAPS,
  AI_KINDS,
  AI_MAX_OUTPUT_TOKENS,
  AI_PREAMBLE,
  AI_RATES,
  AiError,
  DRAFT_TOO_LONG_TEXT,
  NonceCollision,
  aiErrorText,
  aiPart,
  askAnswerInput,
  askPlanInput,
  categoriesInput,
  digestInput,
  draftInput,
  evidenceFound,
  extractJson,
  frameInput,
  isoDay,
  parseAskAnswer,
  parseAskPlan,
  parseCategories,
  parseDigest,
  parseDraft,
  parseSummary,
  parseTasks,
  stripQuoted,
  summaryInput,
  summarySourceHash,
  tasksInput,
  type AiSourceMessage,
} from "./ai-input.ts";
import { aiErrorKindSchema, translateErrorKindSchema } from "./model.ts";
import { restoreSecrets } from "./redact.ts";

const NONCE = "n0nce5a1t";
const FAKE_GHP = "ghp_" + "Zx9Qw8Er7Ty6Ui5Op4As3Df2Gh1Jk0Lm";
const TEST_CARD = "4111 1111 1111 1111";

function message(id: string, body: string, overrides: Partial<AiSourceMessage> = {}): AiSourceMessage {
  return {
    id,
    date: "2026-11-10T09:00:00.000Z",
    from: { name: "Ann Example", address: "ann@example.com" },
    subject: `Subject ${id}`,
    body: { text: body, html: null },
    ...overrides,
  };
}

describe("constants", () => {
  it("lists the kinds with rates, caps and output limits", () => {
    expect(AI_KINDS).toEqual(["summary", "ask", "tasks", "categories", "digest", "draft"]);
    expect(AI_RATES).toEqual({ summary: 30, tasks: 30, ask: 20, categories: 10, digest: 10, draft: 30 });
    expect(AI_INPUT_CAPS.draft).toBe(8_000);
    expect(AI_INPUT_CAPS.summary).toBe(60_000);
    expect(AI_MAX_OUTPUT_TOKENS).toEqual({
      summary: 4_096, askPlan: 512, askAnswer: 2_048, tasks: 2_048, categories: 2_048, digest: 4_096, draft: 4_096,
    });
  });

  it("extends the translation error kinds with a fixed AI text each", () => {
    expect(aiErrorKindSchema.options).toEqual([...translateErrorKindSchema.options, "unreadable", "out_of_scope", "too_long"]);
    for (const kind of aiErrorKindSchema.options) expect(aiErrorText(kind)).not.toMatch(/translat/i);
    expect(new AiError("unreadable").message).toBe("The AI answer could not be read");
    expect(aiErrorText("gateway_missing")).toBe("AI features need the Makosh AI plugin");
  });
});

describe("stripQuoted", () => {
  it("drops quoted lines and an English attribution", () => {
    expect(stripQuoted("Thanks, see you.\n\nOn Mon, 9 Nov 2026 Ann wrote:\n> old text\n> more")).toBe("Thanks, see you.");
  });

  it("drops a wrapped two-line attribution", () => {
    expect(stripQuoted("Fine.\nOn Mon, 9 Nov 2026 at 10:00, Ann <ann@example.com>\nwrote:\n> old")).toBe("Fine.");
  });

  it("drops a Russian attribution", () => {
    const ru = "\u0421\u043f\u0430\u0441\u0438\u0431\u043e.\n9 \u043d\u043e\u044f\u0431. 2026 \u0410\u043d\u043d\u0430 \u043d\u0430\u043f\u0438\u0441\u0430\u043b(\u0430):\n> \u0441\u0442\u0430\u0440\u044b\u0439";
    expect(stripQuoted(ru)).toBe("\u0421\u043f\u0430\u0441\u0438\u0431\u043e.");
  });

  it("keeps the original when nothing would be left", () => {
    expect(stripQuoted("> only a quote\n> here")).toBe("> only a quote\n> here");
  });

  it("keeps an inline reply between quotes", () => {
    expect(stripQuoted("> question?\nanswer\n> next?\nyes")).toBe("answer\nyes");
  });
});

describe("frameInput", () => {
  it("wraps each part in nonce markers", () => {
    const input = frameInput([{ n: 1, date: "2026-11-10", from: "Ann", subject: "Hi", body: "Text" }], NONCE);
    expect(input).toBe(`<<<EMAIL ${NONCE} n=1>>>\nDate: 2026-11-10\nFrom: Ann\nSubject: Hi\n\nText\n<<<END EMAIL ${NONCE}>>>`);
  });

  it("refuses a nonce found in any part", () => {
    expect(() => frameInput([{ n: 1, date: "d", from: "f", subject: "s", body: `x ${NONCE} y` }], NONCE)).toThrow(NonceCollision);
    expect(() => frameInput([{ n: 1, date: "d", from: NONCE, subject: "s", body: "b" }], NONCE)).toThrow(NonceCollision);
    expect(() => frameInput([], "")).toThrow(NonceCollision);
  });
});

describe("aiPart", () => {
  it("redacts every field whole before the body cut", () => {
    const body = `${"a".repeat(95)} code 482913 and more`;
    const built = aiPart(
      message("m1", body, { subject: `Token ${FAKE_GHP}`, from: { name: `Bot ${FAKE_GHP}`, address: "bot@example.com" } }),
      { n: 1, bodyChars: 100 },
    );
    expect(JSON.stringify(built.part)).not.toContain(FAKE_GHP);
    expect(built.part.body).not.toContain("4829");
    expect(built.part.body.length).toBeLessThanOrEqual(100);
    expect(built.cut).toBe(true);
    expect(built.hidden).toBe(3);
  });

  it("names the domain only for categories", () => {
    expect(aiPart(message("m1", "x"), { n: 1, bodyChars: 10, fromDomainOnly: true }).part.from).toBe("Ann Example (example.com)");
    expect(aiPart(message("m1", "x", { from: { name: null, address: "x@example.org" } }), { n: 1, bodyChars: 10 }).part.from).toBe("x@example.org");
  });
});

describe("builders", () => {
  it("puts the preamble in every mail kind and asks for JSON", () => {
    const list = [message("m1", "Hello")];
    const builds = [
      summaryInput(list, { nonce: NONCE }),
      askAnswerInput("When?", list, { nonce: NONCE, today: "2026-11-16" }),
      tasksInput(list, { nonce: NONCE, today: "2026-11-16" }),
      categoriesInput(list, { nonce: NONCE }),
      digestInput(list, { nonce: NONCE }),
    ];
    for (const build of builds) {
      expect(build.instructions.startsWith(AI_PREAMBLE)).toBe(true);
      expect(build.instructions).toContain("one JSON object");
      expect(build.parts).toEqual([{ n: 1, messageId: "m1", text: "Subject m1\nHello" }]);
    }
    expect(askPlanInput("When is the meeting?", "2026-11-16").input).toBe("Today: 2026-11-16\nQuestion: When is the meeting?");
  });

  it("drops the oldest messages of a summary over the cap and notes it", () => {
    const big = "word ".repeat(5_000);
    const list = Array.from({ length: 5 }, (_, i) => message(`m${i}`, big));
    const build = summaryInput(list, { nonce: NONCE, leftOut: 2 });
    expect(build.input.length).toBeLessThanOrEqual(AI_INPUT_CAPS.summary);
    expect(build.parts.map((p) => p.messageId)).toEqual(["m3", "m4"]);
    expect(build.parts.map((p) => p.n)).toEqual([1, 2]);
    expect(build.notes).toEqual({ hidden: 0, leftOut: 2, truncated: 3 });
  });

  it("cuts a single message over the cap to fit", () => {
    const build = summaryInput([message("m1", "word ".repeat(20_000))], { nonce: NONCE });
    expect(build.parts).toHaveLength(1);
    expect(build.input.length).toBeLessThanOrEqual(AI_INPUT_CAPS.summary);
    expect(build.notes.truncated).toBe(1);
  });

  it("hides a secret that straddles an excerpt cut", () => {
    const body = `${"x ".repeat(997)}card ${TEST_CARD} end`;
    const build = askAnswerInput("q", [message("m1", body)], { nonce: NONCE, today: "2026-11-16" });
    expect(build.input).not.toContain("4111");
    expect(build.notes.hidden).toBe(1);
  });

  it("redacts the owner's question", () => {
    expect(askPlanInput(`what is ${FAKE_GHP}`, "2026-11-16").input).not.toContain(FAKE_GHP);
  });

  it("keeps the newest 10 messages for tasks", () => {
    const list = Array.from({ length: 12 }, (_, i) => message(`m${i}`, "Do it"));
    const build = tasksInput(list, { nonce: NONCE, today: "2026-11-16" });
    expect(build.parts.map((p) => p.messageId)).toEqual(list.slice(2).map((m) => m.id));
    expect(build.notes.truncated).toBe(2);
  });

  it("limits category bodies to 300 characters", () => {
    const build = categoriesInput([message("m1", "y".repeat(1_000))], { nonce: NONCE });
    expect(build.input).toContain(`${"y".repeat(300)}\n<<<END`);
    expect(build.input).not.toContain("y".repeat(301));
  });
});

describe("draftInput", () => {
  it("sends hardBreak lines and list items as lines and restores by tag", () => {
    const build = draftInput(
      ["Hi Ann,\nthanks for the call.", `- item one\n- my password: Hunter-22x`],
      { mode: "fix" },
      { nonce: NONCE, tag: "k3f9" },
    );
    const sent = JSON.parse(build.input.split("\n")[1]!) as { paragraphs: string[] };
    expect(sent.paragraphs[0]).toBe("Hi Ann,\nthanks for the call.");
    expect(sent.paragraphs[1]).toContain("[hidden password 1 k3f9]");
    expect(sent.paragraphs[1]).not.toContain("Hunter-22x");
    expect(build.notes.hidden).toBe(1);
    const restored = restoreSecrets(sent.paragraphs[1]!, build.restore!, "k3f9");
    expect(restored.text).toBe("- item one\n- my password: Hunter-22x");
  });

  it("refuses over 8 000 characters with too_long", () => {
    try {
      draftInput(["a".repeat(8_001)], { mode: "shorter" }, { nonce: NONCE, tag: "k3f9" });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(AiError);
      expect((error as AiError).kind).toBe("too_long");
      expect((error as AiError).message).toBe(DRAFT_TOO_LONG_TEXT);
    }
  });

  it("carries a custom instruction as one line", () => {
    const build = draftInput(["Text"], { mode: "custom", instruction: "make it\nrhyme" }, { nonce: NONCE, tag: "k3f9" });
    expect(build.instructions).toContain("make it rhyme");
  });
});

describe("extractJson", () => {
  it("prefers a fenced json block", () => {
    expect(extractJson('Here {"a":1}\n```json\n{"b":2}\n```')).toEqual({ b: 2 });
    expect(extractJson('Sure:\n```\n{"c":3}\n```')).toEqual({ c: 3 });
  });

  it("finds an object in prose with a brace inside a string", () => {
    expect(extractJson('Answer: {"text":"a } b \\" {","n":[1]} trailing }')).toEqual({ text: 'a } b " {', n: [1] });
  });

  it("reads nested objects and skips an unparsable first brace", () => {
    expect(extractJson('{not json} then {"a":{"b":{"c":1}}}')).toEqual({ a: { b: { c: 1 } } });
  });

  it("answers null for no object or a non-object top level", () => {
    expect(extractJson("no json here")).toBeNull();
    expect(extractJson("[1,2]")).toBeNull();
    expect(extractJson('```json\n"text"\n```')).toBeNull();
  });
});

describe("parsers", () => {
  it("strips unknown keys, clamps strings and drops out-of-range citations", () => {
    const output = JSON.stringify({
      decisions: [{ text: "x".repeat(400), messages: [1, 2, 9, 0, 1.5, 2], extra: true }],
      questions: [{ text: 5 }, { text: "Open?", messages: [] }],
      deadlines: [{ text: "Pay", date: "2026-02-30", messages: [1] }, { text: "File", date: "2026-12-01", messages: [] }],
      other: "ignored",
    });
    const parsed = parseSummary(output, 2);
    if (!parsed.ok) throw new Error("expected ok");
    expect(parsed.value.decisions).toEqual([{ text: "x".repeat(300), messages: [1, 2] }]);
    expect(parsed.value.questions).toEqual([{ text: "Open?", messages: [] }]);
    expect(parsed.value.deadlines).toEqual([
      { text: "Pay", date: null, messages: [1] },
      { text: "File", date: "2026-12-01", messages: [] },
    ]);
    expect(parsed.dropped).toBe(1);
    expect(Object.keys(parsed.value)).toEqual(["decisions", "questions", "deadlines"]);
  });

  it("fails unreadable without an object", () => {
    expect(parseSummary("I cannot help", 3)).toEqual({ ok: false, error: "unreadable" });
    expect(parseTasks("[]", 3)).toEqual({ ok: false, error: "unreadable" });
  });

  it("parses ask plans and answers", () => {
    const plan = parseAskPlan('{"queries":["from:ann invoice","a\\nb",7,"c","d"]}');
    expect(plan).toEqual({ ok: true, value: { queries: ["from:ann invoice", "a b", "c"] }, dropped: 1 });
    const answer = parseAskAnswer('{"answer":"On Friday.","sources":[3,1,4],"found":true}', 3);
    expect(answer).toEqual({ ok: true, value: { answer: "On Friday.", sources: [3, 1], found: true }, dropped: 0 });
    expect(parseAskAnswer("{}", 3)).toEqual({ ok: true, value: { answer: "", sources: [], found: false }, dropped: 0 });
  });

  it("drops tasks without a title or a valid message", () => {
    const parsed = parseTasks(
      JSON.stringify({ tasks: [
        { title: "Send the report", due: "2026-11-20", message: 1, evidence: "please send the report" },
        { title: "", message: 1 },
        { title: "Call", message: 5 },
        { title: "Book", due: "soon", message: 2 },
      ] }),
      2,
    );
    expect(parsed).toEqual({
      ok: true,
      value: { tasks: [
        { title: "Send the report", due: "2026-11-20", message: 1, evidence: "please send the report" },
        { title: "Book", due: null, message: 2, evidence: "" },
      ] },
      dropped: 2,
    });
  });

  it("parses categories and digests once per message", () => {
    expect(parseCategories('{"items":[{"n":1,"category":"bills"},{"n":1,"category":"personal"},{"n":2,"category":"spam"}]}', 2))
      .toEqual({ ok: true, value: { items: [{ n: 1, category: "bills" }] }, dropped: 2 });
    expect(parseDigest('{"items":[{"n":2,"gist":"Wants a date"},{"n":3,"gist":"x"}]}', 2))
      .toEqual({ ok: true, value: { items: [{ n: 2, gist: "Wants a date" }] }, dropped: 1 });
  });

  it("keeps draft line breaks and the length bound", () => {
    expect(parseDraft('{"paragraphs":["a\\nb","c"]}', 100)).toEqual({ ok: true, value: { paragraphs: ["a\nb", "c"] }, dropped: 0 });
    const long = parseDraft(JSON.stringify({ paragraphs: ["x".repeat(8), "y".repeat(8)] }), 10);
    expect(long).toEqual({ ok: true, value: { paragraphs: ["xxxxxxxx", "yy"] }, dropped: 1 });
  });

  it("checks real calendar dates", () => {
    expect(isoDay("2028-02-29")).toBe("2028-02-29");
    expect(isoDay("2026-02-29")).toBeNull();
    expect(isoDay("20261101")).toBeNull();
  });
});

describe("evidenceFound", () => {
  it("matches normalized whitespace and case", () => {
    expect(evidenceFound("Please  SEND\nthe report", "Hi, please send the report by Friday")).toBe(true);
    expect(evidenceFound("transfer the money", "Hi, please send the report")).toBe(false);
    expect(evidenceFound("  ", "anything")).toBe(false);
  });
});

describe("summarySourceHash", () => {
  it("is stable and changes with the content", async () => {
    const a = await summarySourceHash(["m1", "m2"], ["h1", "h2"]);
    expect(await summarySourceHash(["m1", "m2"], ["h1", "h2"])).toBe(a);
    expect(await summarySourceHash(["m1", "m2"], ["h1", "h3"])).not.toBe(a);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
});
