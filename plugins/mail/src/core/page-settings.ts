// The plugin's settings as the settings page reads and writes them. One
// schema per key, the same one BB's own plugin settings page checks with
// (server.ts defineSettings takes them from here), so the two pages cannot
// disagree about what a value may be.
//
// Three keys widen what agents may do with mail; the page shows them and
// never writes them. The credential key is not here at all.
import { z } from "zod";
import { projectFolder } from "./project-paths.ts";
import { SUPPORTED_LANGUAGES } from "./translate.ts";

export const SYNC_INTERVAL_MAX = 1440;
/** The digest time setting: HH:MM on a 24-hour clock. */
export const DIGEST_TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
/** Quiet hours: HH:MM-HH:MM (a hyphen or an en dash), or empty for none. */
export const QUIET_HOURS_PATTERN = /^(?:([01]\d|2[0-3]):[0-5]\d[-–]([01]\d|2[0-3]):[0-5]\d)?$/;

const line = (max: number) => z.string().max(max).refine((value) => !/[\u0000\r\n]/.test(value), "Must be one line");
const folder = () =>
  z.string().refine((value) => projectFolder(value).ok, "Must be a folder inside the project, not starting with a dot");
const languageTags = SUPPORTED_LANGUAGES.map((language) => language.tag) as [string, ...string[]];

export const PAGE_SETTING_SCHEMAS = {
  syncIntervalMinutes: z.number().int().min(1).max(SYNC_INTERVAL_MAX),
  syncWindowDays: z.number().int().min(1),
  agentTools: z.boolean(),
  agentPropose: z.boolean(),
  translateProvider: line(64),
  translateModel: line(200),
  translateLanguage: z.enum(languageTags),
  instantMail: z.boolean(),
  notifyNewMail: z.boolean(),
  importantSenders: z.string().max(20_000),
  notifyImportantOnly: z.boolean(),
  quietHours: z.string().regex(QUIET_HOURS_PATTERN, "Must be HH:MM-HH:MM, or empty"),
  agentTriage: z.boolean(),
  mailCategories: z.boolean(),
  morningDigest: z.boolean(),
  digestTime: z.string().regex(DIGEST_TIME_PATTERN, "Must be HH:MM"),
  replyReminderDays: z.number().int().min(1).max(30),
  devNotifications: z.boolean(),
  mailRules: z.boolean(),
  attachmentFolder: folder(),
  patchFolder: folder(),
  taskTarget: z.enum(["auto", "taskboard", "local"]),
  historyStepDays: z.number().int().min(7).max(365),
  serverSearchKeepDays: z.number().int().min(1).max(90),
  indexAttachmentText: z.boolean(),
  mailView: z.enum(["original", "plain"]),
  darkMail: z.enum(["adapt", "original"]),
  hideQuotes: z.boolean(),
  listDensity: z.enum(["comfortable", "compact"]),
  readingPane: z.enum(["right", "bottom"]),
  language: z.enum(["auto", "ru", "en"]),
  cleanLinks: z.boolean(),
} as const;

/** Every setting the page shows. */
export const pageSettingsSchema = z.object(PAGE_SETTING_SCHEMAS);
export type PageSettings = z.infer<typeof pageSettingsSchema>;

/** What each setting is before the owner changes it; also what the page shows for a stored value that no longer fits. */
export const PAGE_SETTING_DEFAULTS: PageSettings = {
  syncIntervalMinutes: 5,
  syncWindowDays: 30,
  agentTools: false,
  agentPropose: false,
  translateProvider: "",
  translateModel: "",
  translateLanguage: "ru",
  instantMail: true,
  notifyNewMail: true,
  importantSenders: "",
  notifyImportantOnly: false,
  quietHours: "",
  agentTriage: false,
  mailCategories: false,
  morningDigest: false,
  digestTime: "08:00",
  replyReminderDays: 3,
  devNotifications: true,
  mailRules: false,
  attachmentFolder: "mail-attachments",
  patchFolder: "mail-patches",
  taskTarget: "auto",
  historyStepDays: 30,
  serverSearchKeepDays: 14,
  indexAttachmentText: false,
  mailView: "original",
  darkMail: "adapt",
  hideQuotes: true,
  listDensity: "comfortable",
  readingPane: "right",
  language: "auto",
  cleanLinks: true,
};

/** The stored settings as the page shows them: each key checked, a value that does not fit replaced by its default. */
export function pageSettingsOf(stored: Record<string, unknown>): PageSettings {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(PAGE_SETTING_SCHEMAS) as (keyof PageSettings)[]) {
    const parsed = PAGE_SETTING_SCHEMAS[key].safeParse(stored[key]);
    out[key] = parsed.success ? parsed.data : PAGE_SETTING_DEFAULTS[key];
  }
  return out as PageSettings;
}

/** Shown on the page, changed only in BB's plugin settings: they widen what agents may do with mail. */
export const PAGE_SETTINGS_READ_ONLY = ["agentTools", "agentPropose", "agentTriage"] as const;

const { agentTools: _tools, agentPropose: _propose, agentTriage: _triage, ...WRITABLE } = PAGE_SETTING_SCHEMAS;

/** A change from the page: some of the writable keys, at least one, nothing else. */
export const pageSettingsPatchSchema = z
  .object(WRITABLE)
  .partial()
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, "Nothing to change");
export type PageSettingsPatch = z.infer<typeof pageSettingsPatchSchema>;
