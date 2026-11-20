// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { installTestPluginRuntime } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InboxSection } from "./inbox-section.tsx";
import type { InboxTabsPort, TabSettingView } from "./tabs-settings.tsx";

installTestPluginRuntime();
afterEach(cleanup);

function tabsPort(start: TabSettingView[], overrides: Partial<InboxTabsPort> = {}) {
  let tabs = start;
  const port: InboxTabsPort = {
    load: vi.fn(async () => tabs),
    save: vi.fn(async (input) => {
      tabs =
        input.id === undefined
          ? [...tabs, { id: `t-${tabs.length + 1}`, name: input.name, query: input.query, broken: false }]
          : tabs.map((tab) => (tab.id === input.id ? { ...tab, name: input.name, query: input.query } : tab));
    }),
    move: vi.fn(async () => {
      tabs = [...tabs].reverse();
    }),
    remove: vi.fn(async (id) => {
      tabs = tabs.filter((tab) => tab.id !== id);
    }),
    ...overrides,
  };
  return port;
}

const TWO: TabSettingView[] = [
  { id: "t-vip", name: "VIP", query: "from:vip", broken: false },
  { id: "t-old", name: "Old", query: "foo:bar", broken: true },
];

function show(port?: InboxTabsPort) {
  return render(<InboxSection accounts={[]} rules={[]} onUnblock={async () => {}} onChangeSnoozeFolder={undefined} {...(port ? { tabs: port } : {})} />);
}

const tabList = async () => within(await screen.findByRole("list", { name: "Inbox tabs" }));
const names = async () => (await tabList()).getAllByRole("listitem").map((el) => el.getAttribute("aria-label"));

describe("Inbox settings: Tabs", () => {
  it("has no Tabs group without the port", () => {
    show();
    expect(screen.queryByText("Tabs")).toBeNull();
  });

  it("lists the tabs with their conditions and marks a broken one", async () => {
    show(tabsPort(TWO));
    expect(await names()).toEqual(["VIP", "Old"]);
    const list = await tabList();
    expect(within(list.getByRole("listitem", { name: "VIP" })).getByText("from:vip")).toBeTruthy();
    expect(within(list.getByRole("listitem", { name: "Old" })).getByText("This tab's condition no longer works")).toBeTruthy();
  });

  it("says so when there are none and adds one from the library", async () => {
    const port = tabsPort([]);
    show(port);
    expect(await screen.findByText("No tabs yet: the Inbox is one list.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Add a tab…" }));
    fireEvent.click(await screen.findByRole("button", { name: "Team" }));
    await waitFor(() => expect(port.save).toHaveBeenCalledWith({ name: "Team", query: "from:team" }));
    expect(await names()).toEqual(["Team"]);
  });

  it("renames a tab and edits its condition; a refusal stays in the dialog", async () => {
    const port = tabsPort(TWO);
    show(port);
    fireEvent.click(await screen.findByRole("button", { name: "Rename VIP" }));
    fireEvent.change(await screen.findByRole("textbox", { name: "Name" }), { target: { value: "Bosses" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(port.save).toHaveBeenCalledWith({ id: "t-vip", name: "Bosses", query: "from:vip" }));
    expect(await names()).toEqual(["Bosses", "Old"]);

    (port.save as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("Unknown operator in the condition"));
    fireEvent.click(screen.getByRole("button", { name: "Edit the condition of Old" }));
    fireEvent.change(await screen.findByRole("textbox", { name: "Condition" }), { target: { value: "bar:baz" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Unknown operator in the condition");
    expect(port.save).toHaveBeenLastCalledWith({ id: "t-old", name: "Old", query: "bar:baz" });
  });

  it("orders and removes tabs; the ends cannot move further", async () => {
    const port = tabsPort(TWO);
    show(port);
    expect((await screen.findByRole("button", { name: "Move VIP up" })).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Move Old down" }).hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Move VIP down" }));
    await waitFor(() => expect(port.move).toHaveBeenCalledWith("t-vip", "right"));
    await waitFor(async () => expect(await names()).toEqual(["Old", "VIP"]));
    fireEvent.click(screen.getByRole("button", { name: "Remove Old" }));
    await waitFor(() => expect(port.remove).toHaveBeenCalledWith("t-old"));
    await waitFor(async () => expect(await names()).toEqual(["VIP"]));
  });

  it("shows why a change failed", async () => {
    const port = tabsPort(TWO, { remove: vi.fn(async () => Promise.reject(new Error("Store is closed"))) });
    show(port);
    fireEvent.click(await screen.findByRole("button", { name: "Remove VIP" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Store is closed");
    expect(await names()).toEqual(["VIP", "Old"]);
  });
});
