// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { FeedEvent } from "../core/agent-feed.ts";
import { CommandLog, MAX_LOG_COMMANDS, MAX_LOG_OUTPUT_CHARS, applyExecEvent, type LoggedCommand } from "./command-log.tsx";

afterEach(cleanup);
const ev = (e: Partial<Extract<FeedEvent, { kind: "exec" }>> & { phase: "started" | "output" | "finished" }): FeedEvent => ({ kind: "exec", commandId: "c1", text: "", ...e }) as FeedEvent;

describe("applyExecEvent: what the owner's view keeps of the commands an agent ran", () => {
  it("a command starts, output arrives in order per stream, and it ends with its exit status", () => {
    let list: LoggedCommand[] = [];
    list = applyExecEvent(list, ev({ phase: "started", text: "ls -la" }));
    list = applyExecEvent(list, ev({ phase: "output", stream: "stdout", text: "a\n" }));
    list = applyExecEvent(list, ev({ phase: "output", stream: "stderr", text: "warn\n" }));
    list = applyExecEvent(list, ev({ phase: "output", stream: "stdout", text: "b\n" }));
    list = applyExecEvent(list, ev({ phase: "finished", exitCode: 2, reason: "exited" }));
    expect(list).toEqual([{ id: "c1", command: "ls -la", chunks: [{ stream: "stdout", text: "a\n" }, { stream: "stderr", text: "warn\n" }, { stream: "stdout", text: "b\n" }], truncated: false, running: false, exitCode: 2, reason: "exited" }]);
  });

  it("output for a command whose start was missed (the view opened later) still shows, without its text", () => {
    const list = applyExecEvent([], ev({ phase: "output", commandId: "late", stream: "stdout", text: "x\n" }));
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: "late", command: null, running: true });
  });

  it("keeps the newest few commands and only the head of a command's output", () => {
    let list: LoggedCommand[] = [];
    for (let i = 0; i < MAX_LOG_COMMANDS + 3; i++) list = applyExecEvent(list, ev({ phase: "started", commandId: `c${i}`, text: `cmd ${i}` }));
    expect(list).toHaveLength(MAX_LOG_COMMANDS);
    expect(list[0]!.id).toBe("c3");
    const big = applyExecEvent([], ev({ phase: "started" }));
    const flooded = applyExecEvent(applyExecEvent(big, ev({ phase: "output", stream: "stdout", text: "A".repeat(MAX_LOG_OUTPUT_CHARS) })), ev({ phase: "output", stream: "stdout", text: "B".repeat(50) }));
    expect(flooded[0]!.chunks.map((c) => c.text.length).reduce((a, b) => a + b, 0)).toBe(MAX_LOG_OUTPUT_CHARS);
    expect(flooded[0]!.truncated).toBe(true);
  });

  it("an event that is not about a command changes nothing", () => {
    const list = applyExecEvent([], ev({ phase: "started", text: "id" }));
    expect(applyExecEvent(list, { kind: "typed", length: 3 })).toBe(list);
  });
});

describe("CommandLog", () => {
  it("shows nothing until an agent has run a command", () => {
    const { container } = render(<CommandLog commands={[]} />);
    expect(container.textContent).toBe("");
  });

  it("lists each command with its output (stderr marked), its state and exit status, as text only", () => {
    render(<CommandLog commands={[
      { id: "c1", command: "make test", chunks: [{ stream: "stdout", text: "ok\n" }, { stream: "stderr", text: "<img src=x onerror=alert(1)>\n" }], truncated: true, running: false, exitCode: 1, reason: "exited" },
      { id: "c2", command: "sleep 99", chunks: [], truncated: false, running: true, exitCode: null, reason: null },
    ]} />);
    const log = screen.getByLabelText("Команды агента");
    expect(log.textContent).toContain("$ make test");
    expect(log.textContent).toContain("код выхода 1");
    expect(log.textContent).toContain("вывод обрезан");
    expect(log.textContent).toContain("выполняется…");
    expect(log.textContent).toContain("<img src=x onerror=alert(1)>");
    expect(log.querySelector("img")).toBeNull();
    expect(screen.getByTestId("stderr-0").textContent).toContain("<img");
  });

  it("says plainly when a command was stopped rather than finished", () => {
    render(<CommandLog commands={[{ id: "c1", command: "sleep 99", chunks: [], truncated: false, running: false, exitCode: null, reason: "timeout" }]} />);
    expect(screen.getByLabelText("Команды агента").textContent).toContain("остановлена: timeout");
  });
});
