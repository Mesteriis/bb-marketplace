// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { installTestPluginRuntime } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PAGE_SETTING_DEFAULTS, type PageSettings } from "../../core/page-settings.ts";
import { setLanguage } from "../i18n/index.ts";
import { AiFeaturesSection } from "./ai-features-section.tsx";
import {
  AgentSwitches,
  IntegrationSettings,
  NotificationSettings,
  ReadingSettings,
  ReminderSetting,
  RulesSwitch,
  SearchSettings,
  TodaySettings,
} from "./section-settings.tsx";
import type { PageSettingsPort } from "./setting-controls.tsx";
import type { SettingsAiPorts } from "./shared.ts";

installTestPluginRuntime();
afterEach(() => {
  cleanup();
  setLanguage("en");
});

const proto = Element.prototype as unknown as Record<string, unknown>;
proto.scrollIntoView ??= () => {};
proto.hasPointerCapture ??= () => false;
proto.releasePointerCapture ??= () => {};

function port(values: Partial<PageSettings> | null = {}) {
  const save = vi.fn(async () => ({ ok: true as const }));
  const made: PageSettingsPort = { values: values === null ? null : { ...PAGE_SETTING_DEFAULTS, ...values }, save };
  return { port: made, save };
}

const aiPorts = {
  categoriesOn: false,
  morningDigest: true,
  digestTime: "07:30",
  reminderDays: 3,
  loadRules: async () => [],
  removeRule: async () => undefined,
  onOpenAiSettings: () => undefined,
} as unknown as SettingsAiPorts;

