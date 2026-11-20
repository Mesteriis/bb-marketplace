// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { installTestPluginRuntime } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InboxTabs, type InboxTabView, type InboxTabsProps } from "./inbox-tabs.tsx";

installTestPluginRuntime();
afterEach(cleanup);

const tab = (overrides: Partial<InboxTabView> & { id: string; name: string }): InboxTabView => ({
  query: "from:vip",
  unread: 0,
  broken: false,
  ...overrides,
});

const LIBRARY = [
  { id: "vip", name: "VIP", query: "from:vip" },
  { id: "team", name: "Team", query: "from:team" },
  { id: "other", name: "Other", query: "is:other" },
];

function show(overrides: Partial<InboxTabsProps> = {}) {
  const props: InboxTabsProps = {
    tabs: [tab({ id: "t-vip", name: "VIP", unread: 2 }), tab({ id: "t-team", name: "Team", query: "from:team" })],
    currentId: null,
    inboxUnread: 23,
    library: LIBRARY,
    onSelect: vi.fn(),
    onAdd: vi.fn(async () => {}),
    onRename: vi.fn(async () => {}),
    onEdit: vi.fn(async () => {}),
    onMove: vi.fn(),
    onRemove: vi.fn(),
    ...overrides,
  };
  return { props, ...render(<InboxTabs {...props} />) };
}

