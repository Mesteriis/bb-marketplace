// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { installTestPluginRuntime } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DevLinkView } from "../core/model.ts";
import { DevLinksStrip, linkLabel } from "./dev-links-strip.tsx";

installTestPluginRuntime();
afterEach(cleanup);

const PR: DevLinkView = {
  url: "https://github.com/example-org/demo/pull/42",
  kind: "pr",
  repo: { host: "github.com", path: "example-org/demo" },
  number: "42",
  projectId: "p-api",
};
const ISSUE: DevLinkView = { url: "https://gitlab.example.org/group/web/-/issues/7", kind: "issue", repo: { host: "gitlab.example.org", path: "group/web" }, number: "7", projectId: null };

function mount(inAiScope = true) {
  const props = { onOpen: vi.fn(), onOpenProject: vi.fn(), onNewThread: vi.fn() };
  render(<DevLinksStrip links={[PR, ISSUE]} projectName={(id) => (id === "p-api" ? "api" : id)} inAiScope={inAiScope} {...props} />);
  return props;
}

describe("DevLinksStrip", () => {
  it("lists each link by its URL with Open, and project actions when it maps to one", () => {
    const props = mount();
    const rows = within(screen.getByRole("list", { name: "Links" })).getAllByRole("listitem");
    expect(rows[0]!.textContent).toContain("PR #42 example-org/demo");
    expect(rows[0]!.textContent).toContain("(project api)");
    expect(rows[0]!.textContent).toContain(PR.url);
    fireEvent.click(within(rows[0]!).getByRole("button", { name: "Open" }));
    expect(props.onOpen).toHaveBeenCalledWith(PR.url);
    fireEvent.click(within(rows[0]!).getByRole("button", { name: "Open project" }));
    expect(props.onOpenProject).toHaveBeenCalledWith("p-api");
    fireEvent.click(within(rows[0]!).getByRole("button", { name: "New thread\u2026" }));
    expect(props.onNewThread).toHaveBeenCalledWith(PR);
    expect(within(rows[1]!).queryByRole("button", { name: "Open project" })).toBeNull();
  });

  it("New thread is off out of AI access", () => {
    mount(false);
    expect((screen.getByRole("button", { name: "New thread\u2026" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("labels commits, releases and tracker keys without #", () => {
    expect(linkLabel({ ...PR, kind: "commit", number: "0123456789abcdef" })).toBe("Commit 0123456 example-org/demo");
    expect(linkLabel({ ...PR, kind: "tracker", number: "ABC-1", repo: null })).toBe("Issue ABC-1");
  });
});
