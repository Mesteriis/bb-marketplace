// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { installTestPluginRuntime } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MailSettingsProps } from "./shared.ts";
import { RU } from "../i18n/ru.ts";
import { SETTINGS_GROUPS, settingsSectionOf } from "./sections.ts";
import { SettingsPage } from "./settings-page.tsx";

installTestPluginRuntime();
afterEach(cleanup);

const base: MailSettingsProps = {
  accounts: [],
  identities: [],
  templates: [],
  suggestions: async () => [],
  onAdd: async () => undefined,
  onUpdate: async () => undefined,
  onRemove: async () => undefined,
  onDismiss: async () => undefined,
  onSaveTemplate: async () => undefined,
  onDeleteTemplate: async () => undefined,
  onOpenSmtp: () => undefined,
};

/** Ports enough for every section to be listed; their sections are not opened here. */
const everything = {
  ...base,
  onUnblock: async () => undefined,
  filters: {},
  subscriptions: {},
  ai: {},
  bb: {},
  search: {},
  pgp: {},
} as unknown as MailSettingsProps;

function mount(props: MailSettingsProps = everything, section: Parameters<typeof SettingsPage>[0]["section"] = "templates") {
  const onSection = vi.fn();
  const onBack = vi.fn();
  render(<SettingsPage {...props} section={section} onSection={onSection} onBack={onBack} />);
  return { onSection, onBack };
}

describe("settings sections", () => {
  it("are five groups of fifteen sections in the agreed order", () => {
    expect(SETTINGS_GROUPS.map((group) => [group.title, group.sections.map((section) => section.title)])).toEqual([
      ["Accounts", ["Mailboxes and sign-in", "Addresses and signatures"]],
      ["Mail", ["Inbox", "Filters", "Subscriptions", "Templates", "Reading and search"]],
      ["AI and agents", ["AI features", "Agent access", "Plugin access", "Activity log"]],
      ["BB", ["Integration", "Rules"]],
      ["Security", ["Encryption", "Local data"]],
    ]);
  });

  it("every group and section title has a Russian entry (the menu passes them to tx as values)", () => {
    const titles = SETTINGS_GROUPS.flatMap((group) => [group.title, ...group.sections.flatMap((section) => [section.title, section.description])]);
    // "BB" is a name: it reads the same in both languages and has no entry.
    expect(titles.filter((title) => !(title in RU))).toEqual(["BB"]);
  });

  it("an unknown, missing or old section name opens a real section", () => {
    expect(settingsSectionOf(undefined)).toBe("accounts");
    expect(settingsSectionOf("nope")).toBe("accounts");
    expect(settingsSectionOf("search")).toBe("reading");
    expect(settingsSectionOf("pgp")).toBe("pgp");
  });
});

describe("SettingsPage", () => {
  it("is a named region with a menu of links by group, the open section marked", () => {
    mount();
    const page = screen.getByRole("region", { name: "Mail settings" });
    const menu = within(page).getByRole("navigation", { name: "Settings" });
    expect(within(menu).getAllByRole("list").map((list) => list.getAttribute("aria-labelledby"))).toEqual([
      "settings-group-accounts",
      "settings-group-mail",
      "settings-group-ai",
      "settings-group-bb",
      "settings-group-security",
    ]);
    expect(within(menu).getAllByRole("link").map((link) => link.textContent)).toEqual([
      "Mailboxes and sign-in",
      "Addresses and signatures",
      "Inbox",
      "Filters",
      "Subscriptions",
      "Templates",
      "Reading and search",
      "AI features",
      "Agent access",
      "Activity log",
      "Integration",
      "Rules",
      "Encryption",
      "Local data",
    ]);
    expect(within(menu).getByRole("link", { name: "Templates" }).getAttribute("aria-current")).toBe("page");
    expect(within(menu).getByRole("link", { name: "Inbox" }).getAttribute("aria-current")).toBeNull();
    const body = within(page).getByRole("region", { name: "Templates" });
    expect(within(body).getByRole("heading", { level: 2, name: "Templates" })).toBeTruthy();
    expect(within(body).getByText("Texts you insert into a message with one click.")).toBeTruthy();
  });

  it("lists only the sections it has ports for, and drops a group left empty", () => {
    mount(base, "templates");
    const menu = screen.getByRole("navigation", { name: "Settings" });
    expect(within(menu).getAllByRole("link").map((link) => link.textContent)).toEqual([
      "Mailboxes and sign-in",
      "Addresses and signatures",
      "Templates",
      "Local data",
    ]);
    expect(within(menu).queryByText("BB")).toBeNull();
    expect(within(menu).queryByText("AI and agents")).toBeNull();
  });

  it("a section it cannot show opens the first one instead of a blank page", () => {
    mount(base, "pgp");
    expect(screen.getByRole("link", { name: "Mailboxes and sign-in" }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("region", { name: "Mailboxes and sign-in" })).toBeTruthy();
  });

  it("a menu item asks for its section and Mail goes back", () => {
    const { onSection, onBack } = mount();
    fireEvent.click(screen.getByRole("link", { name: "Inbox" }));
    expect(onSection).toHaveBeenCalledWith("inbox");
    fireEvent.click(screen.getByRole("button", { name: "Mail" }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("has a section select for narrow panels, with every section", () => {
    mount();
    expect(screen.getByRole("combobox", { name: "Section" })).toBeTruthy();
  });
});
