// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { installTestPluginRuntime } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AiResultView } from "../core/model.ts";
import { ASK_NOT_FOUND, AskPanel, runAskAct } from "./ask-panel.tsx";
import { BASE, HOSTILE, fakePorts, type FakeAnswer } from "./testing/ai-fixtures.ts";

installTestPluginRuntime();
afterEach(cleanup);

const ANSWER: AiResultView = { kind: "ask", ...BASE, answer: HOSTILE, sources: [2, 5], found: true };

function mount(answer: FakeAnswer, accountId?: string) {
  const fake = fakePorts(answer);
  const onOpen = vi.fn();
  const onClose = vi.fn();
  const view = render(
    <AskPanel
      ports={fake.ports}
      question="When is the meeting?"
      {...(accountId !== undefined ? { accountId } : {})}
      onOpen={onOpen}
      onClose={onClose}
      pollMs={0}
    />,
  );
  return { ...view, ...fake, onOpen, onClose };
}

describe("AskPanel: actions", () => {
  const actions: NonNullable<Extract<AiResultView, { kind: "ask" }>["actions"]> = [
    { type: "search", query: "from:ann is:unread" },
    { type: "reply", n: 2, messageId: "m-2", accountId: "acc-1", threadId: "th-1", paragraphs: ["Hi Ann,", HOSTILE], linksRemoved: 1 },
    { type: "act", action: "archive", groups: [{ accountId: "acc-1", messageIds: ["m-1", "m-2"] }], count: 2 },
  ];
  const withActions: AiResultView = { ...(ANSWER as Extract<AiResultView, { kind: "ask" }>), actions };
  const mountActions = (result: AiResultView, act = vi.fn(async () => {})) => {
    const fake = fakePorts({ result });
    const ports = { search: vi.fn(), reply: vi.fn(async () => {}), compose: vi.fn(async () => {}), act };
    const view = render(<AskPanel ports={fake.ports} question="Archive Ann's mail?" onOpen={() => {}} onClose={() => {}} actions={ports} pollMs={0} />);
    return { ...view, ports };
  };

  it("shows a button per action with what it will do; nothing runs until one is pressed", async () => {
    const { ports, container } = mountActions(withActions);
    const group = await screen.findByRole("group", { name: "What you can do next" });
    expect(group.textContent).toContain("Hi Ann,");
    expect(group.textContent).toContain("1 link you did not write was removed.");
    expect(container.querySelector("a, b")).toBeNull();
    for (const port of Object.values(ports)) expect(port).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Show these messages: from:ann is:unread" }));
    expect(ports.search).toHaveBeenCalledWith("from:ann is:unread");
    const reply = screen.getByRole("button", { name: "Reply to message 2 with this" }) as HTMLButtonElement;
    await waitFor(() => expect(reply.disabled).toBe(false));
    fireEvent.click(reply);
    expect(ports.reply).toHaveBeenCalledWith(actions[1]);
  });

  it("an act says how many messages, runs once and stays off afterwards", async () => {
    const { ports } = mountActions(withActions);
    const button = (await screen.findByRole("button", { name: "Archive 2 messages" })) as HTMLButtonElement;
    fireEvent.click(button);
    await waitFor(() => expect(button.disabled).toBe(true));
    fireEvent.click(button);
    expect(ports.act).toHaveBeenCalledTimes(1);
    expect(ports.act).toHaveBeenCalledWith(actions[2]);
  });

  it("a failed action can be tried again and says why", async () => {
    const act = vi.fn(async () => {
      throw new Error("No archive folder");
    });
    mountActions(withActions, act);
    const button = (await screen.findByRole("button", { name: "Archive 2 messages" })) as HTMLButtonElement;
    fireEvent.click(button);
    expect((await screen.findByRole("alert")).textContent).toBe("No archive folder");
    expect(button.disabled).toBe(false);
  });

  it("no buttons without actions, without ports, or when nothing was found", async () => {
    mountActions(ANSWER);
    await screen.findByText(HOSTILE);
    expect(screen.queryByRole("group", { name: "What you can do next" })).toBeNull();
    cleanup();
    mount({ result: withActions });
    await screen.findByText(HOSTILE);
    expect(screen.queryByRole("group", { name: "What you can do next" })).toBeNull();
    cleanup();
    mountActions({ ...(withActions as Extract<AiResultView, { kind: "ask" }>), found: false, answer: "", sources: [] });
    await screen.findByText(ASK_NOT_FOUND);
    expect(screen.queryByRole("group", { name: "What you can do next" })).toBeNull();
  });
});

