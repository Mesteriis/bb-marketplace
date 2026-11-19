import type { PluginRight } from "../../core/plugin-access.ts";
import type { PluginAccessPort } from "./plugin-access-section.tsx";
import type { InboxTabsPort } from "./tabs-settings.tsx";
import type { PageSettingsPort } from "./setting-controls.tsx";
import type { Account, BlockRuleView, CategoryRuleView, IdentityView } from "../../core/model.ts";
import { type AiAccessSettingsProps } from "../ai-access-settings.tsx";
import { type AgentActivityProps } from "../agent-activity.tsx";
import { type EditorDoc } from "../compose-editor.tsx";
import { type ToolId } from "../compose-toolbar.tsx";
import { type BbSettingsValues } from "../bb-integration-settings.tsx";
import { type SettingsFilterPorts } from "../filters-settings.tsx";
import { type SettingsSubscriptionPorts } from "../subscriptions-settings.tsx";
import type { BbCall } from "../bb-ports.ts";
import { dateLocale, tx } from "../i18n/index.ts";
import type { SettingsSectionId } from "./sections.ts";
import { type SettingsPgpPorts } from "../pgp-settings.tsx";

export type TemplateView = { id: string; name: string; doc: EditorDoc; updatedAt: string };
export type SuggestionView = { address: string; count: number; lastDate: string };
export type IdentityKey = { accountId: string; address: string };
/** @deprecated the page's section ids; kept as a name for callers. */
export type SettingsSection = SettingsSectionId;

/** attachment_text_status (slice 3h). */
export interface AttachmentTextStatus {
  indexed: number;
  skipped: number;
  failed: number;
  pending: number;
  running: boolean;
  full: boolean;
}

/** Mail settings' Search and reading tab (slice 3h). */
export interface SettingsSearchPorts {
  /** The plugin settings as BB has them now. */
  values: {
    historyStepDays: number;
    serverSearchKeepDays: number;
    indexAttachmentText: boolean;
    mailView: "original" | "plain";
    darkMail: "adapt" | "original";
    hideQuotes: boolean;
    /** Slice 3i: Remove tracking from links I open (absent: on). */
    cleanLinks?: boolean;
  };
  loadStatus: () => Promise<AttachmentTextStatus>;
  retry: () => Promise<void>;
  clear: () => Promise<void>;
}

/** "Attachment text: 1 240 indexed - 18 skipped (too large or unreadable) - indexing...". */
export function attachmentTextLine(status: AttachmentTextStatus): string {
  const parts = [`${status.indexed} indexed`];
  if (status.skipped + status.failed > 0) parts.push(`${status.skipped + status.failed} skipped (too large or unreadable)`);
  if (status.running || status.pending > 0) parts.push("indexing\u2026");
  return tx("Attachment text: {p1}", { p1: parts.join(" \u00b7 ") });
}

/** Mail settings' BB tabs (slice 3g). */
export interface SettingsBbPorts {
  call: BbCall;
  /** The plugin settings as BB has them now. */
  values: BbSettingsValues;
  mailRules: boolean;
  notify: (text: string, action?: { label: string; run: () => void }) => void;
}

/** Mail settings' AI tabs (slice 3f). */
export interface SettingsAiPorts {
  scope: Omit<AiAccessSettingsProps, "accounts">;
  activity: AgentActivityProps;
  /** The plugin settings as BB has them now. */
  categoriesOn: boolean;
  morningDigest: boolean;
  digestTime: string;
  reminderDays: number;
  loadRules: () => Promise<CategoryRuleView[]>;
  removeRule: (id: string) => Promise<void>;
  /** AI settings: provider, model and translation (the former Translation settings). */
  onOpenAiSettings: () => void;
}

/** Where the switches of plugin settings live: BB's own settings page. */
export const PLUGIN_SETTINGS_HINT = "Change it in BB Settings \u2192 Plugins \u2192 Makosh Mail.";

/** The template editor's tools: everything but the quote (templates cannot hold quotes). */
export const TEMPLATE_TOOLS: readonly ToolId[] = [
  "bold",
  "italic",
  "underline",
  "bulletList",
  "orderedList",
  "link",
  "codeBlock",
  "clear",
];

