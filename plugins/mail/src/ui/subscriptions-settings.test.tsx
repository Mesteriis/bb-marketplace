// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { installTestPluginRuntime } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SubscriptionView } from "../core/contract.ts";
import type { Account } from "../core/model.ts";
import {
  SubscriptionsSettings,
  outcomeText,
  subscriptionSelectable,
  type SettingsSubscriptionPorts,
  type SubscriptionOutcome,
} from "./subscriptions-settings.tsx";

installTestPluginRuntime();
afterEach(cleanup);

// Radix's checkbox measures itself; jsdom has no ResizeObserver.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const ACCOUNT: Account = {
  id: "acc_1",
  email: "owner@example.org",
  displayName: null,
  preset: "other",
  host: "imap.example.org",
  port: 993,
  username: "owner@example.org",
  createdAt: "2026-11-16T08:00:00.000Z",
  lastSyncAt: null,
  lastError: null,
  authFailed: false,
  smtpConfigured: true,
};

const list = (id: string, overrides: Partial<SubscriptionView> = {}): SubscriptionView => ({
  messageId: id,
  accountId: "acc_1",
  name: `Invented list ${id}`,
  address: `${id}@news.example.com`,
  total: 12,
  unread: 3,
  lastDate: "2026-11-16T08:00:00.000Z",
  method: "one_click",
  target: "lists.example.com",
  batch: true,
  mail: null,
  already: null,
  ...overrides,
});

function fakePorts(lists: SubscriptionView[], outcome: (id: string) => SubscriptionOutcome | Error = () => ({ outcome: "done", reason: null })) {
  return {
    list: vi.fn(async () => ({ subscriptions: lists, truncated: false })),
    run: vi.fn(async (messageId: string) => {
      const result = outcome(messageId);
      if (result instanceof Error) throw result;
      return result;
    }),
  } satisfies SettingsSubscriptionPorts;
}

const tick = (name: string) => fireEvent.click(screen.getByRole("checkbox", { name: `Unsubscribe from ${name}` }));

