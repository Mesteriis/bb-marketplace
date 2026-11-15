import { describe, expect, it } from "vitest";
import type { SignatureDoc } from "./compose-signature.ts";
import type { ReplySource } from "./compose-reply.ts";
import {
  IDENTITIES_MAX_PER_ACCOUNT,
  PROVIDER_DOMAINS,
  aliasSuggestions,
  identitiesOf,
  identityOf,
  ownIdentityAddresses,
  ownerAddressSets,
  replyIdentity,
  resolveSendCheck,
  sendCheckOnAccepted,
  type AliasRow,
  type IdentityAccount,
  type InboundRow,
} from "./identities.ts";

const signature = (line: string): SignatureDoc => ({
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: line }] }],
});

function account(id: string, email: string, extra: Partial<IdentityAccount> = {}): IdentityAccount {
  return { id, email, displayName: "Anna Example", username: email, signature: null, ...extra };
}

let seq = 0;
function alias(accountId: string, address: string, extra: Partial<AliasRow> = {}): AliasRow {
  seq += 1;
  const stamp = `2026-11-15T10:00:${String(seq).padStart(2, "0")}.000Z`;
  return {
    id: `alias-${seq}`,
    accountId,
    address,
    displayName: null,
    signature: null,
    state: "active",
    sendCheck: "unknown",
    checkMessageId: null,
    createdAt: stamp,
    updatedAt: stamp,
    ...extra,
  };
}

const mail = (address: string) => ({ name: null, address });

function source(extra: Partial<ReplySource> & { deliveredTo?: string[] } = {}): ReplySource & { deliveredTo: string[] } {
  return {
    from: mail("bob@example.org"),
    to: [],
    cc: [],
    replyTo: [],
    subject: "Hello",
    date: null,
    messageId: null,
    inReplyTo: null,
    references: [],
    deliveredTo: [],
    ...extra,
  };
}

describe("identitiesOf", () => {
  it("lists the own address first, then the account's active aliases in creation order", () => {
    const acc = account("a1", "Anna@Example.com", { signature: signature("Anna") });
    const later = alias("a1", "sales@example.com", { createdAt: "2026-11-15T12:00:00.000Z" });
    const earlier = alias("a1", "anna.e@example.com", { createdAt: "2026-11-15T11:00:00.000Z", displayName: "Anna E." });
    const dismissed = alias("a1", "noreply@example.com", { state: "dismissed" });
    const other = alias("a2", "other@example.org");
    const result = identitiesOf(acc, [later, dismissed, other, earlier]);
    expect(result).toEqual([
      {
        accountId: "a1",
        address: "anna@example.com",
        displayName: "Anna Example",
        primary: true,
        signature: signature("Anna"),
        sendCheck: "confirmed",
      },
      {
        accountId: "a1",
        address: "anna.e@example.com",
        displayName: "Anna E.",
        primary: false,
        signature: null,
        sendCheck: "unknown",
      },
      {
        accountId: "a1",
        address: "sales@example.com",
        displayName: "Anna Example",
        primary: false,
        signature: null,
        sendCheck: "unknown",
      },
    ]);
  });

  it("keeps the primary confirmed and null names null", () => {
    const acc = account("a1", "anna@example.com", { displayName: null });
    const [primary, aliased] = identitiesOf(acc, [alias("a1", "sales@example.com", { sendCheck: "rewritten" })]);
    expect(primary!.sendCheck).toBe("confirmed");
    expect(primary!.displayName).toBeNull();
    expect(aliased!.displayName).toBeNull();
    expect(aliased!.sendCheck).toBe("rewritten");
  });

  it("caps aliases at 50 per account", () => {
    expect(IDENTITIES_MAX_PER_ACCOUNT).toBe(50);
  });
});

