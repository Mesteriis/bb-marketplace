// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { installTestPluginRuntime } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ThreadSummary } from "../core/model.ts";
import { ThreadMailSection } from "./thread-mail-section.tsx";

installTestPluginRuntime();
afterEach(cleanup);

const thread = (id: string, unread = 0): ThreadSummary => ({
  id,
  accountId: "acc-1",
  subject: `Subject ${id}`,
  lastDate: null,
  messageCount: 1,
  unreadCount: unread,
  participants: [{ name: "Ada Example", address: "ada@example.org" }],
  snippet: "",
  flagged: false,
  snoozedUntil: null,
  category: null,
  categorySuggestion: null,
  projectId: "p-api",
});

describe("ThreadMailSection", () => {
  it("lists origin and bound conversations inside the host frame, with Open in Mail and Show all", async () => {
    const onOpen = vi.fn();
    const onShowAll = vi.fn();
    const frame = vi.fn((content: React.ReactNode, total: number) => <section aria-label={`Mail ${total}`}>{content}</section>);
    render(
      <ThreadMailSection
        load={async () => ({ bound: [thread("th-1", 1)], origin: [thread("th-0")], total: 7 })}
        onOpen={onOpen}
        onShowAll={onShowAll}
        frame={frame}
      />,
    );
    expect(await screen.findByRole("region", { name: "Mail 7" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Started from" }).textContent).toContain("Subject th-0");
    expect(screen.getByLabelText("Unread")).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: "Open in Mail" })[0]!);
    expect(onOpen).toHaveBeenCalledWith("acc-1", "th-0");
    fireEvent.click(screen.getByRole("button", { name: "Show all 7" }));
    expect(onShowAll).toHaveBeenCalled();
  });

  it("renders nothing, not even the frame, when there is no mail", async () => {
    const load = vi.fn(async () => ({ bound: [], origin: [], total: 0 }));
    const frame = vi.fn();
    const { container } = render(<ThreadMailSection load={load} onOpen={vi.fn()} onShowAll={vi.fn()} frame={frame} />);
    await waitFor(() => expect(load).toHaveBeenCalled());
    expect(container.innerHTML).toBe("");
    expect(frame).not.toHaveBeenCalled();
  });
});
