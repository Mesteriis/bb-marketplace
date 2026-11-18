// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { installTestPluginRuntime } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Account, FileRow } from "../core/index.ts";
import { FilesView, formatFileSize, type FilesFilter } from "./files-view.tsx";

installTestPluginRuntime();
afterEach(cleanup);

const account = (id: string, email: string): Account => ({
  id,
  email,
  displayName: null,
  preset: "other",
  host: "imap.example.org",
  port: 993,
  username: email,
  createdAt: "2026-11-01T09:00:00.000Z",
  lastSyncAt: null,
  lastError: null,
  authFailed: false,
  smtpConfigured: false,
});

const file = (n: number, overrides: Partial<FileRow> = {}): FileRow => ({
  messageId: `m-${n}`,
  partId: "2",
  filename: `report-${n}.pdf`,
  kind: "pdf",
  mimeType: "application/pdf",
  size: 2048 * n,
  date: "2026-11-10T08:00:00.000Z",
  from: { name: "Ada Example", address: "ada@example.org" },
  accountId: "acc-1",
  threadId: `th-${n}`,
  ...overrides,
});

function setup(pages: { files: FileRow[]; nextCursor: string | null }[], props: Partial<Parameters<typeof FilesView>[0]> = {}) {
  const calls: { filter: FilesFilter; cursor: string | null }[] = [];
  let at = 0;
  const load = vi.fn(async (filter: FilesFilter, cursor: string | null) => {
    calls.push({ filter, cursor });
    return pages[Math.min(at++, pages.length - 1)]!;
  });
  const handlers = { onView: vi.fn(), onDownload: vi.fn(), onOpenMessage: vi.fn() };
  render(
    <FilesView
      accounts={[account("acc-1", "owner@example.org")]}
      load={load}
      viewable={(row) => row.kind !== "archive"}
      {...handlers}
      {...props}
    />,
  );
  return { calls, handlers };
}

describe("FilesView", () => {
  it("lists files and pages with Load more", async () => {
    const { calls } = setup([
      { files: [file(1), file(2)], nextCursor: "c1" },
      { files: [file(3)], nextCursor: null },
    ]);
    await waitFor(() => expect(screen.getByText("report-1.pdf")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    await waitFor(() => expect(screen.getByText("report-3.pdf")).toBeTruthy());
    expect(calls.map((c) => c.cursor)).toEqual([null, "c1"]);
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
  });

  it("filters by type, junk, name and sender", async () => {
    const { calls } = setup([{ files: [file(1)], nextCursor: null }]);
    await waitFor(() => expect(calls).toHaveLength(1));
    fireEvent.click(screen.getByRole("button", { name: "Images" }));
    await waitFor(() => expect(calls.at(-1)!.filter).toEqual({ kind: "image" }));
    fireEvent.click(screen.getByRole("checkbox"));
    await waitFor(() => expect(calls.at(-1)!.filter).toEqual({ kind: "image", includeJunk: true }));
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: " invoice " } });
    fireEvent.change(screen.getByRole("textbox", { name: "From" }), { target: { value: "ada@example.org" } });
    fireEvent.click(screen.getByRole("button", { name: "Filter" }));
    await waitFor(() =>
      expect(calls.at(-1)!.filter).toEqual({ kind: "image", includeJunk: true, name: "invoice", sender: "ada@example.org" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "All" }));
    await waitFor(() => expect(calls.at(-1)!.filter).toEqual({ includeJunk: true, name: "invoice", sender: "ada@example.org" }));
  });

  it("offers View only for viewable rows and runs the row actions", async () => {
    const { handlers } = setup([{ files: [file(1), file(2, { kind: "archive", filename: "b.zip", mimeType: "application/zip" })], nextCursor: null }]);
    await waitFor(() => expect(screen.getByText("b.zip")).toBeTruthy());
    expect(screen.queryByRole("button", { name: "View b.zip" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "View report-1.pdf" }));
    fireEvent.click(screen.getByRole("button", { name: "Download b.zip" }));
    fireEvent.click(screen.getByRole("button", { name: "Open the message of b.zip" }));
    expect(handlers.onView).toHaveBeenCalledWith(expect.objectContaining({ messageId: "m-1" }));
    expect(handlers.onDownload).toHaveBeenCalledWith(expect.objectContaining({ messageId: "m-2" }));
    expect(handlers.onOpenMessage).toHaveBeenCalledWith(expect.objectContaining({ threadId: "th-2" }));
  });

  it("opens with the sender card's filter and shows the account column with several accounts", async () => {
    const { calls } = setup([{ files: [file(1)], nextCursor: null }], {
      initial: { sender: "ada@example.org" },
      accounts: [account("acc-1", "owner@example.org"), account("acc-2", "work@example.org")],
    });
    await waitFor(() => expect(calls[0]!.filter).toEqual({ sender: "ada@example.org" }));
    const table = await screen.findByRole("table");
    expect(within(table).getByText("owner@example.org")).toBeTruthy();
    expect(formatFileSize(2048)).toBe("2 KB");
  });
});
