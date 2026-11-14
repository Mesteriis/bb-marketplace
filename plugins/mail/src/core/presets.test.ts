import { describe, expect, it } from "vitest";
import { PRESETS, resolveServer } from "./presets.ts";
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
