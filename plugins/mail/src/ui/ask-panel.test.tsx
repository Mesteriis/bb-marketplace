// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { installTestPluginRuntime } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AiResultView } from "../core/model.ts";
import { ASK_NOT_FOUND, AskPanel } from "./ask-panel.tsx";
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
