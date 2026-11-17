// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { installTestPluginRuntime } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ArchiveMessageView, ArchiveSummaryView, ArchiveView } from "../core/contract.ts";
import { ARCHIVE_ADD_COMMAND, ArchiveViewPage, type ArchivePorts } from "./archive-view.tsx";
import { parsePageSubPath, pageSubPath } from "./routes.ts";

installTestPluginRuntime();
afterEach(cleanup);

const archive = (id: string, overrides: Partial<ArchiveView> = {}): ArchiveView => ({
  id,
  name: `Invented ${id}`,
  sourcePath: `/invented/${id}.mbox`,
  kind: "mbox",
  messages: 3,
  skipped: 0,
  complete: true,
  createdAt: "2026-11-17T10:00:00.000Z",
  ...overrides,
});

const row = (id: string, overrides: Partial<ArchiveSummaryView> = {}): ArchiveSummaryView => ({
  id,
  archiveId: "arc_1",
  date: "2010-03-02T09:00:00.000Z",
  from: { name: "Ana Example", address: "ana@example.com" },
  subject: `Invented subject ${id}`,
  snippet: "Invented snippet",
  hasAttachments: false,
  ...overrides,
});

const message = (id: string, overrides: Partial<ArchiveMessageView> = {}): ArchiveMessageView => ({
  ...row(id),
  to: [{ name: null, address: "owner@example.org" }],
  cc: [],
  text: "Invented old words.",
  html: null,
  htmlTruncated: false,
  attachments: [],
  ...overrides,
});

function fakePorts(options: { archives?: ArchiveView[]; pages?: ArchiveSummaryView[][]; message?: ArchiveMessageView } = {}) {
  let archives = options.archives ?? [archive("arc_1")];
  const pages = options.pages ?? [[row("1"), row("2")]];
  return {
    archives: vi.fn(async () => archives),
    messages: vi.fn(async (_archiveId: string | null, query: string, cursor: { id: string } | null) => {
      if (query === "nothing") return { rows: [], nextCursor: null };
      const index = cursor === null ? 0 : Number(cursor.id);
      const rows = pages[index] ?? [];
      return { rows, nextCursor: index + 1 < pages.length ? { date: null, id: String(index + 1) } : null };
    }),
    message: vi.fn(async (id: string) => options.message ?? message(id)),
    download: vi.fn(async () => undefined),
    remove: vi.fn(async (id: string) => {
      archives = archives.filter((entry) => entry.id !== id);
    }),
  } satisfies ArchivePorts;
}

