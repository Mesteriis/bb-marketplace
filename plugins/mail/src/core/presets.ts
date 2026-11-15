import type {
  AccountPreset,
  NewAccountInput,
  SentCopyPolicy,
  SmtpSecurity,
  StoredSmtp,
} from "./model.ts";

/** A provider's SMTP server and who keeps the Sent copy. */
export interface SmtpPreset {
  host: string;
  port: number;
  security: SmtpSecurity;
  sentCopy: SentCopyPolicy;
}

export interface ServerPreset {
  label: string;
  /** null: the owner types the host. */
  host: string | null;
  port: number;
  /** Where the provider issues app passwords, if it has such a page. */
  appPasswordUrl: string | null;
  /** null: the owner types the SMTP server. */
  smtp: SmtpPreset | null;
}

export const PRESETS: Record<AccountPreset, ServerPreset> = {
  icloud: {
    label: "iCloud",
    host: "imap.mail.me.com",
    port: 993,
    appPasswordUrl: "https://support.apple.com/en-us/102654",
    smtp: { host: "smtp.mail.me.com", port: 587, security: "starttls", sentCopy: "append" },
  },
  gmail: {
    label: "Gmail",
    host: "imap.gmail.com",
    port: 993,
    appPasswordUrl: "https://myaccount.google.com/apppasswords",
    // Gmail files every message sent through its SMTP in Sent Mail itself.
    smtp: { host: "smtp.gmail.com", port: 465, security: "tls", sentCopy: "server" },
  },
  other: {
    label: "Other IMAP server",
    host: null,
    port: 993,
    appPasswordUrl: null,
    smtp: null,
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

/**
 * The SMTP server an account input resolves to. iCloud and Gmail use the
 * preset; another server needs host, port and security (its copy goes to
 * Sent by APPEND). The username defaults to the IMAP username (null).
 */
export function resolveSmtp(input: NewAccountInput): {
  smtp: StoredSmtp;
  sentCopy: SentCopyPolicy;
} {
  const username = input.smtpUsername?.trim() || null;
  const preset = PRESETS[input.preset].smtp;
  if (preset !== null) {
    return {
      smtp: { host: preset.host, port: preset.port, security: preset.security, username },
      sentCopy: preset.sentCopy,
    };
  }
  const host = input.smtpHost?.trim();
  if (!host || input.smtpPort === undefined || input.smtpSecurity === undefined) {
    throw new Error("SMTP host, port and security are required");
  }
  return {
    smtp: { host, port: input.smtpPort, security: input.smtpSecurity, username },
    sentCopy: "append",
  };
}