describe("rows of the sections", () => {
  it("AI features: switches, the digest time and the reminder days save their own key", () => {
    const { port: p, save } = port({ morningDigest: true, digestTime: "07:30" });
    render(
      <>
        <TodaySettings port={p} />
        <ReminderSetting port={p} />
      </>,
    );
    expect(screen.getByRole("switch", { name: "Daily Today digest" }).getAttribute("aria-checked")).toBe("true");
    expect((screen.getByLabelText("Digest time") as HTMLInputElement).value).toBe("07:30");
    expect((screen.getByLabelText("Remind about a reply after") as HTMLInputElement).value).toBe("3");
    fireEvent.click(screen.getByRole("switch", { name: "Daily Today digest" }));
    expect(save).toHaveBeenLastCalledWith({ morningDigest: false });
    const days = screen.getByLabelText("Remind about a reply after");
    fireEvent.change(days, { target: { value: "5" } });
    fireEvent.blur(days);
    expect(save).toHaveBeenLastCalledWith({ replyReminderDays: 5 });
  });

  it("the AI features section changes its settings in place and sends nobody to BB's settings", () => {
    const { port: p, save } = port();
    render(<AiFeaturesSection ai={aiPorts} settings={p} />);
    expect(screen.queryByText(/Change it in BB Settings/)).toBeNull();
    expect(screen.queryByText("Off.")).toBeNull();
    fireEvent.click(screen.getByRole("switch", { name: "Sort mail into categories" }));
    expect(save).toHaveBeenLastCalledWith({ mailCategories: true });
    expect(screen.getByLabelText("Translate into")).toBeTruthy();
    expect(screen.getByRole("button", { name: "AI settings…" })).toBeTruthy();
  });

  it("the agent switches are shown and cannot be changed here", () => {
    const { port: p, save } = port({ agentTools: true });
    render(<AgentSwitches port={p} />);
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.getByText("Search and read mail in every thread").closest("div")!.parentElement!.textContent).toContain("On");
    expect(screen.getByText(/changed only in BB Settings → Plugins → Makosh Mail/)).toBeTruthy();
    expect(save).not.toHaveBeenCalled();
  });

  it("Inbox: notifications, important senders and quiet hours", () => {
    const { port: p, save } = port({ quietHours: "22:00-08:00" });
    render(<NotificationSettings port={p} />);
    expect((screen.getByLabelText("Quiet hours") as HTMLInputElement).value).toBe("22:00-08:00");
    fireEvent.click(screen.getByRole("switch", { name: "Only from important senders" }));
    expect(save).toHaveBeenLastCalledWith({ notifyImportantOnly: true });
    const senders = screen.getByLabelText("Important senders");
    fireEvent.change(senders, { target: { value: "boss@example.org" } });
    fireEvent.blur(senders);
    expect(save).toHaveBeenLastCalledWith({ importantSenders: "boss@example.org" });
  });

  it("Reading and search: every key has a control with its saved value", () => {
    const { port: p, save } = port({ hideQuotes: false, historyStepDays: 60 });
    render(
      <>
        <ReadingSettings port={p} />
        <SearchSettings port={p} />
      </>,
    );
    for (const name of ["Show mail as", "Mail in dark mode", "List rows", "Reading pane", "Language of Mail's pages"]) {
      expect(screen.getByRole("combobox", { name }), name).toBeTruthy();
    }
    expect(screen.getByRole("switch", { name: "Hide quoted text in replies" }).getAttribute("aria-checked")).toBe("false");
    expect(screen.getByRole("switch", { name: "Remove tracking from links I open" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("switch", { name: "Search inside attachments" }).getAttribute("aria-checked")).toBe("false");
    expect((screen.getByLabelText("\"Load more days\" loads") as HTMLInputElement).value).toBe("60");
    expect((screen.getByLabelText("Keep unopened server search results") as HTMLInputElement).value).toBe("14");
    fireEvent.click(screen.getByRole("switch", { name: "Remove tracking from links I open" }));
    expect(save).toHaveBeenLastCalledWith({ cleanLinks: false });
  });

  it("Integration and Rules", () => {
    const { port: p, save } = port({ attachmentFolder: "inbox-files" });
    render(
      <>
        <IntegrationSettings port={p} />
        <RulesSwitch port={p} />
      </>,
    );
    expect((screen.getByLabelText("Folder for attachments saved into a project") as HTMLInputElement).value).toBe("inbox-files");
    expect((screen.getByLabelText("Folder for patches saved into a project") as HTMLInputElement).value).toBe("mail-patches");
    expect(screen.getByRole("combobox", { name: "Make a task in" })).toBeTruthy();
    fireEvent.click(screen.getByRole("switch", { name: "Recognise dev notifications" }));
    expect(save).toHaveBeenLastCalledWith({ devNotifications: false });
    fireEvent.click(screen.getByRole("switch", { name: "Run my rules on new Inbox mail" }));
    expect(save).toHaveBeenLastCalledWith({ mailRules: true });
  });

  it("while the settings load every row is there and disabled", () => {
    const { port: p } = port(null);
    render(
      <>
        <NotificationSettings port={p} />
        <ReadingSettings port={p} />
      </>,
    );
    for (const control of screen.getAllByRole("switch")) expect((control as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getAllByRole("status").every((status) => status.textContent === "Loading…")).toBe(true);
  });
});

describe("in Russian", () => {
  it("no row is left in English, and the days are declined", () => {
    setLanguage("ru");
    const { port: p } = port({ agentTools: true });
    const { container } = render(
      <>
        <AiFeaturesSection ai={aiPorts} settings={p} />
        <AgentSwitches port={p} />
        <NotificationSettings port={p} />
        <ReadingSettings port={p} />
        <SearchSettings port={p} />
        <IntegrationSettings port={p} />
        <RulesSwitch port={p} />
      </>,
    );
    const text = container.textContent ?? "";
    for (const english of ["Off.", "Change it in", " days", "Loading", "Saved", "On:", "Remind", "Folder", "Show mail"]) {
      expect(text, english).not.toContain(english);
    }
    cleanup();
    for (const [days, expected] of [
      [1, "1 день"],
      [3, "3 дня"],
      [5, "5 дней"],
    ] as const) {
      render(<AiFeaturesSection ai={{ ...aiPorts, reminderDays: days } as SettingsAiPorts} />);
      expect(screen.getByText(new RegExp(`${expected} по умолчанию`))).toBeTruthy();
      cleanup();
    }
  });
});
