// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { installTestPluginRuntime } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Account, IdentityView } from "../../core/model.ts";
import { useState } from "react";
import { sendCheckText, type MailSettingsProps, type TemplateView } from "./shared.ts";
import { SettingsPage } from "./settings-page.tsx";
import type { SettingsSectionId } from "./sections.ts";

installTestPluginRuntime();
afterEach(cleanup);

const proto = Element.prototype as unknown as Record<string, unknown>;
proto.scrollIntoView ??= () => {};
proto.hasPointerCapture ??= () => false;
proto.releasePointerCapture ??= () => {};

const account: Account = {
  id: "acc-1",
  email: "owner@example.org",
  displayName: "Owner Example",
  preset: "other",
  host: "imap.example.org",
  port: 993,
  username: "owner@example.org",
  createdAt: "2026-11-01T09:00:00.000Z",
  lastSyncAt: null,
  lastError: null,
  authFailed: false,
  smtpConfigured: true,
};

const paragraph = (text: string) => ({ type: "paragraph", content: [{ type: "text", text }] });

function identity(overrides: Partial<IdentityView>): IdentityView {
  return {
    accountId: "acc-1",
    address: "owner@example.org",
    displayName: "Owner Example",
    primary: true,
    signature: null,
    sendCheck: "unknown",
    ...overrides,
  };
}

const IDENTITIES: IdentityView[] = [
  // The alias first on purpose: the own address still comes first.
  identity({ address: "team@example.org", displayName: "Team", primary: false, sendCheck: "rewritten" }),
  identity({ signature: { type: "doc", content: [paragraph("Owner, made-up signature")] } }),
  identity({ address: "old@example.org", displayName: null, primary: false, sendCheck: "refused" }),
];

const TEMPLATES: TemplateView[] = [
  { id: "tpl-1", name: "Thanks", doc: { type: "doc", content: [paragraph("Thank you, invented text.")] }, updatedAt: "2026-11-10T09:00:00.000Z" },
];

/** The page with its section kept as the address would keep it. */
function Page({ start, ...props }: MailSettingsProps & { start: SettingsSectionId }) {
  const [section, setSection] = useState<SettingsSectionId>(start);
  return <SettingsPage {...props} section={section} onSection={setSection} onBack={() => undefined} />;
}

function mount({ section = "addresses", ...overrides }: Partial<MailSettingsProps> & { section?: SettingsSectionId } = {}) {
  const props: MailSettingsProps = {
    accounts: [account],
    identities: IDENTITIES,
    templates: TEMPLATES,
    suggestions: vi.fn(async () => [{ address: "me@example.com", count: 3, lastDate: "2026-11-12T09:00:00.000Z" }]),
    onAdd: vi.fn(async () => undefined),
    onUpdate: vi.fn(async () => undefined),
    onRemove: vi.fn(async () => undefined),
    onDismiss: vi.fn(async () => undefined),
    onSaveTemplate: vi.fn(async () => undefined),
    onDeleteTemplate: vi.fn(async () => undefined),
    onOpenSmtp: vi.fn(),
    ...overrides,
  };
  render(<Page {...props} start={section} />);
  return props;
}

const rows = () => within(screen.getByRole("list", { name: "Sending addresses" })).getAllByRole("listitem");

