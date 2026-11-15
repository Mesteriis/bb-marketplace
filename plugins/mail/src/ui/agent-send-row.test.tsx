// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { installTestPluginRuntime } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OutboxRow } from "../core/model.ts";
import { AgentSendRow, type AgentSendRowProps, type ProposalStatus } from "./agent-send-row.tsx";

installTestPluginRuntime();
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const NOW = Date.parse("2026-11-15T10:00:00.000Z");

function outboxRow(overrides: Partial<OutboxRow> = {}): OutboxRow {
  return {
    id: "prop-1",
    accountId: "acc-1",
    subject: "Made-up subject",
    state: "queued",
    errorKind: null,
    rejected: [],
    sendAfter: "2026-11-15T10:00:08.000Z",
    attempts: 0,
    origin: "agent",
    ...overrides,
  };
}

function statusOf(overrides: Partial<ProposalStatus> = {}): ProposalStatus {
  return { state: "queued", outboxId: "prop-1", draftId: "draft-9", reason: null, ...overrides };
}

async function mount(s: ProposalStatus | Error, row: OutboxRow | null, props: Partial<AgentSendRowProps> = {}) {
  const undo = vi.fn(async () => true);
  const openDraft = vi.fn();
  const status = vi.fn(async () => {
    if (s instanceof Error) throw s;
    return s;
  });
  const outbox = vi.fn(async () => row);
  const utils = render(
    <AgentSendRow status={status} outbox={outbox} undo={undo} openDraft={openDraft} now={() => NOW} {...props} />,
  );
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  return { ...utils, undo, openDraft, status, outbox };
}

describe("AgentSendRow", () => {
  it("counts down a queued send with Undo, which cancels by the proposal's outbox id", async () => {
    const { undo, status } = await mount(statusOf(), outboxRow());
    expect(screen.getByText("Sending in 8 s")).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    });
    expect(undo).toHaveBeenCalledWith("prop-1");
    expect(status).toHaveBeenCalledTimes(2);
  });

  it("says when it was too late to undo", async () => {
    await mount(statusOf(), outboxRow(), { undo: async () => false });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    });
    expect(screen.getByRole("alert").textContent).toBe("Too late to undo");
  });

  it("reads Sent once the outbox row is gone", async () => {
    await mount(statusOf(), null);
    expect(screen.getByText("Sent")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  });

  it("shows a failed send's state without Undo", async () => {
    await mount(statusOf(), outboxRow({ state: "failed", errorKind: "auth" }));
    expect(screen.getByText(/Not sent: sign-in refused/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  });

  it.each([
    ["rate_limited", "Not sent · too many messages were sent in the last minute"],
    ["too_large", "Not sent · the attachments are over the size limit"],
    ["account", "Not sent · the account needs attention in Mail"],
  ] as const)("a confirmed card that could not be queued (%s) offers its draft", async (reason, text) => {
    const { openDraft } = await mount(statusOf({ state: "opened", outboxId: null, reason }), null);
    expect(screen.getByText(text)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open in Mail" }));
    expect(openDraft).toHaveBeenCalledWith("draft-9");
  });

  it("an opened or undone proposal is an ordinary draft to open", async () => {
    await mount(statusOf({ state: "opened", outboxId: null }), null);
    expect(screen.getByText("Not sent · kept as a draft in Mail")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open in Mail" })).toBeTruthy();
  });

  it.each([
    ["refused", "Not sent: the proposal changed"],
    ["cancelled", "Cancelled. Nothing was sent."],
    ["expired", "Expired. Nothing was sent."],
  ] as const)("%s reads as not sent, with no buttons", async (state, text) => {
    await mount(statusOf({ state, outboxId: null, draftId: null }), null);
    expect(screen.getByText(text)).toBeTruthy();
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });

  it("says when the proposal is no longer stored", async () => {
    await mount(new Error("not_found"), null);
    expect(screen.getByText(/no longer tracked/)).toBeTruthy();
  });

  it("reads again when the outbox changes", async () => {
    const { status, rerender, undo, openDraft, outbox } = await mount(statusOf(), outboxRow());
    rerender(<AgentSendRow status={status} outbox={outbox} undo={undo} openDraft={openDraft} now={() => NOW} version={1} />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(status).toHaveBeenCalledTimes(2);
  });
});
