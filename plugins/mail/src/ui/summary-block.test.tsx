// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { installTestPluginRuntime } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AiResultView } from "../core/model.ts";
import { AI_ERROR_TEXT } from "./ai-job.ts";
import { SummaryBlock } from "./summary-block.tsx";
import { BASE, HOSTILE, fakePorts, type FakeAnswer } from "./testing/ai-fixtures.ts";

installTestPluginRuntime();
afterEach(cleanup);

const SUMMARY: AiResultView = {
  kind: "summary",
  ...BASE,
  decisions: [{ text: HOSTILE, messages: [1, 9] }],
  questions: [{ text: "Who books the room?", messages: [2] }],
  deadlines: [{ text: "Send the draft", messages: [1], date: "2026-11-20" }],
};

function mount(answer: FakeAnswer) {
  const fake = fakePorts(answer);
  const onCite = vi.fn();
  const onClose = vi.fn();
  const view = render(
    <SummaryBlock ports={fake.ports} threadId="th-1" folder="INBOX" onCite={onCite} onClose={onClose} pollMs={0} />,
  );
  return { ...view, ...fake, onCite, onClose };
}

describe("SummaryBlock", () => {
  it("summarizes the conversation and shows the three groups as text", async () => {
    const { container, calls } = mount({ running: 1, result: SUMMARY });
    expect(screen.getByRole("status").textContent).toBe("Summarizing the conversation\u2026");
    expect(await screen.findByText("Decisions")).toBeTruthy();
    expect(calls.start).toEqual([{ kind: "summary", threadId: "th-1", folder: "INBOX" }]);
    expect(screen.getByText("Open questions")).toBeTruthy();
    expect(screen.getByText("Deadlines")).toBeTruthy();
    expect(screen.getByText(HOSTILE)).toBeTruthy();
    expect(container.querySelector("a, b")).toBeNull();
    expect(screen.getByText("AI \u00b7 provider-x \u00b7 model-y")).toBeTruthy();
    expect(screen.getByText("AI can be wrong; check the cited messages.")).toBeTruthy();
  });

  it("citations open the right message; unknown numbers have no chip", async () => {
    const { onCite } = mount({ result: SUMMARY });
    await screen.findByText("Decisions");
    // 1 twice (decision, deadline) and 2 once; 9 was not sent.
    expect(screen.getAllByRole("button", { name: /Open cited message/ })).toHaveLength(3);
    expect(screen.queryByRole("button", { name: "Open cited message 9" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open cited message 2" }));
    expect(onCite).toHaveBeenCalledWith(BASE.citations[1]);
  });

  it("a cached summary says so; a stale one offers Summarize again with force", async () => {
    const { calls } = mount({ cached: { ...SUMMARY, cached: true, stale: true } });
    expect(await screen.findByText("AI \u00b7 provider-x \u00b7 model-y \u00b7 cached")).toBeTruthy();
    expect(screen.getByText("The conversation has new messages since this summary.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Summarize again" }));
    await waitFor(() => expect(calls.start).toHaveLength(2));
    expect(calls.start[1]).toEqual({ kind: "summary", threadId: "th-1", folder: "INBOX", force: true });
  });

  it.each(["too_long", "unreadable", "busy", "gateway_missing"] as const)("a failed summary (%s) shows its text", async (kind) => {
    mount({ error: kind });
    expect((await screen.findByRole("alert")).textContent).toContain(AI_ERROR_TEXT[kind]);
  });

  it("a refusal shows the server's text, and Close closes", async () => {
    const { onClose } = mount({ startError: "Outside AI access (Mail settings)" });
    expect((await screen.findByRole("alert")).textContent).toContain("Outside AI access (Mail settings)");
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("notes say what was left out", async () => {
    mount({ result: { ...SUMMARY, notes: { hidden: 2, leftOut: 1, truncated: 0, unreadItems: 0 } } });
    expect(await screen.findByText("2 hidden values were not sent.")).toBeTruthy();
    expect(screen.getByText("1 message outside AI access was left out.")).toBeTruthy();
  });
});