describe("runAskAct", () => {
  const action = {
    type: "act" as const,
    action: "archive" as const,
    groups: [
      { accountId: "acc-1", messageIds: ["m-1", "m-2"] },
      { accountId: "acc-2", messageIds: ["m-3"] },
    ],
    count: 3,
  };
  const page = () => ({ recordUndo: vi.fn(), refresh: vi.fn(), warn: vi.fn() });

  it("sends every account's messages as one batch with one Undo for what was done", async () => {
    const call = vi.fn(async () => ({ groups: [{ queued: 2, error: null }, { queued: 1, error: null }], undoable: true }));
    const p = page();
    await runAskAct({ call }, action, p, () => "undo-1");
    expect(call).toHaveBeenCalledTimes(1);
    expect(call).toHaveBeenCalledWith("message_action", { messageIds: ["m-1", "m-2", "m-3"], action: "archive", role: "inbox", undoId: "undo-1" });
    expect(p.recordUndo).toHaveBeenCalledTimes(1);
    expect(p.recordUndo).toHaveBeenCalledWith("undo-1", "archive", 3, null, true);
    expect(p.refresh).toHaveBeenCalledTimes(1);
    expect(p.warn).not.toHaveBeenCalled();
  });

  it("when part was refused, what was done keeps its Undo and the rest is said aside", async () => {
    const call = vi.fn(async () => ({ groups: [{ queued: 2, error: null }, { queued: 0, error: "These messages are no longer in Inbox" }], undoable: true }));
    const p = page();
    await runAskAct({ call }, action, p, () => "undo-1");
    expect(p.recordUndo).toHaveBeenCalledWith("undo-1", "archive", 2, null, true);
    expect(p.warn).toHaveBeenCalledWith("These messages are no longer in Inbox");
    expect(p.refresh).toHaveBeenCalledTimes(1);
  });

  it("fails when nothing was done", async () => {
    const call = vi.fn(async () => ({ groups: [{ queued: 0, error: "These messages are no longer in Inbox" }], undoable: false }));
    const p = page();
    await expect(runAskAct({ call }, action, p)).rejects.toThrow("These messages are no longer in Inbox");
    expect(p.recordUndo).not.toHaveBeenCalled();
    expect(p.refresh).not.toHaveBeenCalled();
  });
});

describe("AskPanel", () => {
  it("shows the phases, then the answer as text and the sources as links", async () => {
    const { calls, container, onOpen } = mount({ running: 1, result: ANSWER }, "acc-1");
    expect(screen.getByRole("status").textContent).toBe("Searching your mail\u2026");
    expect(await screen.findByText(HOSTILE)).toBeTruthy();
    expect(calls.start).toEqual([{ kind: "ask", question: "When is the meeting?", accountId: "acc-1" }]);
    expect(container.querySelector("a, b")).toBeNull();
    // Only source 2 was sent by the plugin; 5 is not linked.
    fireEvent.click(screen.getByRole("button", { name: "Message 2: open the conversation" }));
    expect(onOpen).toHaveBeenCalledWith(BASE.citations[1]);
    expect(screen.queryByText(/Message 5/)).toBeNull();
  });

  it("not found says so", async () => {
    mount({ result: { ...ANSWER, found: false, answer: "", sources: [] } });
    expect(await screen.findByText(ASK_NOT_FOUND)).toBeTruthy();
  });

  it("Close and Stop", async () => {
    const { onClose, calls } = mount({ running: 1000, result: ANSWER });
    await screen.findByRole("button", { name: "Stop" });
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(calls.cancel.length).toBeGreaterThanOrEqual(0);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalled();
  });
});
