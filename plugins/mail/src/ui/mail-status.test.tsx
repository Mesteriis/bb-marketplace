// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MailStatusDialog,
  accountProblemTexts,
  accountsNeedingAttention,
  outboxStatusText,
  syncStatusLabel,
} from "./mail-status.tsx";

afterEach(cleanup);

const NOW = Date.parse("2026-11-17T12:00:00.000Z");
const account = (id: string, lastError: string | null, minutesAgo: number | null, authFailed = false) => ({
  id,
  email: `${id}@example.org`,
  displayName: null,
  lastError,
  authFailed,
  lastSyncAt: minutesAgo === null ? null : new Date(NOW - minutesAgo * 60_000).toISOString(),
});

describe("syncStatusLabel", () => {
  it("says offline quietly while only the network is down and the last sync is recent", () => {
    const offline = account("a", "Sync failed (ENOTFOUND)", 5);
    expect(syncStatusLabel([offline], false, NOW)).toMatch(/^Offline · synced /);
    expect(accountsNeedingAttention([offline], NOW)).toEqual([]);
  });

  it("turns a long outage and every other problem into a banner", () => {
    const long = account("a", "Sync failed (ENOTFOUND)", 45);
    const auth = account("b", "Authentication failed", 1, true);
    const fine = account("c", null, 1);
    expect(accountsNeedingAttention([long, auth, fine], NOW).map((a) => a.id)).toEqual(["a", "b"]);
    expect(syncStatusLabel([long], false, NOW)).toMatch(/^Synced /);
    expect(accountProblemTexts(auth)).toEqual(["The server refused the sign-in. Update the app password."]);
  });

  it("puts the BB link and a running sync first", () => {
    const fine = account("a", null, 1);
    expect(syncStatusLabel([fine], true, NOW, "reconnecting")).toBe("Reconnecting to BB…");
    expect(syncStatusLabel([fine], true, NOW)).toBe("Syncing…");
    expect(syncStatusLabel([account("a", null, null)], false, NOW)).toBe("Not synced yet");
    expect(syncStatusLabel([], false, NOW)).toBe("Not synced yet");
  });
});

describe("outboxStatusText", () => {
  it("counts waiting and stuck sends", () => {
    expect(outboxStatusText([])).toBeNull();
    expect(outboxStatusText([{ state: "done" }, { state: "sending" }])).toBeNull();
    expect(outboxStatusText([{ state: "waiting" }, { state: "waiting" }, { state: "failed" }])).toBe(
      "Outbox: 2 waiting to be sent, 1 not sent",
    );
  });
});

describe("MailStatusDialog", () => {
  it("lists each account with its problems and sends, and syncs on request", () => {
    const onSync = vi.fn();
    render(
      <MailStatusDialog
        open
        onOpenChange={() => undefined}
        accounts={[
          account("work", "Archive: could not update flags on the server", 3),
          account("home", "Sync failed (ENOTFOUND)", 4),
        ]}
        outbox={[{ accountId: "home", state: "waiting" }]}
        syncing={false}
        onSync={onSync}
        nowMs={NOW}
      />,
    );
    const work = screen.getByRole("listitem", { name: "work@example.org" });
    expect(work.textContent).toContain("Archive: Read and flag changes could not be saved on the server.");
    const home = screen.getByRole("listitem", { name: "home@example.org" });
    expect(home.textContent).toContain("offline, Mail keeps trying");
    expect(home.textContent).toContain("Outbox: 1 waiting to be sent");
    fireEvent.click(screen.getByRole("button", { name: "Sync now" }));
    expect(onSync).toHaveBeenCalledTimes(1);
  });
});
