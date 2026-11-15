// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { installTestPluginRuntime } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OutboxRow, OutboxState } from "../core/model.ts";
import { outboxActionLabel, outboxRowHint, outboxActions, outboxAttention, OutboxSection, outboxStateText } from "./outbox.tsx";

installTestPluginRuntime();
afterEach(cleanup);

function row(state: OutboxState, overrides: Partial<OutboxRow> = {}): OutboxRow {
  return {
    id: `out-${state}`,
    accountId: "acc-1",
    subject: `Made-up subject ${state}`,
    state,
    errorKind: null,
    rejected: [],
    sendAfter: "2026-11-15T10:00:10.000Z",
    attempts: 1,
    origin: "owner",
    ...overrides,
  };
}

describe("outboxActions", () => {
  it("offers exactly what the failure matrix allows per state", () => {
    expect(Object.fromEntries((["queued", "held", "sending", "sent", "appending", "failed", "unknown", "sent_no_copy", "done"] as const).map((s) => [s, outboxActions({ state: s })]))).toEqual({
      queued: ["undo"],
      held: ["send_now", "edit"],
      sending: [],
      sent: [],
      appending: [],
      failed: ["retry", "edit", "dismiss"],
      unknown: ["resend", "dismiss"],
      sent_no_copy: ["retry_copy", "dismiss"],
      done: [],
    });
  });

  it("a failed send can be edited (draft kept) or discarded (draft deleted), and says so", () => {
    expect(outboxActionLabel({ state: "failed" }, "edit")).toBe("Edit");
    expect(outboxActionLabel({ state: "failed" }, "dismiss")).toBe("Discard");
    expect(outboxRowHint({ state: "failed" })).toBe("Edit reopens the draft. Discard deletes the message and its draft.");
    expect(outboxRowHint({ state: "unknown" })).toBe("Discard deletes the message and its draft.");
    expect(outboxRowHint({ state: "sent_no_copy" })).toBeNull();
    expect(outboxRowHint({ state: "held" })).toBeNull();
  });

  it("never offers a resend except from unknown", () => {
    for (const state of ["queued", "held", "sending", "sent", "appending", "failed", "sent_no_copy", "done"] as const) {
      expect(outboxActions({ state })).not.toContain("resend");
    }
  });

  it("counts failed, unknown and held rows as needing the owner", () => {
    expect(outboxAttention([row("failed"), row("unknown"), row("held"), row("queued"), row("sending"), row("sent_no_copy")])).toBe(3);
  });

  it("describes a state with its reason kind, never server text", () => {
    expect(outboxStateText(row("failed", { errorKind: "rejected_all" }))).toBe("Not sent: recipients refused");
    expect(outboxStateText(row("failed", { errorKind: "temporary" }))).toBe("Not sent: the server asked to try again later");
    expect(outboxStateText(row("sent", { rejected: ["bo@example.org"] }))).toBe("Sent, but not to: bo@example.org");
    expect(outboxStateText(row("sent_no_copy", { errorKind: "no_sent_folder" }))).toBe("Sent; no Sent folder to copy to");
    expect(outboxStateText(row("unknown"))).toBe("May have been sent");
  });
});

describe("OutboxSection", () => {
  it("renders the rows with their buttons and reports the action", () => {
    const onAction = vi.fn();
    const rows = [row("unknown"), row("sent_no_copy"), row("done")];
    render(<OutboxSection rows={rows} onAction={onAction} pending={new Set(["out-sent_no_copy"])} marker={() => null} />);
    const section = screen.getByRole("region", { name: "Outbox" });
    expect(within(section).getAllByRole("listitem")).toHaveLength(2);
    const unknown = within(section).getByRole("listitem", { name: "Made-up subject unknown" });
    expect(within(unknown).getAllByRole("button").map((b) => b.textContent)).toEqual(["Send again", "Discard"]);
    fireEvent.click(within(unknown).getByRole("button", { name: "Send again" }));
    expect(onAction).toHaveBeenCalledWith(rows[0], "resend");
    const noCopy = within(section).getByRole("listitem", { name: "Made-up subject sent_no_copy" });
    expect(within(noCopy).getAllByRole("button").map((b) => b.textContent)).toEqual(["Retry copy", "Dismiss"]);
    expect((within(noCopy).getByRole("button", { name: "Dismiss" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("labels a send the owner confirmed in an agent's card", () => {
    render(
      <OutboxSection
        rows={[row("queued", { origin: "agent" }), row("held")]}
        onAction={() => undefined}
        pending={new Set()}
        marker={() => null}
      />,
    );
    const agent = screen.getByRole("listitem", { name: "Made-up subject queued" });
    expect(within(agent).getByText("Agent message")).toBeTruthy();
    const owner = screen.getByRole("listitem", { name: "Made-up subject held" });
    expect(within(owner).queryByText("Agent message")).toBeNull();
  });

  it("renders nothing without rows", () => {
    const { container } = render(<OutboxSection rows={[row("done")]} onAction={() => undefined} pending={new Set()} marker={() => null} />);
    expect(container.innerHTML).toBe("");
  });
});
