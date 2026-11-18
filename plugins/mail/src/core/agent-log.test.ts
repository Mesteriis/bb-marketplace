import { describe, expect, it } from "vitest";
import {
  LOG_ACTORS,
  AGENT_LOG_IDS_MAX,
  AGENT_LOG_KEEP_DAYS,
  AGENT_LOG_ROWS_MAX,
  LOG_OUTCOMES,
  LOG_OUTCOME_LABEL,
  LOG_TOOLS,
  LOG_TOOL_LABEL,
  logEntry,
} from "./agent-log.ts";

const NOW = new Date("2026-11-16T10:42:00.000Z");

describe("logEntry", () => {
  it("fills defaults and stamps the time", () => {
    expect(logEntry({ actor: "agent", tool: "search", outcome: "ok", threadId: "thread-1" }, NOW)).toEqual({
      at: "2026-11-16T10:42:00.000Z",
      actor: "agent",
      threadId: "thread-1",
      tool: "search",
      outcome: "ok",
      messageIds: [],
      count: 0,
      hiddenCount: 0,
      refId: null,
      provider: null,
      model: null,
    });
  });

  it("de-duplicates and caps the ids", () => {
    const ids = Array.from({ length: 80 }, (_, i) => `m_${i % 60}`);
    const entry = logEntry({ actor: "agent", tool: "inbox", outcome: "ok", messageIds: ids, count: 80 }, NOW);
    expect(entry.messageIds).toHaveLength(AGENT_LOG_IDS_MAX);
    expect(new Set(entry.messageIds).size).toBe(AGENT_LOG_IDS_MAX);
    expect(entry.messageIds[0]).toBe("m_0");
    expect(entry.count).toBe(80);
  });

  it("keeps the provider and model for owner_ai only", () => {
    const ai = logEntry({ actor: "owner_ai", tool: "ai_summary", outcome: "ok", provider: "p", model: "m" }, NOW);
    expect([ai.provider, ai.model]).toEqual(["p", "m"]);
    const agent = logEntry({ actor: "agent", tool: "read", outcome: "ok", provider: "p", model: "m" }, NOW);
    expect([agent.provider, agent.model]).toEqual([null, null]);
  });

  it("a mention has no thread", () => {
    expect(logEntry({ actor: "mention", tool: "mention", outcome: "ok", threadId: "thread-1" }, NOW).threadId).toBeNull();
  });

  it("clamps negative or fractional counts", () => {
    const entry = logEntry({ actor: "agent", tool: "search", outcome: "ok", count: -2, hiddenCount: 2.7 }, NOW);
    expect([entry.count, entry.hiddenCount]).toEqual([0, 2]);
  });
});

describe("labels and limits", () => {
  it("labels every tool and outcome", () => {
    for (const tool of LOG_TOOLS) expect(LOG_TOOL_LABEL[tool], tool).toMatch(/^[A-Z]/);
    for (const outcome of LOG_OUTCOMES) expect(LOG_OUTCOME_LABEL[outcome], outcome).toMatch(/^[A-Z]/);
    expect(LOG_TOOL_LABEL.search).toBe("Searched mail");
    expect(LOG_TOOL_LABEL.read).toBe("Read an email");
    expect(LOG_TOOLS).toContain("templates");
  });

  it("knows the slice 3g actors, tools and outcomes, each labelled", () => {
    expect(LOG_ACTORS).toEqual(expect.arrayContaining(["owner_bb", "rule"]));
    expect(LOG_TOOLS).toEqual(
      expect.arrayContaining(["bb_thread", "bb_task", "project_save", "patch_handoff", "incident", "rule_thread"]),
    );
    expect(LOG_OUTCOMES).toEqual(expect.arrayContaining(["prepared", "started", "capped"]));
    expect(LOG_TOOL_LABEL.bb_thread).toBe("Started a BB thread");
    expect(LOG_TOOL_LABEL.bb_task).toBe("Made a task");
    expect(LOG_TOOL_LABEL.project_save).toBe("Saved files to a project");
    expect(LOG_TOOL_LABEL.patch_handoff).toBe("Handed a patch to an agent");
    expect(LOG_TOOL_LABEL.incident).toBe("Opened or updated an incident thread");
    expect(LOG_TOOL_LABEL.rule_thread).toBe("Mail rule");
    for (const outcome of ["prepared", "started", "capped"] as const) {
      expect(LOG_OUTCOME_LABEL[outcome]).toMatch(/^[A-Z]/);
    }
  });

  it("keeps 90 days and 20 000 rows", () => {
    expect(AGENT_LOG_KEEP_DAYS).toBe(90);
    expect(AGENT_LOG_ROWS_MAX).toBe(20_000);
  });
});
