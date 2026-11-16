// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { installTestPluginRuntime } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MessageHeader, ThreadDetail } from "../core/model.ts";
import { alwaysChoices, ProjectChip } from "./project-chip.tsx";
import { PROJECTS } from "./testing/bb-fixtures.ts";

installTestPluginRuntime();
afterEach(cleanup);

const latest = {
  id: "m-1",
  from: { name: "Ada Example", address: "Ada@Example.org" },
  dev: null,
} as unknown as MessageHeader;

const detail = (overrides: Partial<ThreadDetail> = {}): ThreadDetail =>
  ({
    thread: { id: "th-1", accountId: "acc-1" },
    messages: [latest],
    project: null,
    projectSuggestion: null,
    ...overrides,
  }) as ThreadDetail;

function mount(d: ThreadDetail) {
  const props = { onSet: vi.fn(), onAlways: vi.fn(), onOpenProject: vi.fn() };
  render(<ProjectChip detail={d} projects={PROJECTS} {...props} />);
  return props;
}

describe("ProjectChip", () => {
  it("a suggestion is never bound by itself: Accept binds it", () => {
    const props = mount(detail({ projectSuggestion: { id: "p-api", name: "api", repo: "github.com/example-org/demo" } }));
    expect(screen.getByText("api?")).toBeTruthy();
    expect(props.onSet).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Accept" }));
    expect(props.onSet).toHaveBeenCalledWith("p-api");
  });

  it("Change offers Always for the sender, the domain and the repository", () => {
    const d = detail({ projectSuggestion: { id: "p-api", name: "api", repo: "github.com/example-org/demo" } });
    expect(alwaysChoices(d)).toEqual([
      { kind: "address", value: "ada@example.org" },
      { kind: "domain", value: "example.org" },
      { kind: "repo", value: "github.com/example-org/demo" },
    ]);
    const props = mount(d);
    fireEvent.click(screen.getByRole("button", { name: "Change" }));
    fireEvent.click(screen.getByRole("button", { name: "Always for example.org" }));
    expect(props.onAlways).toHaveBeenCalledWith({ kind: "domain", value: "example.org" }, "p-api");
  });

  it("a bound project opens, and the owner's binding can be removed", () => {
    const props = mount(detail({ project: { id: "p-api", name: "api", source: "owner" } }));
    fireEvent.click(screen.getByRole("button", { name: "api" }));
    expect(props.onOpenProject).toHaveBeenCalledWith("p-api");
    fireEvent.click(screen.getByRole("button", { name: "Change" }));
    fireEvent.click(screen.getByRole("button", { name: "Unbind" }));
    expect(props.onSet).toHaveBeenCalledWith(null);
  });
});
