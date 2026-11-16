// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { installTestPluginRuntime } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, describe, expect, it, vi } from "vitest";
import { aiErrorText } from "../core/ai-input.ts";
import { aiErrorKindSchema } from "../core/model.ts";
import { AI_ERROR_TEXT, useAiJob, type AiJobPorts } from "./ai-job.ts";
import { AiText, CitationChips, aiLabel, notesText } from "./ai-text.tsx";
import { BASE, HOSTILE, fakePorts } from "./testing/ai-fixtures.ts";

installTestPluginRuntime();
afterEach(cleanup);

describe("AI text", () => {
  it("renders model output with links, tags and Markdown as literal text", () => {
    const { container } = render(<AiText text={HOSTILE} />);
    expect(container.querySelector("a")).toBeNull();
    expect(container.querySelector("b")).toBeNull();
    expect(container.textContent).toBe(HOSTILE);
    expect(container.firstElementChild?.className).toContain("whitespace-pre-wrap");
  });

  it("removes invisible characters from model text", () => {
    const { container } = render(<AiText text={"a\u200bb\u2066c"} />);
    expect(container.textContent).toBe("abc");
  });

  it("citation chips open the mapped message and ignore unknown numbers", () => {
    const onCite = vi.fn();
    render(<CitationChips numbers={[2, 7, 2, 0]} citations={BASE.citations} onCite={onCite} />);
    const chips = screen.getAllByRole("button");
    expect(chips).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Open cited message 2" }));
    expect(onCite).toHaveBeenCalledWith(BASE.citations[1]);
  });

  it("labels and notes", () => {
    expect(aiLabel("p", "m")).toBe("AI \u00b7 p \u00b7 m");
    expect(aiLabel("p", "m", true)).toBe("AI \u00b7 p \u00b7 m \u00b7 cached");
    expect(aiLabel(null, "")).toBe("AI");
    expect(notesText({ hidden: 1, leftOut: 2, truncated: 0, unreadItems: 3 })).toEqual([
      "1 hidden value was not sent.",
      "2 messages outside AI access were left out.",
      "3 items of the answer could not be read.",
    ]);
  });

  it("the page's error texts are the core's", () => {
    for (const kind of aiErrorKindSchema.options) expect(AI_ERROR_TEXT[kind]).toBe(aiErrorText(kind));
  });
});

function JobProbe({ ports }: { ports: AiJobPorts }) {
  const { state, run, cancel } = useAiJob(ports, 0);
  return (
    <div>
      <p data-testid="state">{state.status === "failed" ? `failed:${state.text}` : state.status}</p>
      <button onClick={() => void run({ kind: "digest" })}>run</button>
      <button onClick={cancel}>cancel</button>
    </div>
  );
}

describe("useAiJob", () => {
  it("polls a running job to its result", async () => {
    const { ports, calls } = fakePorts({ running: 2, result: { kind: "digest", ...BASE, items: [] } });
    render(<JobProbe ports={ports} />);
    fireEvent.click(screen.getByText("run"));
    await waitFor(() => expect(screen.getByTestId("state").textContent).toBe("done"));
    expect(calls.poll).toHaveLength(3);
  });

  it("a refusal of ai_start shows the server's text", async () => {
    render(<JobProbe ports={fakePorts({ startError: "Outside AI access (Mail settings)" }).ports} />);
    fireEvent.click(screen.getByText("run"));
    await waitFor(() => expect(screen.getByTestId("state").textContent).toBe("failed:Outside AI access (Mail settings)"));
  });

  it("a failed job shows the kind's fixed text", async () => {
    render(<JobProbe ports={fakePorts({ error: "too_long" }).ports} />);
    fireEvent.click(screen.getByText("run"));
    await waitFor(() => expect(screen.getByTestId("state").textContent).toBe(`failed:${AI_ERROR_TEXT.too_long}`));
  });

  it("cancel stops the job on the server; unmount does too", async () => {
    const { ports, calls } = fakePorts({ running: 1000, result: { kind: "digest", ...BASE, items: [] } });
    const view = render(<JobProbe ports={ports} />);
    fireEvent.click(screen.getByText("run"));
    await waitFor(() => expect(calls.poll.length).toBeGreaterThan(0));
    fireEvent.click(screen.getByText("cancel"));
    expect(calls.cancel).toEqual(["job-1"]);
    expect(screen.getByTestId("state").textContent).toBe("cancelled");
    fireEvent.click(screen.getByText("run"));
    await waitFor(() => expect(calls.start).toHaveLength(2));
    await waitFor(() => expect(calls.poll.length).toBeGreaterThan(1));
    view.unmount();
    expect(calls.cancel).toEqual(["job-1", "job-2"]);
  });
});
