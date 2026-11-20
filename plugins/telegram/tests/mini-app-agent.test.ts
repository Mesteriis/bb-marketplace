import { afterEach, expect, test, vi } from "vitest";
import { createMiniAppAgent, miniAppAgentTool } from "../src/adapters/bb/mini-app-agent.ts";
import type { TelegramToolRegistrar } from "../src/adapters/bb/agent-cli.ts";

afterEach(() => vi.useRealTimers());

test("scopes Mini App controls to the selected thread and logs dispatched actions", async () => {
  vi.useFakeTimers();
  const broker = createMiniAppAgent();
  const snapshot = { label: "Fixture Mini App", ready: true, back: true, settings: false };
  let live = true;
  let invoke!: (action: "inspect" | "back", threadId?: string) => string | Promise<string>;
  const register: TelegramToolRegistrar = (tool) => {
    expect(tool.name).toBe(miniAppAgentTool);
    invoke = (action, threadId = "approved") => tool.execute(tool.parameters.parse({ action }), {
      threadId, projectId: "fixture-project", signal: new AbortController().signal,
    });
  };
  broker.register(register, () => live);
  broker.grant("fixture", "approved", "view", snapshot);
  expect(await invoke("inspect", "other")).not.toContain(snapshot.label);
  expect(JSON.parse(await invoke("inspect"))).toMatchObject({ ...snapshot, access: "view" });
  expect(await invoke("back")).toContain("view-only");
  broker.grant("fixture", "approved", "navigate", snapshot);
  expect(await invoke("back")).toContain("queued");
  const command = broker.poll("fixture", snapshot).command;
  expect(command).toBeTypeOf("number");
  expect(broker.poll("fixture", snapshot).command).toBeUndefined();
  expect(broker.poll("fixture", snapshot, { id: command!, sent: true }).events[0]?.action).toBe("back");
  live = false;
  expect(await invoke("inspect")).not.toContain(snapshot.label);
  live = true;
  vi.advanceTimersByTime(5_001);
  expect(await invoke("inspect")).not.toContain(snapshot.label);
  expect(broker.poll("fixture", snapshot).grant).toBeNull();
});
