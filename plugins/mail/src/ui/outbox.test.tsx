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
  it("labels the plugin's unsubscribe email and never offers Edit for it", () => {
    expect(outboxActions({ state: "held", purpose: "unsubscribe" })).toEqual(["send_now"]);
    expect(outboxActions({ state: "failed", purpose: "unsubscribe" })).toEqual(["retry", "dismiss"]);
    expect(outboxActions({ state: "queued", purpose: "unsubscribe" })).toEqual(["undo"]);
    expect(outboxRowHint({ state: "failed", purpose: "unsubscribe" })).toBe("Discard deletes the request.");
    render(<OutboxSection rows={[row("failed", { purpose: "unsubscribe", subject: "unsubscribe" })]} onAction={vi.fn()} pending={new Set()} marker={() => null} />);
    const item = screen.getByRole("listitem", { name: "Unsubscribe request" });
    expect(within(item).queryByRole("button", { name: "Edit" })).toBeNull();
    expect(within(item).getByRole("button", { name: "Retry" })).toBeTruthy();
  });

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

describe("a waiting send (slice 3j)", () => {
  it("offers Send now, Edit and Discard and says when Mail tries again", () => {
    const waiting = row("waiting", { errorKind: "connect", attempts: 2, sendAfter: "2026-11-17T10:42:00.000Z" });
    expect(outboxActions(waiting)).toEqual(["send_now", "edit", "dismiss"]);
    const text = outboxStateText(waiting);
    expect(text).toMatch(/^Not sent yet: the server could not be reached\. Next try at .+ \(try 3\)\.$/);
    expect(outboxRowHint(waiting)).toBe("Edit reopens the draft. Discard deletes the message and its draft.");
    // Waiting is not yet a problem for the owner to fix.
    expect(outboxAttention([waiting])).toBe(0);
  });

  it("has a text without a time when the date does not parse", () => {
    expect(outboxStateText({ state: "waiting", errorKind: null, rejected: [], sendAfter: "nope" })).toBe(
      "Not sent yet. Mail will try again.",
    );
  });
});

describe("a scheduled send (slice 3l)", () => {
  it("says when it goes out and offers Edit only", () => {
    const scheduled = row("queued", { scheduled: true, sendAfter: "2027-03-04T09:00:00.000Z" });
    expect(outboxActions(scheduled)).toEqual(["edit"]);
    expect(outboxStateText(scheduled)).toMatch(/^Scheduled for .*\d{2}:\d{2}/);
    expect(outboxRowHint(scheduled)).toBe("Edit cancels the send and reopens the draft.");
    expect(outboxAttention([scheduled])).toBe(0);
    // An ordinary queued send keeps its Undo.
    expect(outboxActions(row("queued"))).toEqual(["undo"]);
    expect(outboxStateText(row("queued"))).toBe("Sending soon");
  });

  it("held because its time passed says so and can be sent now or edited", () => {
    const held = row("held", { scheduled: true });
    expect(outboxStateText(held)).toBe("Not sent: its time passed while BB was closed");
    expect(outboxActions(held)).toEqual(["send_now", "edit"]);
    expect(outboxAttention([held])).toBe(1);
  });
});
