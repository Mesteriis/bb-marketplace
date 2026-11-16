// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { installTestPluginRuntime } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DevGroup } from "../core/contract.ts";
import { DevView, groupLine } from "./dev-view.tsx";

installTestPluginRuntime();
afterEach(cleanup);

const counts = { ci: 2, pr: 5, mr: 0, issue: 1, review: 0, release: 0, security: 0, alert: 0, other: 0 };
const group = (repo: string, overrides: Partial<DevGroup> = {}): DevGroup => ({
  source: "github",
  repo,
  counts,
  ciFailed: 2,
  latestFailure: { messageId: "m-1", subject: "Run failed: build / test", date: "2026-11-16T10:42:00.000Z" },
  unread: 3,
  total: 8,
  latestDate: "2026-11-16T10:42:00.000Z",
  messageIds: ["m-1", "m-2"],
  projectId: "p-api",
  projectName: "api",
  ...overrides,
});

describe("DevView", () => {
  it("groups by repository with counts, the latest failure and the project", async () => {
    const onOpenProject = vi.fn();
    render(<DevView load={async () => ({ groups: [group("example-org/demo")], next: null })} onAction={vi.fn()} onOpenProject={onOpenProject} />);
    const rows = within(await screen.findByRole("list", { name: "Repositories" })).getAllByRole("listitem");
    expect(rows[0]!.textContent).toContain("example-org/demo");
    expect(rows[0]!.textContent).toContain("2 CI failures \u00b7 5 PRs \u00b7 1 issue");
    expect(rows[0]!.textContent).toContain("Latest failure: Run failed: build / test");
    fireEvent.click(within(rows[0]!).getByRole("button", { name: "Project api" }));
    expect(onOpenProject).toHaveBeenCalledWith("p-api");
  });

  it("Mark read and Archive act on the group's messages, then reload", async () => {
    const load = vi.fn(async () => ({ groups: [group("example-org/demo")], next: null }));
    const onAction = vi.fn(async () => undefined);
    render(<DevView load={load} onAction={onAction} onOpenProject={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Archive" }));
    await waitFor(() => expect(onAction).toHaveBeenCalledWith(expect.objectContaining({ messageIds: ["m-1", "m-2"] }), "archive"));
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole("button", { name: "Mark read" }));
    await waitFor(() => expect(onAction).toHaveBeenLastCalledWith(expect.anything(), "mark_read"));
  });

  it("pages with Load more", async () => {
    const load = vi.fn(async (cursor: string | null) =>
      cursor === null ? { groups: [group("a/one")], next: "c-1" } : { groups: [group("b/two")], next: null },
    );
    render(<DevView load={load} onAction={vi.fn()} onOpenProject={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Load more" }));
    expect(await screen.findByText("b/two")).toBeTruthy();
    expect(load).toHaveBeenLastCalledWith("c-1");
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
  });

  it("says when there is nothing, and a monitoring group without a repository", async () => {
    expect(groupLine(group("x", { ciFailed: 0, counts: { ...counts, ci: 0, pr: 0, issue: 0, alert: 2 } }))).toBe("2 alerts");
    render(<DevView load={async () => ({ groups: [], next: null })} onAction={vi.fn()} onOpenProject={vi.fn()} />);
    expect(await screen.findByText("No dev notifications in the last 7 days.")).toBeTruthy();
  });
});
