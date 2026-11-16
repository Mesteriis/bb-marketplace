import { describe, expect, it } from "vitest";
import { FixedClock, IdentityVault, InMemoryMailStore, makeFetchedMessage, makeStoredAccount } from "../../core/testing/fakes.ts";
import type { ImapGateway } from "../../core/index.ts";
import { createSenderChecks } from "./sender-checks.ts";

const EPOCH = "1970-01-01T00:00:00.000Z";

function setup() {
  const store = new InMemoryMailStore();
  store.saveAccount(makeStoredAccount({ id: "acc_1", email: "owner@example.org", preset: "gmail" }));
  store.saveFolders("acc_1", [
    { path: "INBOX", name: "INBOX", delimiter: "/", specialUse: "inbox", selectable: true, subscribed: true },
  ] as Parameters<InMemoryMailStore["saveFolders"]>[1]);
  store.upsertMessages("acc_1", "INBOX", [makeFetchedMessage(1, { from: { name: "Bank", address: "billing@example.com" } })]);
  const id = store.localFolderIndex("acc_1", "INBOX", EPOCH).find((e) => e.uid === 1)!.id;
  const checks = createSenderChecks({
    store,
    clock: new FixedClock(new Date("2026-11-16T10:00:00.000Z")),
    gateway: {} as ImapGateway,
    vault: new IdentityVault(),
    queue: { run: (_account, task) => task() },
    vaultReady: () => true,
    log: () => undefined,
    publishChanged: () => undefined,
  });
  return { store, checks, id };
}

const raw = (lines: string[]) => new TextEncoder().encode([...lines, "", "Invented body.", ""].join("\r\n"));

describe("fromRaw (Details' authenticity), slice 3i review finding 12", () => {
  it("does not count a trusted-id header the sender wrote below its own headers", () => {
    const { checks, id } = setup();
    // No provider-stamped A-R: the only trusted-id header sits under the sender's
    // Subject, outside the provider's block once the full header block is read.
    const result = checks.fromRaw(
      id,
      raw([
        "Delivered-To: owner@example.org",
        "Received: by 2002:a05:6000:1 with SMTP id x",
        "Subject: Invoice",
        "Authentication-Results: mx.google.com; dkim=pass header.i=@example.com; spf=pass smtp.mailfrom=billing@example.com; dmarc=pass header.from=example.com",
        "From: Bank <billing@example.com>",
      ]),
    );
    expect(result.authserv).toBeNull();
    expect(result.lines.join("\n")).not.toMatch(/pass/);
  });

  it("still reads the provider's header at the top of the block", () => {
    const { checks, id } = setup();
    const result = checks.fromRaw(
      id,
      raw([
        "Delivered-To: owner@example.org",
        "Received: by 2002:a05:6000:1 with SMTP id x",
        "Authentication-Results: mx.google.com; dkim=pass header.i=@example.com; dmarc=pass header.from=example.com",
        "Subject: Invoice",
        "From: Bank <billing@example.com>",
      ]),
    );
    expect(result.authserv).toBe("mx.google.com");
    expect(result.lines).toContain("DMARC pass (example.com)");
  });
});
