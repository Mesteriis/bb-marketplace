import { describe, expect, it } from "vitest";
import {
  RELATED_CANDIDATES_MAX,
  RELATED_TERMS_MAX,
  RELATED_TOP,
  relatedTerms,
  scoreRelated,
  type RelatedCandidate,
} from "./related.ts";

describe("relatedTerms", () => {
  it("keeps tickets first, then subject words, then frequent body words", () => {
    expect(
      relatedTerms(
        "Re: Invoice INV-2041 for the quarterly audit",
        "Hello, the auditor asked about inv-2041 again. The auditor wants the ledger. Thanks, regards",
      ),
    ).toEqual(["INV-2041", "invoice", "quarterly", "audit", "auditor", "asked", "again", "wants"]);
  });

  it("drops short words, English and Russian stop words, and keeps numbers of four digits", () => {
    expect(relatedTerms("about that 2026 plan", "")).toEqual(["2026", "plan"]);
    expect(
      relatedTerms(
        "\u0441\u043f\u0430\u0441\u0438\u0431\u043e \u043e\u0442\u0447\u0451\u0442 \u043f\u043e \u043a\u0432\u0430\u0440\u0442\u0430\u043b\u0443",
        "",
      ),
    ).toEqual(["\u043e\u0442\u0447\u0451\u0442", "\u043a\u0432\u0430\u0440\u0442\u0430\u043b\u0443"]);
  });

  it("returns at most 8 terms and reads only the first 2 000 body characters", () => {
    const body = Array.from({ length: 30 }, (_, i) => `word${String.fromCharCode(97 + (i % 26))}${i}`).join(" ");
    expect(relatedTerms("", body)).toHaveLength(RELATED_TERMS_MAX);
    expect(relatedTerms("", `${"x ".repeat(1000)}distant`)).toEqual([]);
  });
});

function candidate(id: string, extra: Partial<RelatedCandidate> = {}): RelatedCandidate {
  return {
    messageId: id,
    threadId: `t-${id}`,
    date: "2026-11-01T00:00:00.000Z",
    terms: [],
    participants: 0,
    reference: false,
    rank: null,
    ...extra,
  };
}

describe("scoreRelated", () => {
  it("weights rare terms higher, adds participants and references, and gives reasons", () => {
    const result = scoreRelated(
      [
        candidate("common1", { terms: ["invoice"] }),
        candidate("common2", { terms: ["invoice"] }),
        candidate("rare", { terms: ["ledger"] }),
        candidate("person", { participants: 1 }),
        candidate("ref", { reference: true }),
      ],
      { excludeThreadId: null },
    );
    expect(result.map((r) => r.messageId)).toEqual(["ref", "rare", "common1", "common2", "person"]);
    expect(result[0]!.reasons).toEqual([{ kind: "reference" }]);
    expect(result[1]!.reasons).toEqual([{ kind: "terms", terms: ["ledger"] }]);
    expect(result[4]!.reasons).toEqual([{ kind: "participants", count: 1 }]);
    expect(result[1]!.score).toBeGreaterThan(result[2]!.score);
  });

  it("leaves out the open conversation and candidates with no score", () => {
    const result = scoreRelated(
      [candidate("same", { threadId: "open", reference: true }), candidate("none"), candidate("hit", { participants: 2 })],
      { excludeThreadId: "open" },
    );
    expect(result.map((r) => r.messageId)).toEqual(["hit"]);
    expect(result[0]!.score).toBe(4);
  });

  it("breaks ties by bm25, then by date", () => {
    const result = scoreRelated(
      [
        candidate("a", { terms: ["plan"], rank: -1, date: "2026-11-01T00:00:00.000Z" }),
        candidate("b", { terms: ["plan"], rank: -3, date: "2026-10-01T00:00:00.000Z" }),
        candidate("c", { terms: ["plan"], rank: -1, date: "2026-11-05T00:00:00.000Z" }),
      ],
      { excludeThreadId: null },
    );
    expect(result.map((r) => r.messageId)).toEqual(["b", "c", "a"]);
  });

  it("keeps the top 10 of at most 200 candidates", () => {
    const many = Array.from({ length: 300 }, (_, i) => candidate(`m${i}`, { participants: 1 }));
    expect(scoreRelated(many, { excludeThreadId: null })).toHaveLength(RELATED_TOP);
    expect(RELATED_CANDIDATES_MAX).toBe(200);
  });
});
