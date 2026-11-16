// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { installTestPluginRuntime } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TriageItemView, TriageView } from "../core/model.ts";
import { TriageCard, type TriageCardProps, type TriageViewResult } from "./triage-card.tsx";

installTestPluginRuntime();
afterEach(cleanup);

function item(position: number, action: TriageItemView["action"], overrides: Partial<TriageItemView> = {}): TriageItemView {
  return {
    position,
    messageId: `m-${position}`,
    accountId: "acc-1",
    accountEmail: "owner@example.org",
    action,
    snoozeUntil: action === "snooze" ? "2026-11-17T07:00:00.000Z" : null,
    note: null,
    fromName: `Sender ${position}`,
    fromAddress: `sender${position}@example.com`,
    subject: `Made-up subject ${position}`,
    date: "2026-11-15T09:00:00.000Z",
    folder: "Inbox",
    available: true,
    reason: null,
    unsubscribe: null,
    ...overrides,
  };
}

const VIEW: TriageView = {
  batchId: "batch-1",
  summary: "Cleared the newsletters",
  items: [
    item(1, "archive", { note: "Old receipt <a href='x'>link</a>" }),
    item(2, "archive"),
    item(3, "mark_read"),
    item(4, "snooze", { accountId: "acc-2", accountEmail: "two@example.org" }),
    item(5, "unsubscribe", { unsubscribe: { method: "one_click", host: "news.example.com", address: null } }),
    item(6, "spam", { available: false, reason: "Moved since the agent proposed it" }),
    item(7, "reply"),
  ],
  needsFolder: [{ accountId: "acc-2", accountEmail: "two@example.org", proposedName: "Snoozed" }],
  expiresAt: "2026-11-16T09:00:00.000Z",
};

async function mount(result: TriageViewResult | Error = { state: "ready", view: VIEW, viewToken: "tok-1" }, props: Partial<TriageCardProps> = {}) {
  const submit = vi.fn(async () => undefined);
  const cancel = vi.fn(async () => undefined);
  const load = vi.fn(async () => {
    if (result instanceof Error) throw result;
    return result;
  });
  render(<TriageCard load={load} submit={submit} cancel={cancel} {...props} />);
  await act(async () => {
    await Promise.resolve();
  });
  return { submit, cancel, load };
}

const box = (subject: string) => screen.getByRole("checkbox", { name: `Include ${subject}` });
const apply = () => screen.getByRole("button", { name: /^Apply/ }) as HTMLButtonElement;

describe("TriageCard", () => {
  it("groups by action with counts; every available item ticked but Unsubscribe; notes as plain agent text", async () => {
    await mount();
    expect(screen.getByRole("heading", { name: "Review 7 inbox actions" })).toBeTruthy();
    expect(screen.getByText("Cleared the newsletters")).toBeTruthy();
    expect(screen.getAllByRole("region").map((r) => r.getAttribute("aria-label"))).toEqual([
      "Snooze folders",
      "Archive",
      "Mark read",
      "Snooze",
      "Move to Spam",
      "Unsubscribe",
      "Reply",
    ]);
    expect(box("Made-up subject 1").getAttribute("aria-checked")).toBe("true");
    expect(box("Made-up subject 5").getAttribute("aria-checked")).toBe("false");
    expect(within(screen.getByRole("region", { name: "Unsubscribe" })).getByText("One click to news.example.com")).toBeTruthy();
    expect(within(screen.getByRole("region", { name: "Unsubscribe" })).getByText(/tells the sender this address is read/)).toBeTruthy();
    // The note is text: no link element.
    expect(screen.getByText("Agent's note")).toBeTruthy();
    expect(screen.getByText("Old receipt <a href='x'>link</a>")).toBeTruthy();
    expect(document.querySelector("a")).toBeNull();
    // Unavailable: disabled with the reason.
    expect((box("Made-up subject 6") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Moved since the agent proposed it")).toBeTruthy();
    // Archive 2, mark read 1, reply 1; the snooze waits for its folder.
    expect(apply().textContent).toBe("Apply 4");
  });

  it("the folder tick enables its snoozes and goes into the submit value with the positions", async () => {
    const { submit } = await mount();
    expect((box("Made-up subject 4") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("checkbox", { name: "Create a 'Snoozed' folder in two@example.org" }));
    expect((box("Made-up subject 4") as HTMLButtonElement).disabled).toBe(false);
    expect(box("Made-up subject 4").getAttribute("aria-checked")).toBe("true");
    fireEvent.click(box("Made-up subject 5"));
    fireEvent.click(box("Made-up subject 2"));
    expect(apply().textContent).toBe("Apply 5");
    await act(async () => {
      fireEvent.click(apply());
    });
    expect(submit).toHaveBeenCalledWith({ approved: [1, 3, 4, 5, 7], createSnoozeFolder: ["acc-2"] }, "tok-1");
  });

  it("a folder tick without its snooze creates nothing; Select none empties a group; Apply is off at 0", async () => {
    const { submit } = await mount();
    fireEvent.click(screen.getByRole("checkbox", { name: "Create a 'Snoozed' folder in two@example.org" }));
    fireEvent.click(box("Made-up subject 4"));
    for (const group of ["Archive", "Mark read", "Reply"]) {
      fireEvent.click(within(screen.getByRole("region", { name: group })).getByRole("button", { name: "Select none" }));
    }
    expect(apply().textContent).toBe("Apply 0");
    expect(apply().disabled).toBe(true);
    fireEvent.click(within(screen.getByRole("region", { name: "Archive" })).getByRole("button", { name: "Select all" }));
    await act(async () => {
      fireEvent.click(apply());
    });
    expect(submit).toHaveBeenCalledWith({ approved: [1, 2], createSnoozeFolder: [] }, "tok-1");
  });

  it("hidden characters are taken out of what the store and the agent wrote", async () => {
    await mount({
      state: "ready",
      view: { ...VIEW, items: [item(1, "archive", { subject: "Inv‮oice", note: "Pay​ now" })], needsFolder: [] },
      viewToken: "tok-1",
    });
    expect(screen.getByText("Invoice")).toBeTruthy();
    expect(screen.getByText("Pay now")).toBeTruthy();
  });

  it("never applies from the host's submit shortcut; Cancel is the host's cancel", async () => {
    let handler: ((action: string) => boolean) | null = null;
    const { submit, cancel } = await mount(undefined, {
      registerAction: (h) => {
        handler = h;
        return () => undefined;
      },
    });
    expect(handler!("submit")).toBe(false);
    expect(submit).not.toHaveBeenCalled();
    await act(async () => {
      expect(handler!("cancel")).toBe(true);
    });
    expect(cancel).toHaveBeenCalled();
  });

  it("a closed batch says so; a failed submit reloads the card for a new token", async () => {
    await mount({ state: "changed" });
    expect(screen.getByRole("alert").textContent).toContain("changed after the agent proposed it");
    cleanup();
    const submit = vi.fn(async () => {
      throw new Error("stale");
    });
    const load = vi.fn(async (): Promise<TriageViewResult> => ({ state: "ready", view: VIEW, viewToken: "tok-1" }));
    render(<TriageCard load={load} submit={submit} cancel={vi.fn()} />);
    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.click(apply());
    });
    expect(screen.getByRole("alert").textContent).toContain("Nothing was applied");
    expect(load).toHaveBeenCalledTimes(2);
  });
});
