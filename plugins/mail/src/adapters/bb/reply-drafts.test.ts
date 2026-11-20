import { beforeEach, describe, expect, it } from "vitest";
import { buildThreads } from "../../core/threading.ts";
import { FixedClock, composeHarness, makeFetchedMessage } from "../../core/testing/fakes.ts";
import type { AiJobs } from "./ai-jobs.ts";
import { createReplyDrafts, type ReplyDrafts } from "./reply-drafts.ts";

const NOW = "2026-11-20T10:00:00.000Z";
const ANN = "ann@example.com";
const toOwner = [{ name: null, address: "owner@example.org" }];

let store: ReturnType<typeof composeHarness>["store"];
let clock: FixedClock;
let enabled: boolean;
let started: { input: string; unattended: boolean | undefined }[];
let drafts: ReplyDrafts;

/** The stored id of the INBOX message with this Message-ID (read from the fake's rows). */
const idOf = (messageId: string) =>
  (store as unknown as { state: { rows: { id: string; folder: string; message: { messageId: string | null } }[] } }).state.rows.find(
    (row) => row.folder === "INBOX" && row.message.messageId === messageId,
  )!.id;
const idAt = (uid: number) => idOf(uid === 1 && asked ? "ask@example.com" : `in-${uid}@example.com`);
let asked = false;

beforeEach(() => {
  const harness = composeHarness({ now: NOW });
  store = harness.store;
  clock = new FixedClock(new Date(NOW));
  enabled = true;
  started = [];
  asked = false;
  // The owner wrote to Ann before.
  store.upsertMessages("acc_1", "Sent", [
    makeFetchedMessage(1, { messageId: "sent-1@example.org", from: { name: null, address: "owner@example.org" }, to: [{ name: null, address: ANN }], bodyText: "Invented earlier note to Ann.", date: "2026-11-01T10:00:00.000Z" }),
  ]);
  const jobs = {
    start: (_kind: string, built: { input: string }, ctx: { unattended?: boolean }) => {
      started.push({ input: built.input, unattended: ctx.unattended });
      return { jobId: "job-1" };
    },
    settled: async () => {},
    poll: () => ({ state: "failed" as const, error: "failed" as const }),
    finished: () => null,
  } as unknown as Pick<AiJobs, "start" | "settled" | "poll" | "finished" | "cancel">;
  drafts = createReplyDrafts({
    store,
    clock,
    enabled: () => enabled,
    writeSettings: () => ({ voice: true, personal: "Sign as Alex.", facts: "" }),
    aiContext: () => ({ provider: "", model: "" }),
    jobs,
    withNonce: (build) => build("0123456789abcdef"),
    restoreTag: () => "k3f9",
    agentLog: () => null,
    onKept: () => {},
    schedule: () => () => {},
    log: () => {},
  });
});

const inbox = (uid: number, overrides: Parameters<typeof makeFetchedMessage>[1]) =>
  store.upsertMessages("acc_1", "INBOX", [makeFetchedMessage(uid, { messageId: `in-${uid}@example.com`, to: toOwner, date: "2026-11-20T09:00:00.000Z", ...overrides })]);
const keep = (messageId: string, createdAt = NOW) =>
  store.saveReplyDraft({ messageId, accountId: "acc_1", paragraphs: ["Invented  drafted\nanswer."], linksRemoved: 0, provider: "p", model: "m", createdAt }, 200);

