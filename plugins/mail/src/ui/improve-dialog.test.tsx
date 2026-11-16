// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { installTestPluginRuntime } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AiResultView } from "../core/model.ts";
import { DRAFT_CHANGED_TEXT, ImproveDialog, ImproveMenu, MARKS_NOTICE, cleanInstruction, type ImproveRequest } from "./improve-dialog.tsx";
import { BASE, HOSTILE, fakePorts } from "./testing/ai-fixtures.ts";

installTestPluginRuntime();
afterEach(cleanup);

const REQUEST: ImproveRequest = {
  input: { kind: "draft", draftId: "draft-1", revision: 4, mode: "shorter", paragraphs: ["Hello Ada,", "I would like to send the plan today."] },
  hasMarks: false,
};
const RESULT: Extract<AiResultView, { kind: "draft" }> = {
  kind: "draft",
  ...BASE,
  paragraphs: ["Hello Ada,", "Sending the plan today."],
  unknown: 0,
  missing: 0,
};

function mount(result: AiResultView, request: ImproveRequest = REQUEST, onApply = vi.fn(() => true)) {
  const fake = fakePorts({ result });
  const onClose = vi.fn();
  render(<ImproveDialog request={request} ports={fake.ports} onApply={onApply} onClose={onClose} pollMs={0} />);
  return { ...fake, onApply, onClose };
}

describe("ImproveDialog", () => {
  it("sends the request and shows a word diff over the whole range", async () => {
    const { calls } = mount(RESULT);
    const changes = await screen.findByLabelText("Changes");
    expect(calls.start).toEqual([REQUEST.input]);
    expect(changes.querySelector("del")?.textContent).toContain("I would like to send");
    expect(changes.querySelector("ins")?.textContent).toContain("Sending");
    expect(changes.textContent).toContain("Hello Ada,");
    expect(screen.getByText("AI \u00b7 provider-x \u00b7 model-y")).toBeTruthy();
  });

  it("model text stays text in the diff", async () => {
    mount({ ...RESULT, paragraphs: [HOSTILE] });
    const changes = await screen.findByLabelText("Changes");
    expect(changes.querySelector("a, b")).toBeNull();
    expect(changes.textContent).toContain(HOSTILE);
  });

  it("notes hidden values kept, changed and missing, and the marks notice only with marks", async () => {
    mount({ ...RESULT, notes: { ...BASE.notes, hidden: 1 }, unknown: 1, missing: 1 });
    await screen.findByLabelText("Changes");
    expect(screen.getByText("1 hidden value kept.")).toBeTruthy();
    expect(screen.getByText("The model changed a hidden value; check it.")).toBeTruthy();
    expect(screen.getByText("A hidden value is no longer in the text.")).toBeTruthy();
    expect(screen.queryByText(MARKS_NOTICE)).toBeNull();
    cleanup();
    mount(RESULT, { ...REQUEST, hasMarks: true });
    expect(await screen.findByText(MARKS_NOTICE)).toBeTruthy();
  });

  it("Apply hands over the paragraphs and closes", async () => {
    const { onApply, onClose } = mount(RESULT);
    await screen.findByLabelText("Changes");
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(onApply).toHaveBeenCalledWith(["Hello Ada,", "Sending the plan today."]);
    expect(onClose).toHaveBeenCalled();
  });

  it("Apply is refused when the draft changed; Cancel changes nothing", async () => {
    const { onClose } = mount(RESULT, REQUEST, vi.fn(() => false));
    await screen.findByLabelText("Changes");
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect((await screen.findByRole("alert")).textContent).toBe(DRAFT_CHANGED_TEXT);
    expect(onClose).not.toHaveBeenCalled();
    expect((screen.getByRole("button", { name: "Apply" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("a refusal shows the server's text", async () => {
    const fake = fakePorts({ startError: "Improve works on up to 8 000 characters of your own text" });
    render(<ImproveDialog request={REQUEST} ports={fake.ports} onApply={vi.fn()} onClose={vi.fn()} pollMs={0} />);
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("8 000 characters"));
  });
});

describe("ImproveMenu", () => {
  it("offers the four modes and a one-line instruction without hidden characters", () => {
    const onPick = vi.fn();
    render(<ImproveMenu onPick={onPick} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Fix mistakes" }));
    expect(onPick).toHaveBeenLastCalledWith("fix");
    for (const [label, mode] of [["Shorter", "shorter"], ["More formal", "formal"], ["Friendlier", "friendly"]] as const) {
      fireEvent.click(screen.getByRole("button", { name: label }));
      expect(onPick).toHaveBeenLastCalledWith(mode);
    }
    fireEvent.change(screen.getByLabelText("Instruction for the AI"), { target: { value: "make it\u200b warmer" } });
    fireEvent.click(screen.getByRole("button", { name: "Go" }));
    expect(onPick).toHaveBeenLastCalledWith("custom", "make it warmer");
    expect(cleanInstruction("a\nb")).toBe("a b");
    expect(cleanInstruction("x".repeat(300))).toHaveLength(200);
  });
});