export interface MailSettingsProps {
  accounts: readonly Account[];
  /** Every account's identities (identities_list with accountId null). */
  identities: readonly IdentityView[];
  templates: readonly TemplateView[];
  suggestions: (accountId: string) => Promise<SuggestionView[]>;
  onAdd: (input: IdentityKey & { displayName?: string }) => Promise<void>;
  onUpdate: (input: IdentityKey & { displayName?: string | null; signature?: EditorDoc | null }) => Promise<void>;
  onRemove: (input: IdentityKey) => Promise<void>;
  onDismiss: (input: IdentityKey) => Promise<void>;
  onSaveTemplate: (input: { id?: string; name: string; doc: EditorDoc }) => Promise<void>;
  onDeleteTemplate: (id: string) => Promise<void>;
  onOpenSmtp: (accountId: string) => void;
  /** The plugin's settings for the rows that save on change; absent: those rows are not shown. */
  settings?: PageSettingsPort;
  /** False while the credential key is not set. */
  vaultReady?: boolean;
  onAddAccount?: () => void;
  /** Opens the account form to type a new app password. */
  onReplacePassword?: (account: Account) => void;
  onCopy?: (text: string) => void;
  /** Switches a Gmail account that uses an app password to Google sign-in; absent: not offered. */
  onGoogleSwitch?: (account: Account) => void;
  /** Blocked senders (slice 3e); null while they load. Absent: no Inbox tab. */
  blockRules?: readonly BlockRuleView[] | null;
  onUnblock?: (id: string) => Promise<void>;
  /** Change… (or set up) an account's snooze folder. */
  onChangeSnoozeFolder?: (accountId: string) => void;
  /** Split Inbox: the Tabs group of the Inbox section; absent: none. */
  inboxTabs?: InboxTabsPort;
  /** AI access, Agent activity and AI features (slice 3f); absent: none of those tabs. */
  ai?: SettingsAiPorts;
  /** BB integration and Rules (slice 3g); absent: neither tab. */
  bb?: SettingsBbPorts;
  /** Search and reading (slice 3h); absent: no tab. */
  search?: SettingsSearchPorts;
  /** OpenPGP keys (slice 3k); absent: no tab. */
  pgp?: SettingsPgpPorts;
  /** Filters over new Inbox mail (slice 3m); absent: no tab. */
  /** Access of other plugins (the plugin API); absent: no section. */
  pluginAccess?: {
    port: PluginAccessPort;
    onGoogleGrant?: (pluginId: string, right: PluginRight, accountId: string) => void;
    /** Changes when requests or grants changed elsewhere. */
    reloadKey: number;
    /** Requests waiting for the owner: shown next to the section's name. */
    waiting: number;
  };
  filters?: SettingsFilterPorts;
  /** The mailing lists of the stored mail (slice 3n); absent: no tab. */
  subscriptions?: SettingsSubscriptionPorts;
}

export function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

/** A document as plain lines (hard breaks end a line), for previews. */
export function docPreview(doc: EditorDoc | null): string {
  if (doc === null) return "";
  const lines: string[] = [];
  let line = "";
  const walk = (node: EditorDoc) => {
    if (node.type === "text") line += node.text ?? "";
    else if (node.type === "hardBreak") {
      lines.push(line);
      line = "";
    }
    for (const child of node.content ?? []) walk(child);
    if (node.type === "paragraph") {
      lines.push(line);
      line = "";
    }
  };
  walk(doc);
  if (line !== "") lines.push(line);
  return lines.map((l) => l.trim()).filter((l) => l !== "").join("\n");
}

/** What the owner sees about an address's sends; null when there is nothing to warn about. */
export function sendCheckText(check: IdentityView["sendCheck"]): string | null {
  if (check === "rewritten") {
    return tx("The last message from this address went out from the account's own address: the provider does not let this account send as it.");
  }
  if (check === "refused") {
    return tx("The server refused to send from this address. Set it up with your provider, or remove it.");
  }
  return null;
}

export function formatDay(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString(dateLocale(), { day: "numeric", month: "short", year: "numeric" });
}
