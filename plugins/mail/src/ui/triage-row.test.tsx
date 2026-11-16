// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { installTestPluginRuntime } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, describe, expect, it, vi } from "vitest";
import { appliedText, TriageRow, type TriageStatus } from "./triage-row.tsx";

installTestPluginRuntime();
afterEach(cleanup);

function status(overrides: Partial<TriageStatus> = {}): TriageStatus {
  return {
    state: "applied",
    total: 12,
    approved: 10,
    done: 8,
    skipped: 1,
    failed: 0,
    rateLimited: 1,
    byAction: [
      { action: "archive", done: 5 },
      { action: "mark_read", done: 3 },
      { action: "unsubscribe", done: 0 },
      { action: "reply", done: 1 },
    ],
    undoable: true,
    ...overrides,
  };
}

async function mount(s: TriageStatus | Error, undo = vi.fn(async () => "Undone")) {
  const load = vi.fn(async () => {
    if (s instanceof Error) throw s;
    return s;
  });
  render(<TriageRow status={load} undo={undo} />);
  await act(async () => {
    await Promise.resolve();
  });
  return { undo, load };
}

describe("TriageRow", () => {
  it("says what was applied per group, skipped and rate-limited", () => {
    expect(appliedText(status())).toEqual({
      head: "Applied 9 of 12",
      groups: "archived 5 · marked read 3 · 1 reply approved",
      notes: ["1 skipped (moved since)", "1 rate-limited, try later"],
    });
    expect(appliedText(status({ byAction: [{ action: "unsubscribe", done: 2 }], skipped: 0, rateLimited: 0 })).notes).toEqual([
      "Unsubscribe requests cannot be undone here",
    ]);
  });

  it("Undo calls the batch's undo while the record lives, then reads again", async () => {
    const { undo, load } = await mount(status());
    expect(screen.getByText("Applied 9 of 12")).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    });
    expect(undo).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("status").textContent).toBe("Undone");
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("no Undo once the record is gone; a restart and other ends have their own line", async () => {
    await mount(status({ undoable: false }));
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
    cleanup();
    await mount(status({ state: "interrupted" }));
    expect(screen.getByText("A restart interrupted this; check your Inbox")).toBeTruthy();
    cleanup();
    await mount(status({ state: "changed" }));
    expect(screen.getByText("Not applied: the batch changed")).toBeTruthy();
    cleanup();
    await mount(new Error("not_found"));
    expect(screen.getByText("These inbox actions are no longer tracked here.")).toBeTruthy();
  });
});
