// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { installTestPluginRuntime } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AiResultView } from "../core/model.ts";
import { WRITE_CHANGED_TEXT, WriteDialog, writeNotes, type WriteInput } from "./write-dialog.tsx";
import { BASE, HOSTILE, fakePorts } from "./testing/ai-fixtures.ts";

installTestPluginRuntime();
afterEach(cleanup);

const input = (instruction: string): WriteInput => ({ kind: "write", draftId: "draft-1", revision: 4, instruction, paragraphs: [] });
const RESULT: Extract<AiResultView, { kind: "write" }> = {
  kind: "write",
  ...BASE,
  paragraphs: ["Hello Ada,", "Tuesday works for me."],
  linksRemoved: 0,
  unknown: 0,
};

function mount(result: AiResultView, onInsert = vi.fn(() => true)) {
  const fake = fakePorts({ result });
  const onClose = vi.fn();
  const prepare = vi.fn(async (instruction: string): Promise<WriteInput | null> => input(instruction));
  render(<WriteDialog open ports={fake.ports} prepare={prepare} onInsert={onInsert} onClose={onClose} pollMs={0} />);
  return { ...fake, prepare, onInsert, onClose };
}

const ask = (text: string) => {
  fireEvent.change(screen.getByLabelText("What should the message say?"), { target: { value: text } });
  fireEvent.click(screen.getByRole("button", { name: "Write" }));
};

describe("WriteDialog", () => {
  it("Write is off until something is asked; the request goes as one clean line", async () => {
    const { calls, prepare } = mount(RESULT);
    expect((screen.getByRole("button", { name: "Write" }) as HTMLButtonElement).disabled).toBe(true);
    ask("  agree to \t Tuesday​ ");
    const text = await screen.findByLabelText("Written text");
    expect(prepare).toHaveBeenCalledWith("agree to Tuesday");
    expect(calls.start).toEqual([input("agree to Tuesday")]);
    expect(text.textContent).toBe("Hello Ada,\n\nTuesday works for me.");
    expect(screen.getByText("AI · provider-x · model-y")).toBeTruthy();
  });

  it("Insert hands over the paragraphs and closes", async () => {
    const { onInsert, onClose } = mount(RESULT);
    ask("agree");
    await screen.findByLabelText("Written text");
    fireEvent.click(screen.getByRole("button", { name: "Insert" }));
    expect(onInsert).toHaveBeenCalledWith(["Hello Ada,", "Tuesday works for me."]);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Insert is refused when the draft changed", async () => {
    const { onClose } = mount(RESULT, vi.fn(() => false));
    ask("agree");
    await screen.findByLabelText("Written text");
    fireEvent.click(screen.getByRole("button", { name: "Insert" }));
    expect(screen.getByRole("alert").textContent).toBe(WRITE_CHANGED_TEXT);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("Try again sends the request once more", async () => {
    const { calls } = mount(RESULT);
    ask("agree");
    await screen.findByLabelText("Written text");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(calls.start).toHaveLength(2));
  });

  it("nothing is sent when the draft could not be saved", async () => {
    const fake = fakePorts({ result: RESULT });
    render(<WriteDialog open ports={fake.ports} prepare={async () => null} onInsert={() => true} onClose={() => {}} pollMs={0} />);
    ask("agree");
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("The draft could not be saved; try again."));
    expect(fake.calls.start).toEqual([]);
  });

  it("model text stays text", async () => {
    mount({ ...RESULT, paragraphs: [HOSTILE] });
    ask("agree");
    const text = await screen.findByLabelText("Written text");
    expect(text.querySelector("img, script, a")).toBeNull();
  });
});

describe("writeNotes", () => {
  it("says what was hidden, removed and left out", () => {
    expect(writeNotes({ ...RESULT, linksRemoved: 2, unknown: 1, notes: { ...RESULT.notes, hidden: 1, leftOut: 3 } })).toEqual([
      "1 hidden value was not sent to the AI.",
      "2 links you did not write were removed.",
      "3 messages outside AI access were not read.",
      "The model wrote a hidden value of its own; check it.",
    ]);
    expect(writeNotes(RESULT)).toEqual([]);
  });
});