describe("ownIdentityAddresses and ownerAddressSets", () => {
  const accounts = [
    account("a1", "Anna@Example.com", { username: "anna-login" }),
    account("a2", "bob@example.org", { username: "Bob.Login@Example.org" }),
  ];
  const aliases = [
    alias("a1", "Sales@Example.com"),
    alias("a1", "old@example.com", { state: "dismissed" }),
    alias("a2", "bob.alias@example.org"),
  ];

  it("gives emails, usernames holding @ and active aliases, lower case", () => {
    expect(ownIdentityAddresses(accounts, aliases)).toEqual([
      "anna@example.com",
      "sales@example.com",
      "bob@example.org",
      "bob.login@example.org",
      "bob.alias@example.org",
    ]);
  });

  it("groups them per account", () => {
    expect(ownerAddressSets(accounts, aliases)).toEqual([
      { id: "a1", addresses: ["anna@example.com", "sales@example.com"] },
      { id: "a2", addresses: ["bob@example.org", "bob.login@example.org", "bob.alias@example.org"] },
    ]);
  });

  it("does not repeat a username equal to the email", () => {
    expect(ownIdentityAddresses([account("a1", "anna@example.com", { username: "ANNA@example.com" })], [])).toEqual([
      "anna@example.com",
    ]);
  });
});

describe("identityOf", () => {
  const identities = identitiesOf(account("a1", "anna@example.com"), [alias("a1", "sales@example.com")]);

  it("gives the primary for null, the matching identity, or null for an address not set up", () => {
    expect(identityOf(identities, null)!.primary).toBe(true);
    expect(identityOf(identities, "Sales@Example.com")!.address).toBe("sales@example.com");
    expect(identityOf(identities, "removed@example.com")).toBeNull();
  });
});

describe("replyIdentity", () => {
  const identities = identitiesOf(account("a1", "anna@example.com"), [
    alias("a1", "sales@example.com"),
    alias("a1", "support@example.com"),
  ]);

  it("answers own sent mail from the address it was sent from", () => {
    expect(replyIdentity(source({ from: mail("Sales@example.com"), to: [mail("anna@example.com")] }), identities).address).toBe(
      "sales@example.com",
    );
  });

  it("looks in To, then Cc, then Delivered-To", () => {
    expect(
      replyIdentity(
        source({ to: [mail("x@example.org"), mail("support@example.com")], cc: [mail("sales@example.com")], deliveredTo: ["anna@example.com"] }),
        identities,
      ).address,
    ).toBe("support@example.com");
    expect(
      replyIdentity(source({ to: [mail("x@example.org")], cc: [mail("SALES@example.com")], deliveredTo: ["support@example.com"] }), identities)
        .address,
    ).toBe("sales@example.com");
    expect(replyIdentity(source({ to: [mail("list@example.org")], deliveredTo: ["support@example.com"] }), identities).address).toBe(
      "support@example.com",
    );
  });

  it("takes the first identity in order when several are in To", () => {
    expect(
      replyIdentity(source({ to: [mail("support@example.com"), mail("sales@example.com")] }), identities).address,
    ).toBe("sales@example.com");
    expect(replyIdentity(source({ to: [mail("support@example.com"), mail("anna@example.com")] }), identities).primary).toBe(true);
  });

  it("falls back to the own address", () => {
    expect(replyIdentity(source({ to: [mail("list@example.org")] }), identities).primary).toBe(true);
  });
});

