import { describe, expect, it } from "vitest";
import { buildKnownDomains } from "./sender-disguise.ts";
import { failedSenderIds, knownDomainsOf, replyToElsewhereOf, securityViews } from "./sender-view.ts";
import { InMemoryMailStore, makeFetchedMessage, makeStoredAccount } from "./testing/fakes.ts";
import type { SenderCheck } from "./sender-check.ts";

const EPOCH = "1970-01-01T00:00:00.000Z";

function setup() {
  const store = new InMemoryMailStore();
  store.saveAccount(makeStoredAccount({ id: "acc_1", email: "owner@example.org", preset: "gmail" }));
  store.saveFolders("acc_1", [
    { path: "INBOX", name: "INBOX", delimiter: "/", specialUse: "inbox", selectable: true, subscribed: true },
    { path: "Sent", name: "Sent", delimiter: "/", specialUse: "sent", selectable: true, subscribed: true },
  ] as Parameters<InMemoryMailStore["saveFolders"]>[1]);
  const put = (folder: string, uid: number, overrides: Parameters<typeof makeFetchedMessage>[1]) => {
    store.upsertMessages("acc_1", folder, [makeFetchedMessage(uid, overrides)]);
    return store.localFolderIndex("acc_1", folder, EPOCH).find((e) => e.uid === uid)!.id;
  };
  return { store, put };
}

const failedCheck = (): SenderCheck => ({
  state: "failed",
  basis: "results",
  authserv: "mx.google.com",
  decidedBy: "dmarc",
  spf: null,
  dkim: [],
  dmarc: { result: "fail", domain: "example.com" },
  otherDmarc: [],
  multipleFrom: false,
  malformed: false,
  alsoPresent: 0,
});

describe("securityViews (slice 3i)", () => {
  it("reads the stored check, summary, receipt and crypto, and computes warnings at read time", () => {
    const { store, put } = setup();
    const failed = put("INBOX", 1, {
      from: { name: "Billing", address: "billing@example.com" },
      replyTo: [{ name: null, address: "collect@elsewhere.example.net" }],
      senderCheck: failedCheck(),
      receiptRequested: true,
      crypto: { kind: "pgp_signed", opaque: false },
    });
    const old = put("INBOX", 2, {});
    const sent = put("Sent", 3, { replyTo: [{ name: null, address: "collect@elsewhere.example.net" }] });
    const views = securityViews(store, [failed, old, sent, "m_missing"], { known: buildKnownDomains([]), own: new Set(["owner@example.org"]) });
    expect(views.get(failed)).toMatchObject({
      senderCheck: { state: "failed", summary: "DMARC failed" },
      warnings: [{ kind: "reply_to_elsewhere", addresses: ["collect@elsewhere.example.net"] }],
      receiptRequested: true,
      crypto: { kind: "pgp_signed", opaque: false },
    });
    expect(views.get(old)).toMatchObject({ senderCheck: { state: "unknown", summary: "Not checked yet" }, receiptRequested: false, crypto: null });
    expect(views.get(sent)!.warnings).toEqual([]);
    expect(views.has("m_missing")).toBe(false);
  });
});

describe("replyToElsewhereOf (slice 3i, resolution 17)", () => {
  it("names a foreign Reply-To, and nothing for a known domain, own mail or a gone source", () => {
    const { store, put } = setup();
    const own = new Set(["owner@example.org"]);
    const id = put("INBOX", 1, {
      from: { name: null, address: "billing@example.com" },
      replyTo: [{ name: null, address: "collect@elsewhere.example.net" }],
    });
    expect(replyToElsewhereOf(store, id, own)).toEqual(["collect@elsewhere.example.net"]);
    expect(replyToElsewhereOf(store, id, own, buildKnownDomains(["elsewhere.example.net"]))).toEqual([]);
    expect(replyToElsewhereOf(store, "m_missing", own)).toEqual([]);
    const plain = put("INBOX", 2, {});
    let built = 0;
    expect(replyToElsewhereOf(store, plain, own, () => (built++, knownDomainsOf(store)))).toEqual([]);
    expect(built).toBe(0);
  });
});

describe("failedSenderIds (slice 3i)", () => {
  it("lists only rows whose stored check failed", () => {
    const { store, put } = setup();
    const failed = put("INBOX", 1, { senderCheck: failedCheck() });
    const ok = put("INBOX", 2, { senderCheck: { ...failedCheck(), state: "ok", decidedBy: "dmarc", dmarc: { result: "pass", domain: "example.com" } } });
    const unknown = put("INBOX", 3, {});
    expect([...failedSenderIds(store, [failed, ok, unknown])]).toEqual([failed]);
  });
});
