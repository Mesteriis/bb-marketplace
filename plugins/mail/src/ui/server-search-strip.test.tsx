// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { installTestPluginRuntime } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, describe, expect, it, vi } from "vitest";
import { accountLine, ServerSearchStrip, type ServerAccountView, type ServerJobView } from "./server-search-strip.tsx";

installTestPluginRuntime();
afterEach(cleanup);

const row = (overrides: Partial<ServerAccountView> = {}): ServerAccountView => ({
  accountId: "acc-1",
  searched: 4,
  total: 23,
  fetched: 0,
  found: 0,
  skipped: 0,
  partial: false,
  reason: null,
  ...overrides,
});

const job = (overrides: Partial<ServerJobView> = {}): ServerJobView => ({
  state: "running",
  accounts: [row()],
  messageIds: [],
  moreAvailable: false,
  ...overrides,
});

describe("accountLine", () => {
  it("shows progress, a partial stop and refusals", () => {
    expect(accountLine(row(), "running", "invoice", 0)).toBe("4 of 23 folders\u2026");
    expect(accountLine(row({ searched: 30, reason: "time_budget", partial: true }), "done", "invoice", 0)).toBe(
      "Stopped after 30 folders \u2014 narrow with in:",
    );
    expect(accountLine(row({ reason: "search_failed" }), "done", "\u0441\u0447\u0451\u0442", 0)).toBe(
      "This server could not search for this text",
    );
    expect(accountLine(row({ reason: "search_failed" }), "done", "invoice", 0)).toBe("The server refused the search");
    expect(accountLine(row({ found: 120 }), "done", "invoice", 50)).toBe("50 shown \u00b7 120 found");
    expect(accountLine(row({ found: 12 }), "done", "invoice", 12)).toBe("12 found");
  });
});

describe("ServerSearchStrip", () => {
  it("cancels while running", () => {
    const onCancel = vi.fn();
    render(
      <ServerSearchStrip job={job()} query="invoice" localOnly={[]} accountName={() => "iCloud"} shownFromServer={0} onCancel={onCancel} onMore={vi.fn()} />,
    );
    expect(screen.getByRole("status", { name: "Server search" }).textContent).toContain("iCloud: 4 of 23 folders\u2026");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "More from the server" })).toBeNull();
  });

  it("offers More from the server when done and more is there; says what was checked locally", () => {
    const onMore = vi.fn();
    render(
      <ServerSearchStrip
        job={job({ state: "done", moreAvailable: true, accounts: [row({ found: 120 })] })}
        query="invoice"
        localOnly={["label", "category"]}
        accountName={() => "Gmail"}
        shownFromServer={50}
        onCancel={vi.fn()}
        onMore={onMore}
      />,
    );
    expect(screen.getByText(/Gmail/).parentElement?.textContent).toContain("Gmail: 50 shown \u00b7 120 found");
    expect(screen.getByText("Checked in Mail only: label:, category:")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "More from the server" }));
    expect(onMore).toHaveBeenCalled();
  });

  it("says Stopped after a cancel", () => {
    render(
      <ServerSearchStrip job={job({ state: "cancelled" })} query="x" localOnly={[]} accountName={() => "iCloud"} shownFromServer={0} onCancel={vi.fn()} onMore={vi.fn()} />,
    );
    expect(screen.getByRole("status").textContent).toContain("iCloud: Stopped");
  });
});