describe("aliasSuggestions", () => {
  const known = new Set(["anna@example.com", "sales@example.com"]);
  const none = new Set<string>();
  const row = (to: string[], extra: Partial<InboundRow> = {}): InboundRow => ({
    to,
    cc: [],
    deliveredTo: null,
    date: "2026-11-10T10:00:00.000Z",
    ...extra,
  });

  it("ignores rows that came to a known address", () => {
    const rows = [row(["Anna@example.com", "promo@example.com"]), row(["promo@example.com"], { cc: ["sales@example.com"] })];
    expect(aliasSuggestions(rows, known, none, ["example.com"], [])).toEqual([]);
  });

  it("prefers Delivered-To over To and Cc", () => {
    const rows = [
      row(["list@example.net"], { deliveredTo: ["hidden@example.net"] }),
      row(["list@example.net"], { deliveredTo: ["hidden@example.net"], date: "2026-11-12T10:00:00.000Z" }),
    ];
    expect(aliasSuggestions(rows, known, none, ["example.com"], [])).toEqual([
      { address: "hidden@example.net", count: 2, lastDate: "2026-11-12T10:00:00.000Z" },
    ]);
  });

  it("treats an empty Delivered-To (headers read, none present) like unknown: To and Cc by the domain rule", () => {
    const rows = [
      row(["anna.e@example.com", "friend@example.org"], { deliveredTo: [] }),
      row(["anna.e@example.com", "friend@example.org"], { deliveredTo: [] }),
    ];
    expect(aliasSuggestions(rows, known, none, ["example.com"], []).map((s) => s.address)).toEqual(["anna.e@example.com"]);
  });

  it("leaves another person on the message out by the domain rule", () => {
    const rows = [row(["anna.e@example.com", "friend@example.org"]), row(["anna.e@example.com", "friend@example.org"])];
    expect(aliasSuggestions(rows, known, none, ["example.com"], []).map((s) => s.address)).toEqual(["anna.e@example.com"]);
  });

  it("admits the provider's own domains", () => {
    const rows = [row(["anna.hidden@icloud.com"]), row(["anna.hidden@icloud.com"])];
    expect(aliasSuggestions(rows, known, none, ["example.com"], []).map((s) => s.address)).toEqual([]);
    expect(aliasSuggestions(rows, known, none, ["example.com"], PROVIDER_DOMAINS.icloud).map((s) => s.address)).toEqual([
      "anna.hidden@icloud.com",
    ]);
  });

  it("excludes dismissed and known addresses, and needs two messages", () => {
    const rows = [
      row(["old@example.com"]),
      row(["old@example.com"]),
      row(["once@example.com"]),
      row([], { deliveredTo: ["anna@example.com"] }),
      row([], { deliveredTo: ["anna@example.com"] }),
    ];
    expect(aliasSuggestions(rows, known, new Set(["old@example.com"]), ["example.com"], [])).toEqual([]);
  });

  it("orders by count then latest date and keeps the top ten", () => {
    const rows: InboundRow[] = [];
    for (let i = 0; i < 12; i++) {
      const address = `a${i}@example.com`;
      const count = i < 2 ? 3 : 2;
      for (let n = 0; n < count; n++) rows.push(row([address], { date: `2026-11-${String(10 + i).padStart(2, "0")}T10:00:00.000Z` }));
    }
    const result = aliasSuggestions(rows, known, none, ["example.com"], []);
    expect(result).toHaveLength(10);
    expect(result.map((s) => s.address).slice(0, 4)).toEqual(["a1@example.com", "a0@example.com", "a11@example.com", "a10@example.com"]);
  });

  it("drops invalid addresses and counts a message once", () => {
    const rows = [
      row(["not an address", "x@example.com", "X@example.com"]),
      row(["not an address", "x@example.com"]),
    ];
    expect(aliasSuggestions(rows, known, none, ["example.com"], [])).toEqual([
      { address: "x@example.com", count: 2, lastDate: "2026-11-10T10:00:00.000Z" },
    ]);
  });

  it("lists provider domains per preset", () => {
    expect(PROVIDER_DOMAINS).toEqual({
      icloud: ["icloud.com", "me.com", "mac.com"],
      gmail: ["gmail.com", "googlemail.com"],
      other: [],
    });
  });
});

describe("send check", () => {
  it("waits for the Sent copy where the server keeps it", () => {
    expect(sendCheckOnAccepted("server")).toBe("pending");
    expect(sendCheckOnAccepted("append")).toBe("accepted");
  });

  it("resolves from the Sent copy's From", () => {
    expect(resolveSendCheck("sales@example.com", "Sales@Example.com")).toBe("confirmed");
    expect(resolveSendCheck("sales@example.com", "anna@example.com")).toBe("rewritten");
    expect(resolveSendCheck("sales@example.com", null)).toBeNull();
  });
});
