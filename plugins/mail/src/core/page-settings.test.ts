import { describe, expect, it } from "vitest";
import {
  PAGE_SETTINGS_READ_ONLY,
  PAGE_SETTING_DEFAULTS,
  pageSettingsOf,
  PAGE_SETTING_SCHEMAS,
  pageSettingsPatchSchema,
  pageSettingsSchema,
} from "./page-settings.ts";

const ok = (patch: unknown) => pageSettingsPatchSchema.safeParse(patch).success;

describe("page settings", () => {
  it("covers the 32 settings of the page and never the credential key", () => {
    expect(Object.keys(PAGE_SETTING_SCHEMAS)).toHaveLength(40);
    expect("vaultKey" in PAGE_SETTING_SCHEMAS).toBe(false);
    expect(PAGE_SETTINGS_READ_ONLY).toEqual(["agentTools", "agentPropose", "agentTriage"]);
  });

  it("accepts a change of writable keys within their bounds", () => {
    expect(ok({ syncIntervalMinutes: 15 })).toBe(true);
    expect(ok({ syncIntervalMinutes: 1440, hideQuotes: false, listDensity: "compact" })).toBe(true);
    expect(ok({ quietHours: "" })).toBe(true);
    expect(ok({ quietHours: "22:00-07:30" })).toBe(true);
    expect(ok({ digestTime: "07:30" })).toBe(true);
    expect(ok({ replyReminderDays: 30 })).toBe(true);
    expect(ok({ attachmentFolder: "inbox-files" })).toBe(true);
    expect(ok({ translateLanguage: "de" })).toBe(true);
  });

  it("refuses the agent switches, the credential key, unknown keys and an empty change", () => {
    expect(ok({ agentTools: true })).toBe(false);
    expect(ok({ agentPropose: true })).toBe(false);
    expect(ok({ agentTriage: false })).toBe(false);
    expect(ok({ hideQuotes: false, agentTools: true })).toBe(false);
    expect(ok({ vaultKey: "x" })).toBe(false);
    expect(ok({ unknownKey: 1 })).toBe(false);
    expect(ok({})).toBe(false);
    expect(ok(null)).toBe(false);
  });

  it("refuses values outside the bounds", () => {
    expect(ok({ syncIntervalMinutes: 0 })).toBe(false);
    expect(ok({ syncIntervalMinutes: 1441 })).toBe(false);
    expect(ok({ syncIntervalMinutes: 2.5 })).toBe(false);
    expect(ok({ syncWindowDays: 0 })).toBe(false);
    expect(ok({ replyReminderDays: 31 })).toBe(false);
    expect(ok({ historyStepDays: 6 })).toBe(false);
    expect(ok({ serverSearchKeepDays: 91 })).toBe(false);
    expect(ok({ digestTime: "7:30" })).toBe(false);
    expect(ok({ quietHours: "22:00" })).toBe(false);
    expect(ok({ listDensity: "tiny" })).toBe(false);
    expect(ok({ language: "de" })).toBe(false);
    expect(ok({ attachmentFolder: "../outside" })).toBe(false);
    expect(ok({ attachmentFolder: ".hidden" })).toBe(false);
    expect(ok({ translateModel: "two\nlines" })).toBe(false);
    expect(ok({ hideQuotes: "yes" })).toBe(false);
  });

  it("the defaults fit their own schema, and a stored value that does not fit reads as its default", () => {
    expect(pageSettingsSchema.safeParse(PAGE_SETTING_DEFAULTS).success).toBe(true);
    const shown = pageSettingsOf({ ...PAGE_SETTING_DEFAULTS, hideQuotes: false, replyReminderDays: 99, vaultKey: "invented-key", listDensity: 7 });
    expect(shown.hideQuotes).toBe(false);
    expect(shown.replyReminderDays).toBe(3);
    expect(shown.listDensity).toBe("comfortable");
    expect("vaultKey" in shown).toBe(false);
    expect(Object.keys(pageSettingsOf({}))).toHaveLength(40);
  });

  it("the full schema needs every key", () => {
    expect(pageSettingsSchema.safeParse({ hideQuotes: true }).success).toBe(false);
  });
});