describe("ArchiveViewPage (slice 3p)", () => {
  it("without archives says how to add one, and asks for no messages", async () => {
    const ports = fakePorts({ archives: [] });
    render(<ArchiveViewPage ports={ports} onOpenLink={vi.fn()} />);
    expect(await screen.findByText("No archives yet.")).toBeTruthy();
    expect(screen.getByText(ARCHIVE_ADD_COMMAND)).toBeTruthy();
    expect(screen.queryByRole("search")).toBeNull();
    expect(screen.getByText(/agents cannot read it/)).toBeTruthy();
  });

  it("lists messages, loads more, searches, and narrows to one archive", async () => {
    const ports = fakePorts({
      archives: [archive("arc_1"), archive("arc_2", { name: "Second" })],
      pages: [[row("1", { hasAttachments: true }), row("2", { archiveId: "arc_2", subject: "" })], [row("3")]],
    });
    render(<ArchiveViewPage ports={ports} onOpenLink={vi.fn()} />);
    const list = await screen.findByRole("list", { name: "Archive messages" });
    const items = within(list).getAllByRole("listitem");
    expect(items[0]!.textContent).toContain("Ana Example <ana@example.com>");
    expect(items[0]!.textContent).toContain("Invented subject 1");
    expect(within(items[0]!).getByLabelText("Has attachments")).toBeTruthy();
    // In All archives a row names its archive.
    expect(items[1]!.textContent).toContain("(no subject)");
    expect(items[1]!.textContent).toContain("Second \u00b7 Invented snippet");
    fireEvent.click(screen.getByRole("button", { name: "Show more" }));
    await waitFor(() => expect(within(screen.getByRole("list", { name: "Archive messages" })).getAllByRole("listitem")).toHaveLength(3));
    expect(screen.queryByRole("button", { name: "Show more" })).toBeNull();

    fireEvent.change(screen.getByRole("textbox", { name: "Search the archive" }), { target: { value: " nothing " } });
    fireEvent.submit(screen.getByRole("search"));
    expect(await screen.findByText("Nothing in the archive matches.")).toBeTruthy();
    expect(ports.messages).toHaveBeenLastCalledWith(null, "nothing", null);
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    await screen.findByRole("list", { name: "Archive messages" });

    fireEvent.change(screen.getByRole("combobox", { name: "Which archive" }), { target: { value: "arc_2" } });
    await waitFor(() => expect(ports.messages).toHaveBeenLastCalledWith("arc_2", "", null));
    expect(within(screen.getByRole("group", { name: "About this archive" })).getByText("/invented/arc_2.mbox")).toBeTruthy();
  });

  it("opens a message read-only with its attachments, says the sender is not verified, and goes back", async () => {
    const ports = fakePorts({
      message: message("1", {
        subject: "Old <b>report</b>",
        cc: [{ name: "Bob", address: "bob@example.net" }],
        attachments: [
          { partId: "1", filename: "notes.txt", mimeType: "text/plain", size: 2048, isInline: false },
          { partId: "2", filename: "logo.png", mimeType: "image/png", size: 10, isInline: true },
        ],
      }),
    });
    render(<ArchiveViewPage ports={ports} onOpenLink={vi.fn()} />);
    fireEvent.click(within(await screen.findByRole("list", { name: "Archive messages" })).getAllByRole("button")[0]!);
    const pane = await screen.findByRole("region", { name: "Archive message" });
    expect(await within(pane).findByRole("heading", { name: "Old <b>report</b>" })).toBeTruthy();
    expect(pane.querySelector("b")).toBeNull();
    expect(within(pane).getByText("Bob <bob@example.net>")).toBeTruthy();
    expect(within(pane).getByRole("note").textContent).toContain("the sender is not verified");
    expect(within(pane).getByText("Invented old words.")).toBeTruthy();
    // Only the real attachment is offered, and nothing to reply, move or delete with.
    const files = within(within(pane).getByRole("list", { name: "Attachments" })).getAllByRole("button");
    expect(files).toHaveLength(1);
    expect(within(pane).queryByRole("button", { name: /reply|forward|delete|move/i })).toBeNull();
    fireEvent.click(files[0]!);
    await waitFor(() => expect(ports.download).toHaveBeenCalledWith("1", "1"));
    fireEvent.click(within(pane).getByRole("button", { name: "Back to the archive" }));
    expect(await screen.findByRole("list", { name: "Archive messages" })).toBeTruthy();
  });

  it("shows why an attachment could not be read, and an unfinished import", async () => {
    const ports = fakePorts({
      archives: [archive("arc_1", { complete: false, skipped: 2 })],
      message: message("1", { attachments: [{ partId: "1", filename: null, mimeType: "application/pdf", size: 5, isInline: false }] }),
    });
    ports.download.mockRejectedValueOnce(new Error("The archive's file has been moved or changed since the import; the message's text is kept, its attachments are not available."));
    render(<ArchiveViewPage ports={ports} onOpenLink={vi.fn()} />);
    await screen.findByRole("list", { name: "Archive messages" });
    fireEvent.change(screen.getByRole("combobox", { name: "Which archive" }), { target: { value: "arc_1" } });
    const about = await screen.findByRole("group", { name: "About this archive" });
    expect(about.textContent).toContain("2 left out");
    expect(about.textContent).toContain("The import did not finish");
    fireEvent.click(within(await screen.findByRole("list", { name: "Archive messages" })).getAllByRole("button")[0]!);
    fireEvent.click(await screen.findByRole("button", { name: "Download attachment" }));
    expect((await screen.findByRole("alert")).textContent).toContain("moved or changed");
  });

  it("removes an archive only after a second click, and reads the list again when told archives changed", async () => {
    const ports = fakePorts();
    const { rerender } = render(<ArchiveViewPage ports={ports} onOpenLink={vi.fn()} refresh={0} />);
    await screen.findByRole("list", { name: "Archive messages" });
    fireEvent.change(screen.getByRole("combobox", { name: "Which archive" }), { target: { value: "arc_1" } });
    fireEvent.click(await screen.findByRole("button", { name: "Remove archive" }));
    expect(ports.remove).not.toHaveBeenCalled();
    expect(screen.getByText("Remove this archive from Mail? The file it was read from stays.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Remove archive" }));
    await waitFor(() => expect(ports.remove).toHaveBeenCalledWith("arc_1"));
    expect(await screen.findByText("No archives yet.")).toBeTruthy();
    const calls = ports.archives.mock.calls.length;
    rerender(<ArchiveViewPage ports={ports} onOpenLink={vi.fn()} refresh={1} />);
    await waitFor(() => expect(ports.archives.mock.calls.length).toBeGreaterThan(calls));
  });
});

describe("the Archive route", () => {
  it("is a rail page of its own", () => {
    expect(pageSubPath("archive")).toBe("archive");
    expect(parsePageSubPath("archive")).toBe("archive");
    expect(parsePageSubPath("archives")).toBeNull();
  });
});
