import { describe, expect, it } from "vitest";
import { PRESETS, resolveServer, resolveSmtp } from "./presets.ts";
import type { NewAccountInput } from "./model.ts";

function input(overrides: Partial<NewAccountInput>): NewAccountInput {
  return {
    preset: "icloud",
    email: "anna@example.org",
    password: "app-password",
    ...overrides,
  };
}

describe("PRESETS", () => {
  it("names the iCloud and Gmail servers and their app-password pages", () => {
    expect(PRESETS.icloud).toMatchObject({
      host: "imap.mail.me.com",
      port: 993,
      appPasswordUrl: "https://support.apple.com/en-us/102654",
    });
    expect(PRESETS.gmail).toMatchObject({
      host: "imap.gmail.com",
      port: 993,
      appPasswordUrl: "https://myaccount.google.com/apppasswords",
    });
    expect(PRESETS.other).toMatchObject({ host: null, port: 993, appPasswordUrl: null });
  });
});

describe("resolveServer", () => {
  it("uses the iCloud server and the address as username", () => {
    expect(resolveServer(input({ preset: "icloud" }))).toEqual({
      host: "imap.mail.me.com",
      port: 993,
      username: "anna@example.org",
    });
  });

  it("uses the Gmail server and the address as username", () => {
    expect(resolveServer(input({ preset: "gmail" }))).toEqual({
      host: "imap.gmail.com",
      port: 993,
      username: "anna@example.org",
    });
  });

  it("uses the given host and port for another server", () => {
    expect(
      resolveServer(input({ preset: "other", host: "imap.example.org", port: 1993 })),
    ).toEqual({ host: "imap.example.org", port: 1993, username: "anna@example.org" });
  });

  it("defaults another server's port to 993", () => {
    expect(resolveServer(input({ preset: "other", host: "imap.example.org" })).port).toBe(993);
  });

  it("refuses another server without a host", () => {
    expect(() => resolveServer(input({ preset: "other" }))).toThrow(
      "Server host is required",
    );
  });

  it("prefers an explicit username", () => {
    expect(resolveServer(input({ preset: "gmail", username: "anna.login" })).username).toBe(
      "anna.login",
    );
  });
});

describe("SMTP presets", () => {
  it("carries iCloud's and Gmail's SMTP servers and Sent-copy policy", () => {
    expect(PRESETS.icloud.smtp).toEqual({
      host: "smtp.mail.me.com",
      port: 587,
      security: "starttls",
      sentCopy: "append",
    });
    expect(PRESETS.gmail.smtp).toEqual({
      host: "smtp.gmail.com",
      port: 465,
      security: "tls",
      sentCopy: "server",
    });
    expect(PRESETS.other.smtp).toBeNull();
  });
});

describe("resolveSmtp", () => {
  it("uses the preset for iCloud and Gmail, the IMAP username by default", () => {
    expect(resolveSmtp(input({ preset: "icloud" }))).toEqual({
      smtp: { host: "smtp.mail.me.com", port: 587, security: "starttls", username: null },
      sentCopy: "append",
    });
    expect(resolveSmtp(input({ preset: "gmail" }))).toEqual({
      smtp: { host: "smtp.gmail.com", port: 465, security: "tls", username: null },
      sentCopy: "server",
    });
  });

  it("ignores typed SMTP host fields for a preset but keeps an explicit username", () => {
    expect(
      resolveSmtp(
        input({ preset: "gmail", smtpHost: "smtp.example.net", smtpPort: 25, smtpUsername: " anna.login " }),
      ).smtp,
    ).toEqual({ host: "smtp.gmail.com", port: 465, security: "tls", username: "anna.login" });
  });

  it("takes another server's typed SMTP fields and appends its Sent copy", () => {
    expect(
      resolveSmtp(
        input({
          preset: "other",
          host: "imap.example.org",
          smtpHost: " smtp.example.org ",
          smtpPort: 587,
          smtpSecurity: "starttls",
        }),
      ),
    ).toEqual({
      smtp: { host: "smtp.example.org", port: 587, security: "starttls", username: null },
      sentCopy: "append",
    });
  });

  it("refuses another server without SMTP host, port or security", () => {
    const other = { preset: "other" as const, host: "imap.example.org" };
    expect(() => resolveSmtp(input(other))).toThrow("SMTP host, port and security are required");
    expect(() =>
      resolveSmtp(input({ ...other, smtpHost: "smtp.example.org", smtpSecurity: "tls" })),
    ).toThrow("SMTP host, port and security are required");
    expect(() =>
      resolveSmtp(input({ ...other, smtpHost: "smtp.example.org", smtpPort: 465 })),
    ).toThrow("SMTP host, port and security are required");
  });
});