describe("InboxTabs", () => {
  it("shows no row without tabs", () => {
    show({ tabs: [] });
    expect(screen.queryByRole("tablist")).toBeNull();
  });

  it("puts the Inbox tab first, with counts and none for zero", () => {
    show();
    const names = within(screen.getByRole("tablist", { name: "Inbox tabs" }))
      .getAllByRole("tab")
      .map((el) => el.textContent);
    expect(names).toEqual(["Inbox23 unread", "VIP2 unread", "Team"]);
  });

  it("marks the tab in view and selects another on a click", () => {
    const { props } = show({ currentId: "t-vip" });
    expect(screen.getByRole("tab", { name: /^VIP/ }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tab", { name: /^Inbox/ }).getAttribute("aria-selected")).toBe("false");
    fireEvent.click(screen.getByRole("tab", { name: "Team" }));
    expect(props.onSelect).toHaveBeenCalledWith("t-team");
    fireEvent.click(screen.getByRole("tab", { name: /^Inbox/ }));
    expect(props.onSelect).toHaveBeenLastCalledWith(null);
  });

  it("the library lists what is not added yet and adds one in a click", async () => {
    const { props } = show();
    fireEvent.click(screen.getByRole("button", { name: "Add a tab" }));
    const library = within(await screen.findByRole("list", { name: "Ready tabs" }));
    expect(library.getAllByRole("button").map((el) => el.textContent)).toEqual(["Other"]);
    fireEvent.click(library.getByRole("button", { name: "Other" }));
    await waitFor(() => expect(props.onAdd).toHaveBeenCalledWith({ name: "Other", query: "is:other" }));
  });

  it("a refused condition says why in the editor and stays open", async () => {
    const onAdd = vi.fn(async () => {
      throw new Error("Unknown operator in the condition");
    });
    show({ onAdd });
    fireEvent.click(screen.getByRole("button", { name: "Add a tab" }));
    fireEvent.click(await screen.findByRole("button", { name: "Your own condition…" }));
    fireEvent.change(await screen.findByRole("textbox", { name: "Name" }), { target: { value: "Words" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Condition" }), { target: { value: "foo:bar" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Unknown operator in the condition");
    expect(onAdd).toHaveBeenCalledWith({ name: "Words", query: "foo:bar" });
    expect(screen.getByRole("textbox", { name: "Condition" })).toBeTruthy();
  });

  it("a tab's menu renames, edits, moves and removes it", async () => {
    const { props } = show({ currentId: "t-vip" });
    const open = () => fireEvent.click(screen.getByRole("button", { name: "VIP options" }));
    open();
    fireEvent.click(await screen.findByRole("button", { name: "Move right" }));
    expect(props.onMove).toHaveBeenCalledWith("t-vip", "right");
    open();
    expect((await screen.findByRole("button", { name: "Move left" })).hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Rename…" }));
    fireEvent.change(await screen.findByRole("textbox", { name: "Name" }), { target: { value: "Bosses" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(props.onRename).toHaveBeenCalledWith("t-vip", "Bosses"));
    open();
    fireEvent.click(await screen.findByRole("button", { name: "Edit condition…" }));
    fireEvent.change(await screen.findByRole("textbox", { name: "Condition" }), { target: { value: "from:vip is:unread" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(props.onEdit).toHaveBeenCalledWith("t-vip", "from:vip is:unread"));
    open();
    fireEvent.click(await screen.findByRole("button", { name: "Remove tab" }));
    expect(props.onRemove).toHaveBeenCalledWith("t-vip");
  });

  it("a broken tab is marked and still removable", async () => {
    const { props } = show({
      tabs: [tab({ id: "t-old", name: "Old", query: "foo:bar", broken: true })],
      currentId: "t-old",
    });
    expect(screen.getByRole("tab", { name: /Old/ }).textContent).toContain("condition no longer works");
    fireEvent.click(screen.getByRole("button", { name: "Old options" }));
    fireEvent.click(await screen.findByRole("button", { name: "Remove tab" }));
    expect(props.onRemove).toHaveBeenCalledWith("t-old");
  });

  it("brings the tab in view, with its menu button, into the visible part of the row", () => {
    const seen: string[] = [];
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (this: Element) {
      seen.push(this.textContent ?? "");
    };
    try {
      const { props, rerender } = show({ currentId: "t-team" });
      expect(seen).toEqual(["Team"]);
      rerender(<InboxTabs {...props} currentId="t-vip" />);
      expect(seen).toEqual(["Team", "VIP2 unread"]);
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  });

  it("keeps only tabs in the tab list, and arrows move the focus along it", () => {
    show({ currentId: "t-vip" });
    const list = screen.getByRole("tablist", { name: "Inbox tabs" });
    expect(within(list).queryAllByRole("button")).toEqual([]);
    const [inbox, vip, team] = within(list).getAllByRole("tab") as [HTMLElement, HTMLElement, HTMLElement];
    expect([inbox, vip, team].map((el) => el.tabIndex)).toEqual([-1, 0, -1]);
    vip.focus();
    fireEvent.keyDown(vip, { key: "ArrowRight" });
    expect(document.activeElement).toBe(team);
    fireEvent.keyDown(team, { key: "ArrowRight" });
    expect(document.activeElement).toBe(inbox);
    fireEvent.keyDown(inbox, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(team);
    fireEvent.keyDown(team, { key: "Home" });
    expect(document.activeElement).toBe(inbox);
    fireEvent.keyDown(inbox, { key: "End" });
    expect(document.activeElement).toBe(team);
  });

  it("renders a name as text", () => {
    show({ tabs: [tab({ id: "t-x", name: "<img src=x onerror=alert(1)>" })] });
    expect(screen.getByRole("tab", { name: "<img src=x onerror=alert(1)>" })).toBeTruthy();
    expect(document.querySelector("img")).toBeNull();
  });

  it("opens the editor an outside request asks for", async () => {
    const { props, rerender } = show({ tabs: [] });
    rerender(<InboxTabs {...props} ask={{ serial: 1, request: { kind: "new", name: "Ada", query: "from:ada@example.com" } }} />);
    expect(((await screen.findByRole("textbox", { name: "Condition" })) as HTMLInputElement).value).toBe("from:ada@example.com");
    expect((screen.getByRole("textbox", { name: "Name" }) as HTMLInputElement).value).toBe("Ada");
  });
});
