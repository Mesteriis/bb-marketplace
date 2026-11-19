// The settings page's map: five groups, fourteen sections, in the order the
// menu shows them. Titles are tx() keys. A section is listed only while the
// page has what it needs (see settings-page.tsx `available`).

export type SettingsSectionId =
  | "accounts"
  | "addresses"
  | "inbox"
  | "filters"
  | "subscriptions"
  | "templates"
  | "reading"
  | "ai"
  | "ai_access"
  | "activity"
  | "bb"
  | "rules"
  | "pgp"
  | "local";

export type SettingsGroupId = "accounts" | "mail" | "ai" | "bb" | "security";

export const SETTINGS_GROUPS: readonly {
  id: SettingsGroupId;
  title: string;
  sections: readonly { id: SettingsSectionId; title: string; description: string }[];
}[] = [
  {
    id: "accounts",
    title: "Accounts",
    sections: [
      { id: "accounts", title: "Mailboxes and sign-in", description: "Your mail accounts, how each signs in, and how often Mail checks them." },
      { id: "addresses", title: "Addresses and signatures", description: "The addresses you send from, their names and signatures." },
    ],
  },
  {
    id: "mail",
    title: "Mail",
    sections: [
      { id: "inbox", title: "Inbox", description: "Notifications, blocked senders and where snoozed mail waits." },
      { id: "filters", title: "Filters", description: "Rules that sort new Inbox mail by themselves." },
      { id: "subscriptions", title: "Subscriptions", description: "The mailing lists in your mail, and unsubscribing from them." },
      { id: "templates", title: "Templates", description: "Texts you insert into a message with one click." },
      { id: "reading", title: "Reading and search", description: "How mail is shown, and how search and older mail load." },
    ],
  },
  {
    id: "ai",
    title: "AI and agents",
    sections: [
      { id: "ai", title: "AI features", description: "Categories, the Today digest, reply reminders and translation. They run on your click." },
      { id: "ai_access", title: "Agent access", description: "Which mail agents and AI features may see." },
      { id: "activity", title: "Activity log", description: "What agents and AI features did with your mail." },
    ],
  },
  {
    id: "bb",
    title: "BB",
    sections: [
      { id: "bb", title: "Integration", description: "Where mail meets BB projects and tasks." },
      { id: "rules", title: "Rules", description: "Rules that prepare agent threads from new mail." },
    ],
  },
  {
    id: "security",
    title: "Security",
    sections: [
      { id: "pgp", title: "Encryption", description: "OpenPGP keys for signing and encrypting mail." },
      { id: "local", title: "Local data", description: "Where Mail keeps its data on this computer." },
    ],
  },
];

const IDS: ReadonlySet<string> = new Set(SETTINGS_GROUPS.flatMap((group) => group.sections.map((section) => section.id)));

/** The section an address segment names; the first one for a missing or unknown segment. */
export function settingsSectionOf(segment: string | undefined): SettingsSectionId {
  // The dialog this page replaced called "Reading and search" `search`.
  if (segment === "search") return "reading";
  return segment !== undefined && IDS.has(segment) ? (segment as SettingsSectionId) : "accounts";
}

/** A section's title and its one sentence, as tx() keys. */
export function settingsSectionText(id: SettingsSectionId): { title: string; description: string } {
  for (const group of SETTINGS_GROUPS) {
    const found = group.sections.find((section) => section.id === id);
    if (found !== undefined) return { title: found.title, description: found.description };
  }
  return { title: "Settings", description: "" };
}

export function settingsSectionTitle(id: SettingsSectionId): string {
  return settingsSectionText(id).title;
}
