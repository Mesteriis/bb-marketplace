// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { installTestPluginRuntime } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ThreadSummary } from "../core/model.ts";
import { ProjectsView } from "./projects-view.tsx";
import { PROJECTS } from "./testing/bb-fixtures.ts";

installTestPluginRuntime();
afterEach(cleanup);

const thread = (id: string): ThreadSummary => ({
  id,
  accountId: "acc-1",
  subject: `Subject ${id}`,
  lastDate: "2026-11-16T08:00:00.000Z",
  messageCount: 1,
  unreadCount: 0,
  participants: [{ name: "Ada Example", address: "ada@example.org" }],
  snippet: "",
  flagged: false,
  snoozedUntil: null,
  category: null,
  categorySuggestion: null,
  projectId: "p-api",
});

const lists = async () => ({
  projects: PROJECTS,
  bindings: [
    { kind: "domain" as const, value: "example.org", projectId: "p-api", projectName: "api", removed: false, createdAt: "2026-11-16T08:00:00.000Z" },
    { kind: "address" as const, value: "bo@example.org", projectId: "p-gone", projectName: null, removed: true, createdAt: "2026-11-16T08:00:00.000Z" },
  ],
});

type LoadMail = (projectId: string, cursor: string | null) => Promise<{ threads: ThreadSummary[]; next: string | null }>;

function mount(projectId: string | null, loadMail: LoadMail = vi.fn(async () => ({ threads: [thread("th-1")], next: null }))) {
  const props = { onSelectProject: vi.fn(), onOpen: vi.fn(), onOpenInBb: vi.fn() };
  render(<ProjectsView projectId={projectId} loadProjects={lists} loadMail={loadMail} {...props} />);
  return { ...props, loadMail };
}

describe("ProjectsView", () => {
  it("lists the projects with their binding rules, removed ones marked", async () => {
    const props = mount(null);
    const rows = within(await screen.findByRole("list", { name: "Projects" })).getAllByRole("listitem");
    expect(rows.map((r) => r.textContent)).toEqual(["api1 rule", "docs", "p-goneproject removed1 rule"]);
    fireEvent.click(within(rows[0]!).getByRole("button"));
    expect(props.onSelectProject).toHaveBeenCalledWith("p-api");
  });

  it("pages a project's bound conversations and opens one", async () => {
    const loadMail = vi.fn<LoadMail>(async (_id, cursor) =>
      cursor === null ? { threads: [thread("th-1")], next: "c-1" } : { threads: [thread("th-2")], next: null },
    );
    const props = mount("p-api", loadMail);
    expect(await screen.findByRole("heading", { name: "api" })).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: "Load more" }));
    expect(await screen.findByText("Subject th-2")).toBeTruthy();
    expect(loadMail).toHaveBeenLastCalledWith("p-api", "c-1");
    fireEvent.click(screen.getByText("Subject th-1"));
    expect(props.onOpen).toHaveBeenCalledWith("acc-1", "th-1");
    fireEvent.click(screen.getByRole("button", { name: "Open in BB" }));
    expect(props.onOpenInBb).toHaveBeenCalledWith("p-api");
  });

  it("an empty project says how to bind mail", async () => {
    mount("p-api", async () => ({ threads: [], next: null }));
    expect(await screen.findByText(/No conversation is bound to this project/)).toBeTruthy();
  });
});