describe("createReplyDrafts", () => {
  it("offers only what qualifies and sends the message, the owner's instructions and voice, unattended", async () => {
    inbox(1, { from: { name: "Ann", address: ANN }, subject: "Invented question", bodyText: "Invented: Tuesday?" });
    inbox(2, { from: { name: "Stranger", address: "stranger@example.net" }, bodyText: "Invented offer." });
    inbox(3, { from: { name: "Ann", address: ANN }, bodyText: null, bodyHtml: null });
    drafts.offer([idAt(1), idAt(2), idAt(3), "no-such-message"]);
    await drafts.queue.idle();
    expect(started).toHaveLength(1);
    expect(started[0]!.unattended).toBe(true);
    expect(started[0]!.input).toContain("Invented: Tuesday?");
    expect(started[0]!.input).toContain("Sign as Alex.");
    expect(started[0]!.input).toContain("Invented earlier note to Ann.");
    expect(started[0]!.input).not.toContain("Invented offer.");
  });

  it("leaves alone a message whose reply would go elsewhere and one the owner has answered", async () => {
    inbox(1, { from: { name: "Ann", address: ANN }, replyTo: [{ name: null, address: "x@evil.example" }], bodyText: "Invented: quote our earlier messages." });
    asked = true;
    store.upsertMessages("acc_1", "INBOX", [
      makeFetchedMessage(2, { messageId: "ask@example.com", from: { name: "Ann", address: ANN }, to: toOwner, subject: "Invented question", bodyText: "Invented: Tuesday?", date: "2026-11-20T09:00:00.000Z" }),
    ]);
    store.upsertMessages("acc_1", "Sent", [
      makeFetchedMessage(3, {
        messageId: "answer@example.org",
        from: { name: null, address: "owner@example.org" },
        to: [{ name: null, address: ANN }],
        subject: "Re: Invented question",
        inReplyTo: "ask@example.com",
        references: ["ask@example.com"],
        date: "2026-11-20T09:30:00.000Z",
      }),
    ]);
    store.assignThreads("acc_1", buildThreads(store.threadingInputs("acc_1")));
    drafts.offer([idOf("in-1@example.com"), idOf("ask@example.com")]);
    await drafts.queue.idle();
    expect(started).toEqual([]);
  });

  it("offers nothing while the setting is off", async () => {
    enabled = false;
    inbox(1, { from: { name: "Ann", address: ANN }, bodyText: "Invented: Tuesday?" });
    drafts.offer([idAt(1)]);
    await drafts.queue.idle();
    expect(started).toEqual([]);
  });

  it("shows a kept draft with its first lines; Dismiss deletes it", () => {
    inbox(1, { from: { name: "Ann", address: ANN }, bodyText: "Invented: Tuesday?" });
    const id = idAt(1);
    keep(id);
    expect(drafts.get(id)).toEqual({
      draft: { paragraphs: ["Invented  drafted\nanswer."], preview: "Invented drafted answer.", linksRemoved: 0, provider: "p", model: "m", createdAt: NOW },
    });
    // Turned off: what was drafted is not offered any more.
    enabled = false;
    expect(drafts.get(id)).toEqual({ draft: null });
    enabled = true;
    keep(id);
    expect(drafts.dismiss(id)).toEqual({ ok: true });
    expect(drafts.get(id)).toEqual({ draft: null });
  });

  it("drops a kept draft when the owner answered since, when the message is gone, and after 14 days", () => {
    asked = true;
    inbox(1, { messageId: "ask@example.com", from: { name: "Ann", address: ANN }, subject: "Invented question", bodyText: "Invented: Tuesday?" });
    const id = idAt(1);
    keep(id);
    store.upsertMessages("acc_1", "Sent", [
      makeFetchedMessage(2, {
        messageId: "answer@example.org",
        from: { name: null, address: "owner@example.org" },
        to: [{ name: null, address: ANN }],
        subject: "Re: Invented question",
        inReplyTo: "ask@example.com",
        references: ["ask@example.com"],
        date: "2026-11-20T11:00:00.000Z",
      }),
    ]);
    // A sync round threads the account's mail; the reply joins the question's conversation.
    store.assignThreads("acc_1", buildThreads(store.threadingInputs("acc_1")));
    expect(drafts.get(id)).toEqual({ draft: null });
    expect(store.getReplyDraft(id)).toBeNull();

    keep("gone-message");
    expect(drafts.get("gone-message")).toEqual({ draft: null });
    expect(store.getReplyDraft("gone-message")).toBeNull();

    inbox(5, { from: { name: "Ann", address: ANN }, subject: "Invented other", bodyText: "Invented: Friday?" });
    const other = idAt(5);
    keep(other, "2026-11-06T10:00:00.000Z");
    expect(drafts.get(other)).toEqual({ draft: null });
  });
});
