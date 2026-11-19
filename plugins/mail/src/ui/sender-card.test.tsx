// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { installTestPluginRuntime } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RelatedHit, SenderCard } from "../core/index.ts";
import { RelatedMail, relatedReasonText } from "./related-mail.tsx";
import { SenderCardDialog, senderSummary } from "./sender-card.tsx";

installTestPluginRuntime();
afterEach(cleanup);

const card: SenderCard = {
  name: "Anna Example",
  address: "anna@example.org",
  fromCount: 48,
  toCount: 12,
  toCapped: false,
  firstDate: "2025-03-03T09:00:00.000Z",
  lastDate: null,
  conversations: [],
  files: [],
  imagesAllowed: false,
  blocked: false,
  projectId: null,
};

describe("SenderCardDialog", () => {
  it("summarizes the sender and runs its actions", () => {
    const actions = { onSearch: vi.fn(), onFiles: vi.fn(), onOpenConversation: vi.fn(), onAlwaysShowImages: vi.fn(), onBlock: vi.fn() };
    render(<SenderCardDialog address="anna@example.org" card={card} error={null} actions={actions} onClose={vi.fn()} />);
    expect(screen.getByText(senderSummary(card))).toBeTruthy();
    expect(senderSummary(card)).toMatch(/^48 from, 12 to \u00b7 since /);
    fireEvent.click(screen.getByRole("button", { name: "Search from this sender" }));
    expect(actions.onSearch).toHaveBeenCalledWith("anna@example.org");
    fireEvent.click(screen.getByRole("button", { name: "Files" }));
    expect(actions.onFiles).toHaveBeenCalledWith("anna@example.org");
    fireEvent.click(screen.getByRole("button", { name: "Always show images" }));
    expect(actions.onAlwaysShowImages).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Block\u2026" }));
    expect(actions.onBlock).toHaveBeenCalled();
  });

  it("offers a tab of the sender's mail only where the page gives the action", () => {
    const base = { onSearch: vi.fn(), onFiles: vi.fn(), onOpenConversation: vi.fn() };
    const { unmount } = render(<SenderCardDialog address="anna@example.org" card={card} error={null} actions={base} onClose={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Split by this sender" })).toBeNull();
    unmount();
    const onSplit = vi.fn();
    render(<SenderCardDialog address="anna@example.org" card={card} error={null} actions={{ ...base, onSplit }} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Split by this sender" }));
    expect(onSplit).toHaveBeenCalledTimes(1);
  });

  it("says when To was counted in recent mail only", () => {
    expect(senderSummary({ ...card, toCapped: true, firstDate: null })).toBe("48 from, 12 to (in recent mail)");
  });
});

const hit = (id: string, reasons: RelatedHit["reasons"]): RelatedHit => ({
  summary: {
    id,
    accountId: "acc-1",
    folder: "INBOX",
    threadId: `th-${id}`,
    date: "2026-11-10T08:00:00.000Z",
    from: { name: "Bo Example", address: "bo@example.org" },
    subject: `Subject ${id}`,
    snippet: "",
    isRead: true,
    isFlagged: false,
    hasAttachments: false,
    kept: null,
    labels: [],
  },
  reasons,
});

describe("RelatedMail", () => {
  it("loads on open and shows the reasons", async () => {
    const load = vi.fn(async () => [hit("a", [{ kind: "participants", count: 2 }, { kind: "terms", terms: ["INV-2041"] }])]);
    const onOpen = vi.fn();
    render(<RelatedMail messageId="m-1" load={load} onOpen={onOpen} />);
    expect(load).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /Related/ }));
    expect(await screen.findByText(/same people, mentions INV-2041/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Related \(1\)/ })).toBeTruthy();
    fireEvent.click(screen.getByText("Subject a"));
    expect(onOpen).toHaveBeenCalled();
    await waitFor(() => expect(load).toHaveBeenCalledTimes(1));
    expect(relatedReasonText({ kind: "reference" })).toBe("replies or refers to it");
    expect(relatedReasonText({ kind: "terms", terms: [] })).toBe("similar subject");
  });
});