describe("SubscriptionsSettings (slice 3n)", () => {
  it("lists the lists with their counts; nothing is sent until the owner confirms the requests shown", async () => {
    const ports = fakePorts([
      list("a"),
      list("b", { method: "mailto", target: "leave@news.example.com", mail: { subject: "unsubscribe", body: "Invented words", hiddenChars: 0 } }),
    ]);
    render(<SubscriptionsSettings ports={ports} accounts={[ACCOUNT]} />);
    const rows = within(await screen.findByRole("list", { name: "Mailing lists" })).getAllByRole("listitem");
    expect(rows[0]!.textContent).toContain("Invented list a");
    expect(rows[0]!.textContent).toContain("12 messages");
    expect(rows[0]!.textContent).toContain("3 unread");
    expect((screen.getByRole("button", { name: "Unsubscribe" }) as HTMLButtonElement).disabled).toBe(true);
    tick("Invented list a");
    tick("Invented list b");
    fireEvent.click(screen.getByRole("button", { name: "Unsubscribe from 2 lists" }));
    const confirm = screen.getByRole("group", { name: "Confirm unsubscribing" });
    expect(within(confirm).getByText(/Unsubscribing tells the sender this address is read/)).toBeTruthy();
    const requests = within(within(confirm).getByRole("list", { name: "Requests to send" })).getAllByRole("listitem");
    expect(requests[0]!.textContent).toContain("one request to lists.example.com");
    expect(requests[1]!.textContent).toContain("an email to leave@news.example.com");
    // The exact email is shown before it is sent.
    expect(within(requests[1]!).getByText("Invented words")).toBeTruthy();
    expect(ports.run).not.toHaveBeenCalled();
    fireEvent.click(within(confirm).getByRole("button", { name: "Cancel" }));
    expect(ports.run).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Unsubscribe from 2 lists" }));
    fireEvent.click(within(screen.getByRole("group", { name: "Confirm unsubscribing" })).getByRole("button", { name: "Unsubscribe from 2 lists" }));
    await waitFor(() => expect(ports.run).toHaveBeenCalledTimes(2));
    expect(ports.run.mock.calls).toEqual([
      ["a", "one_click"],
      ["b", "mailto"],
    ]);
    await waitFor(() => expect(screen.getAllByRole("status").map((s) => s.textContent)).toEqual(["Unsubscribed", "Unsubscribed"]));
    await waitFor(() => expect(ports.list).toHaveBeenCalledTimes(2));
  });

  it("each request's outcome is shown on its row, a failure included, and the rest still run", async () => {
    const ports = fakePorts([list("a"), list("b"), list("c")], (id) =>
      id === "a" ? { outcome: "failed", reason: "timeout" } : id === "b" ? new Error("Too many sends in a minute") : { outcome: "queued", reason: null },
    );
    render(<SubscriptionsSettings ports={ports} accounts={[ACCOUNT]} />);
    await screen.findByRole("list", { name: "Mailing lists" });
    for (const id of ["a", "b", "c"]) tick(`Invented list ${id}`);
    fireEvent.click(screen.getByRole("button", { name: "Unsubscribe from 3 lists" }));
    fireEvent.click(within(screen.getByRole("group", { name: "Confirm unsubscribing" })).getByRole("button", { name: "Unsubscribe from 3 lists" }));
    await waitFor(() =>
      expect(screen.getAllByRole("status").map((s) => s.textContent)).toEqual([
        "Could not unsubscribe: the list did not answer",
        "Too many sends in a minute",
        "The email is in the Outbox",
      ]),
    );
  });

  it("a list that is settled, has no trusted way, or mails another domain cannot be ticked; at most 10 are", async () => {
    const many = Array.from({ length: 11 }, (_, i) => list(`n${i}`));
    const ports = fakePorts([
      list("done", { already: { state: "done", at: "2026-11-10T08:00:00.000Z" } }),
      list("none", { method: null, target: null, batch: false }),
      list("foreign", { method: "mailto", target: "leave@elsewhere.example.net", batch: false, mail: { subject: "unsubscribe", body: "", hiddenChars: 0 } }),
      list("failed", { already: { state: "failed", at: "2026-11-10T08:00:00.000Z" } }),
      ...many,
    ]);
    render(<SubscriptionsSettings ports={ports} accounts={[ACCOUNT]} />);
    await screen.findByRole("list", { name: "Mailing lists" });
    const box = (id: string) => screen.getByRole("checkbox", { name: `Unsubscribe from Invented list ${id}` }) as HTMLButtonElement;
    expect(box("done").disabled).toBe(true);
    expect(box("none").disabled).toBe(true);
    expect(box("foreign").disabled).toBe(true);
    expect(box("failed").disabled).toBe(false);
    expect(screen.getByText("No way to unsubscribe that Mail can trust.")).toBeTruthy();
    expect(screen.getByText(/not at the sender's domain/)).toBeTruthy();
    expect(screen.getByText(/^Unsubscribed /)).toBeTruthy();
    for (let i = 0; i < 10; i++) tick(`Invented list n${i}`);
    expect(box("n10").disabled).toBe(true);
    expect(box("failed").disabled).toBe(true);
    expect(screen.getByRole("button", { name: "Unsubscribe from 10 lists" })).toBeTruthy();
  });

  it("renders a hostile list name as text, without its invisible characters", async () => {
    const ports = fakePorts([list("x", { name: "<img src=x onerror=alert(1)>\u202eevil" })]);
    render(<SubscriptionsSettings ports={ports} accounts={[ACCOUNT]} />);
    expect(await screen.findByText("<img src=x onerror=alert(1)>evil")).toBeTruthy();
    expect(document.querySelector("img")).toBeNull();
  });
});

describe("subscription helpers", () => {
  it("say what a request did and which lists can be ticked", () => {
    expect(outcomeText({ outcome: "redirected", reason: null })).toMatch(/redirect/);
    expect(outcomeText({ outcome: "failed", reason: null })).toBe("Could not unsubscribe: the request failed");
    expect(subscriptionSelectable(list("a"))).toBe(true);
    expect(subscriptionSelectable(list("a", { already: { state: "queued", at: "2026-11-10T08:00:00.000Z" } }))).toBe(false);
    expect(subscriptionSelectable(list("a", { already: { state: "cancelled", at: "2026-11-10T08:00:00.000Z" } }))).toBe(true);
  });
});
