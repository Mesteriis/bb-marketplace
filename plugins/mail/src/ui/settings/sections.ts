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
  sections: readonly { id: SettingsSectionId; title: string }[];
}[] = [
  {
    id: "accounts",
    title: "Accounts",
    sections: [
      { id: "accounts", title: "Mailboxes and sign-in" },
      { id: "addresses", title: "Addresses and signatures" },
    ],
  },
  {
    id: "mail",
    title: "Mail",
    sections: [
      { id: "inbox", title: "Inbox" },
      { id: "filters", title: "Filters" },
      { id: "subscriptions", title: "Subscriptions" },
      { id: "templates", title: "Templates" },
      { id: "reading", title: "Reading and search" },
    ],
  },
  {
    id: "ai",
    title: "AI and agents",
    sections: [
      { id: "ai", title: "AI features" },
      { id: "ai_access", title: "Agent access" },
      { id: "activity", title: "Activity log" },
    ],
  },
  {
    id: "bb",
    title: "BB",
    sections: [
      { id: "bb", title: "Integration" },
      { id: "rules", title: "Rules" },
    ],
  },
  {
    id: "security",
    title: "Security",
    sections: [
      { id: "pgp", title: "Encryption" },
      { id: "local", title: "Local data" },
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

export function settingsSectionTitle(id: SettingsSectionId): string {
  for (const group of SETTINGS_GROUPS) {
    const found = group.sections.find((section) => section.id === id);
    if (found !== undefined) return found.title;
  }
  return "Settings";
}
