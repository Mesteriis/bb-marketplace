import type { AccountPreset, NewAccountInput } from "./model.ts";

export interface ServerPreset {
  label: string;
  /** null: the owner types the host. */
  host: string | null;
  port: number;
  /** Where the provider issues app passwords, if it has such a page. */
  appPasswordUrl: string | null;
}

export const PRESETS: Record<AccountPreset, ServerPreset> = {
  icloud: {
    label: "iCloud",
    host: "imap.mail.me.com",
    port: 993,
    appPasswordUrl: "https://support.apple.com/en-us/102654",
  },
  gmail: {
    label: "Gmail",
    host: "imap.gmail.com",
    port: 993,
    appPasswordUrl: "https://myaccount.google.com/apppasswords",
  },
  other: {
    label: "Other IMAP server",
    host: null,
    port: 993,
    appPasswordUrl: null,
  },
};

/** The IMAP server and login an account input resolves to. */
export function resolveServer(input: NewAccountInput): {
  host: string;
  port: number;
  username: string;
} {
  const preset = PRESETS[input.preset];
  const host = input.preset === "other" ? input.host?.trim() : preset.host;
  if (!host) throw new Error("Server host is required");
  const port = input.preset === "other" ? (input.port ?? preset.port) : preset.port;
  const username = input.username?.trim() || input.email;
  return { host, port, username };
}
