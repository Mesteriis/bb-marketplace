// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { installTestPluginRuntime } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LOG_ACTORS, LOG_OUTCOMES, LOG_TOOLS } from "../core/agent-log.ts";
import type { LogEntryView } from "../core/model.ts";
import { AgentActivity, MESSAGE_GONE, TERMINAL_NOT_LOGGED, logLine, logTime } from "./agent-activity.tsx";

installTestPluginRuntime();
afterEach(cleanup);
const proto = Element.prototype as unknown as Record<string, unknown>;
proto.scrollIntoView ??= () => {};
proto.hasPointerCapture ??= () => false;
proto.releasePointerCapture ??= () => {};

const NOW = new Date(2026, 10, 16, 12, 0);
const entry = (overrides: Partial<LogEntryView>): LogEntryView => ({
  seq: 1,
  at: new Date(2026, 10, 16, 10, 42).toISOString(),
  actor: "agent",
  tool: "search",
  outcome: "ok",
  threadId: "bb-thread-1",
  count: 8,
  hiddenCount: 0,
  provider: null,
  model: null,
  messages: [],
  ...overrides,
});

describe("AgentActivity", () => {
  it("every actor, tool and outcome has a label", () => {
    for (const actor of LOG_ACTORS) for (const tool of LOG_TOOLS) for (const outcome of LOG_OUTCOMES) {
      expect(logLine(entry({ actor, tool, outcome }), NOW)).not.toContain("undefined");
    }
  });

  it("rows read as the spec's flow", () => {
    expect(logLine(entry({}), NOW)).toBe(`${logTime(entry({}).at, NOW)} \u00b7 Agent \u00b7 Searched mail \u00b7 done \u00b7 8 items`);
    expect(logTime(new Date(2026, 10, 16, 10, 42).toISOString(), NOW)).toMatch(/^Today /);
    expect(logTime(new Date(2026, 10, 15, 10, 42).toISOString(), NOW)).toMatch(/^Yesterday /);
    expect(logLine(entry({ actor: "owner_ai", tool: "ai_summary", count: 1, model: "model-y", provider: "provider-x" }), NOW)).toContain(
      "You (AI) \u00b7 Summary \u00b7 done \u00b7 1 item \u00b7 model-y",
    );
  });

  it("resolves messages, marks gone ones, filters by thread and clears after a confirmation", async () => {
    const entries = [
      entry({
        seq: 2,
        tool: "read",
        count: 2,
        messages: [
          { id: "m-1", subject: "Contract", from: "Ada Example", date: "2026-11-15T09:00:00.000Z", accountId: "acc-1", threadId: "th-1" },
          { id: "m-2", subject: null, from: null, date: null, accountId: null, threadId: null },
        ],
      }),
      entry({ seq: 1, threadId: "bb-thread-2" }),
    ];
    const props = {
      load: vi.fn(async ({ threadId }: { threadId?: string }) => ({
        entries: threadId === undefined ? entries : entries.filter((e) => e.threadId === threadId),
        next: null,
      })),
      clear: vi.fn(async () => 2),
      onOpen: vi.fn(),
    };
    render(<AgentActivity {...props} />);
    expect(screen.getByText(new RegExp(TERMINAL_NOT_LOGGED.replace(".", "\\.")))).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: "Contract \u00b7 Ada Example" }));
    expect(props.onOpen).toHaveBeenCalledWith("acc-1", "th-1");
    expect(screen.getByText(MESSAGE_GONE)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Clear log\u2026" }));
    expect(props.clear).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Clear log" }));
    await waitFor(() => expect(props.clear).toHaveBeenCalled());
    await waitFor(() => expect(props.load).toHaveBeenCalledTimes(2));
  });
});