describe("MailSettings: Google sign-in of an account", () => {
  it("offers the switch to a Gmail account that uses an app password", () => {
    const onGoogleSwitch = vi.fn();
    mount({ accounts: [{ ...account, preset: "gmail" }], onGoogleSwitch });
    fireEvent.click(screen.getByRole("button", { name: "Switch to Google sign-in" }));
    expect(onGoogleSwitch).toHaveBeenCalledWith(expect.objectContaining({ id: account.id, preset: "gmail" }));
  });

  it("says a Google account is signed in with Google, and offers nothing elsewhere", () => {
    mount({ accounts: [{ ...account, preset: "gmail", authKind: "google" }], onGoogleSwitch: vi.fn() });
    expect(screen.getByText("Signed in with Google")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Switch to Google sign-in" })).toBeNull();
    cleanup();
    mount({ accounts: [{ ...account, preset: "icloud" }], onGoogleSwitch: vi.fn() });
    expect(screen.queryByRole("button", { name: "Switch to Google sign-in" })).toBeNull();
    cleanup();
    mount({ accounts: [{ ...account, preset: "gmail" }] });
    expect(screen.queryByRole("button", { name: "Switch to Google sign-in" })).toBeNull();
  });
});

describe("MailSettings: sending addresses", () => {
  it("lists the own address first, then the aliases, with their names, signature and send state", async () => {
    mount();
    const items = rows();
    expect(items.map((item) => item.getAttribute("aria-label"))).toEqual([
      "owner@example.org",
      "team@example.org",
      "old@example.org",
    ]);
    expect(within(items[0]!).getByText("Own address")).toBeTruthy();
    expect(within(items[0]!).getByText("Owner, made-up signature")).toBeTruthy();
    expect(within(items[0]!).queryByRole("button", { name: "Remove" })).toBeNull();
    expect(within(items[0]!).queryByRole("button", { name: "Rename" })).toBeNull();
    expect(within(items[1]!).getByText("Alias")).toBeTruthy();
    expect(within(items[1]!).getByText("Team")).toBeTruthy();
    expect(within(items[1]!).getByText(sendCheckText("rewritten")!)).toBeTruthy();
    expect(within(items[2]!).getByText(sendCheckText("refused")!)).toBeTruthy();
    expect(within(items[0]!).queryByRole("status")).toBeNull();
    expect(sendCheckText("confirmed")).toBeNull();
    expect(sendCheckText("pending")).toBeNull();
    await screen.findByText("me@example.com");
  });

  it("adds an address with an optional name for the shown account", async () => {
    const props = mount();
    fireEvent.change(screen.getByLabelText("Address"), { target: { value: "sales@example.org" } });
    fireEvent.change(screen.getByLabelText("Name (optional)"), { target: { value: "Sales" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Add address" }));
    });
    expect(props.onAdd).toHaveBeenCalledWith({ accountId: "acc-1", address: "sales@example.org", displayName: "Sales" });
    expect((screen.getByLabelText("Address") as HTMLInputElement).value).toBe("");
  });

  it("shows a refusal of Add inline", async () => {
    mount({ onAdd: vi.fn(async () => Promise.reject(new Error("This is the account's own address"))) });
    fireEvent.change(screen.getByLabelText("Address"), { target: { value: "owner@example.org" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Add address" }));
    });
    expect(screen.getByRole("alert").textContent).toBe("This is the account's own address");
  });

  it("renames an alias and clears its name", async () => {
    const props = mount();
    const team = rows()[1]!;
    fireEvent.click(within(team).getByRole("button", { name: "Rename" }));
    fireEvent.change(within(team).getByLabelText("Name for team@example.org"), { target: { value: "Team Desk" } });
    await act(async () => {
      fireEvent.click(within(team).getByRole("button", { name: "Save name" }));
    });
    expect(props.onUpdate).toHaveBeenCalledWith({ accountId: "acc-1", address: "team@example.org", displayName: "Team Desk" });
    fireEvent.click(within(team).getByRole("button", { name: "Rename" }));
    fireEvent.change(within(team).getByLabelText("Name for team@example.org"), { target: { value: "  " } });
    await act(async () => {
      fireEvent.click(within(team).getByRole("button", { name: "Save name" }));
    });
    expect(props.onUpdate).toHaveBeenLastCalledWith({ accountId: "acc-1", address: "team@example.org", displayName: null });
  });

  it("saves a signature for the address it belongs to", async () => {
    const props = mount();
    const team = rows()[1]!;
    fireEvent.click(within(team).getByRole("button", { name: "Add signature" }));
    expect(within(team).getByRole("textbox", { name: "Signature for team@example.org" })).toBeTruthy();
    await act(async () => {
      fireEvent.click(within(team).getByRole("button", { name: "Save signature" }));
    });
    // An empty editor clears the signature.
    expect(props.onUpdate).toHaveBeenCalledWith({ accountId: "acc-1", address: "team@example.org", signature: null });

    const own = rows()[0]!;
    fireEvent.click(within(own).getByRole("button", { name: "Edit signature" }));
    await act(async () => {
      fireEvent.click(within(own).getByRole("button", { name: "Save signature" }));
    });
    expect(props.onUpdate).toHaveBeenLastCalledWith({
      accountId: "acc-1",
      address: "owner@example.org",
      signature: expect.objectContaining({ type: "doc" }),
    });
  });

  it("removes an alias only after the confirmation", async () => {
    const props = mount();
    const team = rows()[1]!;
    fireEvent.click(within(team).getByRole("button", { name: "Remove" }));
    expect(props.onRemove).not.toHaveBeenCalled();
    const confirm = within(team).getByRole("alertdialog", { name: "Remove team@example.org" });
    fireEvent.click(within(confirm).getByRole("button", { name: "Cancel" }));
    expect(props.onRemove).not.toHaveBeenCalled();
    fireEvent.click(within(team).getByRole("button", { name: "Remove" }));
    await act(async () => {
      fireEvent.click(within(within(team).getByRole("alertdialog")).getByRole("button", { name: "Remove" }));
    });
    expect(props.onRemove).toHaveBeenCalledWith({ accountId: "acc-1", address: "team@example.org" });
  });

  it("suggestions show the count and date, Add only fills the form, Not mine dismisses", async () => {
    const props = mount();
    const list = await screen.findByRole("list", { name: "Suggestions" });
    expect(props.suggestions).toHaveBeenCalledWith("acc-1");
    expect(within(list).getByText(/^3 messages · last \S/)).toBeTruthy();
    fireEvent.click(within(list).getByRole("button", { name: "Add me@example.com" }));
    expect((screen.getByLabelText("Address") as HTMLInputElement).value).toBe("me@example.com");
    expect(props.onAdd).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(within(list).getByRole("button", { name: "me@example.com is not mine" }));
    });
    expect(props.onDismiss).toHaveBeenCalledWith({ accountId: "acc-1", address: "me@example.com" });
    await waitFor(() => expect(screen.queryByRole("list", { name: "Suggestions" })).toBeNull());
    expect(props.onAdd).not.toHaveBeenCalled();
  });

  it("links to the account's SMTP dialog", () => {
    const props = mount();
    fireEvent.click(screen.getByRole("button", { name: "SMTP settings…" }));
    expect(props.onOpenSmtp).toHaveBeenCalledWith("acc-1");
  });
});

describe("MailSettings: templates", () => {
  const toTemplates = () => fireEvent.click(screen.getByRole("link", { name: "Templates" }));

  it("creates a template with a name and text, without a quote button", async () => {
    const props = mount();
    toTemplates();
    fireEvent.click(screen.getByRole("button", { name: "New template" }));
    const form = screen.getByRole("form", { name: "New template" });
    expect(within(form).queryByRole("button", { name: "Quote" })).toBeNull();
    expect(within(form).getByRole("button", { name: "Bulleted list" })).toBeTruthy();
    fireEvent.change(within(form).getByLabelText("Name"), { target: { value: "Follow-up" } });
    // An empty template is refused before any call.
    await act(async () => {
      fireEvent.click(within(form).getByRole("button", { name: "Save template" }));
    });
    expect(props.onSaveTemplate).not.toHaveBeenCalled();
    expect(within(form).getByRole("alert").textContent).toBe("Write the template's text.");
  });

  it("renames a template through Edit, and shows the duplicate-name refusal inline", async () => {
    const refusal = "A template with this name already exists";
    const onSaveTemplate = vi.fn(async (input: { name: string }) => {
      if (input.name === "Taken") throw new Error(refusal);
    });
    mount({ onSaveTemplate });
    toTemplates();
    fireEvent.click(screen.getByRole("button", { name: "Edit Thanks" }));
    const form = screen.getByRole("form", { name: "Edit Thanks" });
    fireEvent.change(within(form).getByLabelText("Name"), { target: { value: "Taken" } });
    await act(async () => {
      fireEvent.click(within(form).getByRole("button", { name: "Save template" }));
    });
    expect(within(form).getByRole("alert").textContent).toBe(refusal);
    fireEvent.change(within(form).getByLabelText("Name"), { target: { value: "Thanks a lot" } });
    await act(async () => {
      fireEvent.click(within(form).getByRole("button", { name: "Save template" }));
    });
    expect(onSaveTemplate).toHaveBeenLastCalledWith({
      id: "tpl-1",
      name: "Thanks a lot",
      doc: expect.objectContaining({ type: "doc" }),
    });
    expect(screen.queryByRole("form", { name: "Edit Thanks" })).toBeNull();
  });

  it("deletes a template only after the confirmation", async () => {
    const props = mount();
    toTemplates();
    fireEvent.click(screen.getByRole("button", { name: "Delete Thanks" }));
    expect(props.onDeleteTemplate).not.toHaveBeenCalled();
    const confirm = screen.getByRole("alertdialog", { name: "Delete Thanks" });
    await act(async () => {
      fireEvent.click(within(confirm).getByRole("button", { name: "Delete" }));
    });
    expect(props.onDeleteTemplate).toHaveBeenCalledWith("tpl-1");
  });
});

describe("MailSettings: Inbox (slice 3e)", () => {
  const RULES = [
    { id: "rule-1", kind: "address" as const, value: "promo@shop.example.com", createdAt: "2026-11-15T09:00:00.000Z" },
    { id: "rule-2", kind: "domain" as const, value: "spam.example.net", createdAt: "2026-11-14T09:00:00.000Z" },
  ];

  it("has no Inbox section without the ports", () => {
    mount();
    expect(screen.queryByRole("link", { name: "Inbox" })).toBeNull();
  });

  it("lists blocked senders with kind and date; Unblock asks first and says Spam stays", async () => {
    const onUnblock = vi.fn(async () => undefined);
    mount({ section: "inbox", blockRules: RULES, onUnblock, onChangeSnoozeFolder: vi.fn() });
    const list = within(screen.getByRole("list", { name: "Blocked senders" }));
    expect(list.getAllByRole("listitem").map((li) => li.getAttribute("aria-label"))).toEqual([
      "promo@shop.example.com",
      "spam.example.net",
    ]);
    expect(within(list.getByRole("listitem", { name: "spam.example.net" })).getByText("Domain")).toBeTruthy();
    expect(screen.getByText(/Mail already in Spam stays there\./)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Unblock promo@shop.example.com" }));
    expect(onUnblock).not.toHaveBeenCalled();
    const confirm = within(screen.getByRole("alertdialog", { name: "Unblock promo@shop.example.com" }));
    expect(confirm.getByText(/Mail already in Spam stays there/)).toBeTruthy();
    await act(async () => {
      fireEvent.click(confirm.getByRole("button", { name: "Unblock" }));
    });
    expect(onUnblock).toHaveBeenCalledWith("rule-1");
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  });

  it("shows each account's snoozed folder with Change…", () => {
    const onChangeSnoozeFolder = vi.fn();
    mount({
      section: "inbox",
      accounts: [{ ...account, snoozeFolder: "Snoozed" }, { ...account, id: "acc-2", email: "two@example.org", displayName: null }],
      blockRules: [],
      onUnblock: vi.fn(async () => undefined),
      onChangeSnoozeFolder,
    });
    expect(screen.getByText("No blocked senders. Block one from a message's toolbar.")).toBeTruthy();
    const folders = within(screen.getByRole("list", { name: "Snoozed folders" }));
    expect(within(folders.getByRole("listitem", { name: "Owner Example" })).getByText("Snoozed")).toBeTruthy();
    expect(within(folders.getByRole("listitem", { name: "two@example.org" })).getByText("None yet; the first snooze asks")).toBeTruthy();
    fireEvent.click(folders.getByRole("button", { name: "Change the snoozed folder of two@example.org" }));
    expect(onChangeSnoozeFolder).toHaveBeenCalledWith("acc-2");
  });
});

describe("MailSettings: AI features (slice 3f)", () => {
  const ai = (overrides: Record<string, unknown> = {}) => ({
    scope: { load: vi.fn(async () => ({ accounts: [], senders: [] })), save: vi.fn(), folders: vi.fn(async () => []) },
    activity: { load: vi.fn(async () => ({ entries: [], next: null })), clear: vi.fn(async () => 0), onOpen: vi.fn() },
    categoriesOn: true,
    morningDigest: false,
    digestTime: "08:00",
    reminderDays: 3,
    loadRules: vi.fn(async () => [
      { id: "cr-1", kind: "address" as const, value: "billing@example.com", category: "bills" as const, createdAt: "2026-11-15T09:00:00.000Z" },
    ]),
    removeRule: vi.fn(async () => undefined),
    onOpenAiSettings: vi.fn(),
    ...overrides,
  });

  it("lists category rules with Remove, the Today and reminder state, and opens AI settings", async () => {
    const ports = ai();
    mount({ ai: ports as never, section: "ai" });
    const rules = await screen.findByRole("list", { name: "Category rules" });
    expect(within(rules).getByText("billing@example.com")).toBeTruthy();
    expect(within(rules).getByText("Bills")).toBeTruthy();
    fireEvent.click(within(rules).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(ports.removeRule).toHaveBeenCalledWith("cr-1"));
    await waitFor(() => expect(screen.queryByText("billing@example.com")).toBeNull());
    expect(screen.getByText("Off: the Today view still works when you open it.")).toBeTruthy();
    expect(screen.getByText("Remind me after 3 days by default.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "AI settings\u2026" }));
    expect(ports.onOpenAiSettings).toHaveBeenCalled();
  });

  it("with categories off there are no rules to load", async () => {
    const ports = ai({ categoriesOn: false });
    mount({ ai: ports as never, section: "ai" });
    expect(await screen.findByText("Off.")).toBeTruthy();
    expect(ports.loadRules).not.toHaveBeenCalled();
  });

  it("no AI sections without the AI ports", () => {
    mount();
    expect(screen.queryByRole("link", { name: "Agent access" })).toBeNull();
    expect(screen.queryByRole("link", { name: "AI features" })).toBeNull();
  });
});

describe("Search and reading (slice 3h)", () => {
  it("shows the attachment text status, retries failed files and removes the text", async () => {
    const { SearchSection } = await import("./reading-section.tsx");
    const { attachmentTextLine } = await import("./shared.ts");
    const status = { indexed: 1240, skipped: 10, failed: 8, pending: 2, running: true, full: false };
    const retry = vi.fn(async () => {});
    const clear = vi.fn(async () => {});
    render(
      <SearchSection
        hint="hint"
        search={{
          values: { historyStepDays: 30, serverSearchKeepDays: 14, indexAttachmentText: true, mailView: "original", darkMail: "adapt", hideQuotes: true, cleanLinks: false },
          loadStatus: async () => status,
          retry,
          clear,
        }}
      />,
    );
    expect(await screen.findByText(attachmentTextLine(status))).toBeTruthy();
    expect(screen.getByText("Remove tracking from links I open: Off")).toBeTruthy();
    expect(attachmentTextLine(status)).toBe("Attachment text: 1240 indexed \u00b7 18 skipped (too large or unreadable) \u00b7 indexing\u2026");
    fireEvent.click(screen.getByRole("button", { name: "Retry failed" }));
    await waitFor(() => expect(retry).toHaveBeenCalled());
    fireEvent.click(await screen.findByRole("button", { name: "Remove attachment text" }));
    await waitFor(() => expect(clear).toHaveBeenCalled());
  });

  it("says when the index is full", async () => {
    const { SearchSection } = await import("./reading-section.tsx");
    render(
      <SearchSection
        hint="hint"
        search={{
          values: { historyStepDays: 30, serverSearchKeepDays: 14, indexAttachmentText: true, mailView: "plain", darkMail: "original", hideQuotes: false },
          loadStatus: async () => ({ indexed: 5, skipped: 0, failed: 0, pending: 0, running: false, full: true }),
          retry: vi.fn(),
          clear: vi.fn(),
        }}
      />,
    );
    expect(await screen.findByText("Attachment text index is full")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry failed" })).toBeNull();
    expect(screen.getByText("Show mail as: Plain text")).toBeTruthy();
    expect(screen.getByText("Remove tracking from links I open: On")).toBeTruthy();
  });
});
