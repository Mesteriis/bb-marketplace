import { beforeEach, describe, expect, it } from "vitest";
import { PROPOSAL_TTL_MS } from "./agent-propose.ts";
import {
  AGENT_RESULT,
  ProposalError,
  cancelProposal,
  checkSubmit,
  describeProposalSubmission,
  draftHash,
  mailProposeParamsSchema,
  proposeMail,
  queueConfirmed,
  viewProposal,
  type MailProposeParams,
  resolveSendingAccount,
} from "./agent-proposals.ts";
import { ATTACHMENT_CAP_BYTES, outgoingOf } from "./compose.ts";
import { SEND_RATE_PER_MINUTE, UNDO_MS, cancelSend, retrySend, runOutboxOnce, sendNow } from "./compose-outbox.ts";
import { SendError } from "./ports.ts";
import { FakeBuilder, composeHarness, makeFetchedMessage, makeStoredAccount } from "./testing/fakes.ts";

let h: ReturnType<typeof composeHarness>;
let d: ReturnType<typeof composeHarness>["proposalDeps"];

beforeEach(() => {
  h = composeHarness();
  d = h.proposalDeps;
});

const THREAD = "thread_1";
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

function stored(overrides: Parameters<typeof makeFetchedMessage>[1] = {}, folder = "INBOX", uid = 1): string {
  h.store.upsertMessages("acc_1", folder, [makeFetchedMessage(uid, overrides)]);
  return h.store.localFolderIndex("acc_1", folder, "1970-01-01T00:00:00.000Z").find((e) => e.uid === uid)!.id;
}

function params(overrides: Partial<MailProposeParams> & Record<string, unknown> = {}): MailProposeParams {
  return mailProposeParamsSchema.parse({
    kind: "new",
    accountId: "acc_1",
    to: ["Eve Trusted <bob@example.com>"],
    subject: "Invented plan",
    body: "Hello Bob\nSee www.example.net/agenda for the plan.",
    ...overrides,
  });
}

function propose(overrides: Partial<MailProposeParams> & Record<string, unknown> = {}, threadId = THREAD) {
  return proposeMail(d, params(overrides), { threadId });
}

async function viewed(overrides: Partial<MailProposeParams> = {}, threadId = THREAD) {
  const proposed = await propose(overrides, threadId);
  const view = await viewProposal(d, proposed);
  if (view.state !== "ready") throw new Error(`view ${view.state}`);
  return { ...proposed, view, token: view.viewToken };
}

function submit(action: "send" | "open", p: { proposalId: string; contentHash: string; token: string }) {
  return { action, proposalId: p.proposalId, contentHash: p.contentHash, viewToken: p.token };
}

async function refusal(promise: Promise<unknown>): Promise<ProposalError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ProposalError) return error;
    throw error;
  }
  throw new Error("not refused");
}

describe("proposeMail", () => {
  it("creates one hidden agent draft and a pending proposal; agent display names are dropped", async () => {
    const created: unknown[] = [];
    const createDraft = h.store.createDraft.bind(h.store);
    h.store.createDraft = (input) => {
      created.push(structuredClone(input));
      return createDraft(input);
    };
    const { proposalId, contentHash } = await propose();
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ origin: "agent", proposalId, importHtml: null });

    const proposal = h.store.getProposal(proposalId)!;
    expect(proposal).toMatchObject({ state: "pending", threadId: THREAD, kind: "new", contentSha256: contentHash });
    expect(proposal.expiresAt).toBe(new Date(h.clock.now().getTime() + PROPOSAL_TTL_MS).toISOString());
    const draft = h.store.getDraft(proposal.draftId!)!;
    expect(draft.to).toEqual([{ name: null, address: "bob@example.com" }]);
    expect(draft.subject).toBe("Invented plan");
    expect(await draftHash(h.store, draft)).toBe(contentHash);
    expect(JSON.stringify(draft.doc)).not.toContain("blockquote");
  });

  it("a reply keeps the computed recipients, records the agent's additions and quotes an HTML-only original as text", async () => {
    const id = stored({
      from: { name: "Sender", address: "sender@example.org" },
      subject: "Invented question",
      bodyText: null,
      bodyHtml: "<p>Invented original line</p>",
    });
    const { proposalId } = await propose({
      kind: "reply",
      sourceMessageId: id,
      accountId: undefined,
      subject: undefined,
      to: [],
      cc: ["extra@example.net", "SENDER@example.org"],
      body: "Thanks",
    });
    const proposal = h.store.getProposal(proposalId)!;
    const draft = h.store.getDraft(proposal.draftId!)!;
    expect(draft.to.map((a) => a.address)).toEqual(["sender@example.org"]);
    expect(draft.cc.map((a) => a.address)).toEqual(["extra@example.net"]);
    expect(proposal.added).toEqual(["extra@example.net"]);
    expect(draft.subject).toBe("Re: Invented question");
    expect(draft.importHtml).toBeNull();
    expect(draft.inReplyTo).toBe("<msg-1@example.org>");
    const quote = JSON.stringify(draft.doc);
    expect(quote).toContain("blockquote");
    expect(quote).toContain("Invented original line");
    const { text: rendered } = (await import("./compose-doc.ts")).renderDoc(draft.doc as never);
    expect(rendered).toContain("Invented original line");
  });

  it("a forward carries the chosen subset of the source's attachments, in source order", async () => {
    const id = stored();
    const file = (name: string) => ({
      fileName: name,
      mimeType: "text/plain",
      bytes: new TextEncoder().encode(`invented ${name}`),
      contentId: null,
    });
    h.reader.originals.set(id, { replyTo: [], bcc: [], html: null, attachments: [file("a.txt"), file("b.txt"), file("c.txt")] });
    const { proposalId } = await propose({
      kind: "forward",
      sourceMessageId: id,
      accountId: undefined,
      subject: undefined,
      forwardAttachments: [2, 0],
    });
    const draft = h.store.getDraft(h.store.getProposal(proposalId)!.draftId!)!;
    expect(h.store.listAttachments(draft.id).map((a) => a.fileName)).toEqual(["a.txt", "c.txt"]);
    expect(draft.subject).toBe("Fwd: Invented subject 1");
  });

  it("a reply naming the source's own account is accepted", async () => {
    const id = stored();
    const { proposalId } = await propose({ kind: "reply", sourceMessageId: id, accountId: "acc_1", subject: undefined });
    const draft = h.store.getDraft(h.store.getProposal(proposalId)!.draftId!)!;
    expect(draft.accountId).toBe("acc_1");
    expect(draft.messageId).toMatch(/@example\.org>$/);
  });

  it("records forwarded attachments left out over the cap", async () => {
    const id = stored();
    h.reader.originals.set(id, {
      replyTo: [],
      bcc: [],
      html: null,
      attachments: [{ fileName: "big.bin", mimeType: "application/octet-stream", bytes: new Uint8Array(ATTACHMENT_CAP_BYTES + 1), contentId: null }],
    });
    const { proposalId } = await propose({ kind: "forward", sourceMessageId: id, accountId: undefined, subject: undefined });
    expect(h.store.getProposal(proposalId)!.leftOut).toBe(1);
  });

  describe("refusals have fixed texts and leave no draft", () => {
    const cases: [string, () => Promise<unknown>, string][] = [
      ["invalid address", () => propose({ to: ["not an address at evil.example.com"] }), "invalid_address:syntax"],
      ["no recipients", () => propose({ to: [] }), "no_recipients"],
      [
        "too many recipients",
        () =>
          propose({
            to: Array.from({ length: 60 }, (_, i) => `to${i}@example.com`),
            cc: Array.from({ length: 41 }, (_, i) => `cc${i}@example.com`),
          }),
        "too_many_recipients",
      ],
      ["subject missing", () => propose({ subject: undefined }), "subject_missing"],
      ["tag characters in the body", () => propose({ body: "Hello\u{E0049}\u{E0047}\u{E004E}" }), "hidden_text"],
      ["a filler letter in the body", () => propose({ body: "Hello \u3164 there" }), "hidden_text"],
      ["tag characters in the subject", () => propose({ subject: "Plan\u{E0041}" }), "hidden_text"],
      ["a filler letter in the subject", () => propose({ subject: "Plan\uFFA0" }), "hidden_text"],
      ["unknown source", () => propose({ kind: "reply", sourceMessageId: "m_missing", subject: undefined }), "source_not_found"],
      ["no source id", () => propose({ kind: "reply", subject: undefined }), "source_not_found"],
      ["attachments outside a forward", () => propose({ forwardAttachments: [0] }), "attachment_index"],
      [
        "a reply from another account than the source's",
        () => propose({ kind: "reply", sourceMessageId: stored(), accountId: "acc_2", subject: undefined }),
        "account_mismatch",
      ],
      [
        "a forward from another account than the source's",
        () => propose({ kind: "forward", sourceMessageId: stored(), accountId: "acc_2", subject: undefined }),
        "account_mismatch",
      ],
    ];
    for (const [name, run, kind] of cases) {
      it(name, async () => {
        const error = await refusal(run());
        expect(error.kind).toBe(kind);
        expect(error.message).not.toMatch(/@|example|Invented/);
        expect(h.store.listDrafts("acc_1")).toEqual([]);
      });
    }

    it("an unknown account names only the owner's own addresses to choose from", async () => {
      const error = await refusal(propose({ accountId: "acc_missing" }));
      expect(error.kind).toBe("account_unknown");
      const owned = new Set(h.store.listAccounts().map((a) => a.email));
      const named = error.message.match(/[^\s,:]+@[^\s,]+(?=[,.](\s|$))/g) ?? [];
      expect(named.length).toBeGreaterThan(0);
      for (const address of named) expect(owned.has(address)).toBe(true);
      expect(h.store.listDrafts("acc_1")).toEqual([]);
    });

    it("an attachment index past the source's attachments", async () => {
      const id = stored();
      h.reader.originals.set(id, { replyTo: [], bcc: [], html: null, attachments: [] });
      const error = await refusal(
        propose({ kind: "forward", sourceMessageId: id, accountId: undefined, subject: undefined, forwardAttachments: [0] }),
      );
      expect(error.kind).toBe("attachment_index");
      expect(h.store.listDrafts("acc_1")).toEqual([]);
    });

    it("a quote over the document size", async () => {
      const id = stored({ bodyText: "x".repeat(2 * 1024 * 1024 + 10) });
      const error = await refusal(propose({ kind: "reply", sourceMessageId: id, accountId: undefined, subject: undefined }));
      expect(error.kind).toBe("too_large");
      expect(h.store.listDrafts("acc_1")).toEqual([]);
    });

    it("no SMTP, a failed sign-in, a locked vault", async () => {
      h.store.saveAccount({ ...h.store.getAccount("acc_1")!, smtp: null });
      expect((await refusal(propose())).kind).toBe("smtp_missing");
      h.store.saveAccount({ ...h.store.getAccount("acc_1")!, smtp: { host: "smtp.example.org", port: 465, security: "tls", username: null }, authFailed: true });
      expect((await refusal(propose())).kind).toBe("account");
      h.proposal.vaultOpen = false;
      expect((await refusal(propose())).kind).toBe("vault");
      expect(h.store.listDrafts("acc_1")).toEqual([]);
    });
  });

  it("counts the caps from the store", async () => {
    await propose();
    expect((await refusal(propose())).kind).toBe("caps:pending_thread");
    await propose({}, "thread_2");
    await propose({}, "thread_3");
    const error = await refusal(propose({}, "thread_4"));
    expect(error.kind).toBe("caps:pending_total");
    expect(error.message).toBe("Too many proposals are waiting for the owner.");
  });

  it("three cancelled proposals in a row cool the thread down", async () => {
    for (let i = 0; i < 3; i++) {
      const { proposalId } = await propose();
      cancelProposal(d, proposalId, "user");
    }
    expect((await refusal(propose())).kind).toBe("caps:cool_down");
    h.advance(60 * 60 * 1000 + 1);
    await expect(propose()).resolves.toBeDefined();
  });
});

describe("viewProposal", () => {
  it("shows the whole message with flags, links and hidden characters, and stores the token's hash", async () => {
    h.store.upsertMessages("acc_1", "Sent", [makeFetchedMessage(5, { to: [{ name: null, address: "known@example.com" }] })]);
    const proposed = await propose({
      to: ["known@example.com"],
      cc: ["new@example.org"],
      bcc: ["hidden@example.net"],
      subject: "Invented‮ plan",
      body: "Line one​\nVisit https://example.net/x and www.example.com",
    });
    const result = await viewProposal(d, proposed);
    expect(result.state).toBe("ready");
    if (result.state !== "ready") return;
    const { view } = result;
    expect(view.to).toEqual([{ address: "known@example.com", name: null, flags: ["outside"] }]);
    expect(view.cc).toEqual([{ address: "new@example.org", name: null, flags: ["new"] }]);
    expect(view.bcc).toEqual([{ address: "hidden@example.net", name: null, flags: ["new", "outside"] }]);
    expect(view.subject).toBe("Invented plan");
    expect(view.hiddenChars).toBe(2);
    expect(view.bodyText).toBe("Line one\nVisit https://example.net/x and www.example.com");
    expect(view.quoteText).toBeNull();
    expect(view.links.map((l) => l.host)).toEqual(["example.net", "www.example.com"]);
    expect(view.source).toBeNull();
    expect(view.expiresAt).toBe(h.store.getProposal(proposed.proposalId)!.expiresAt);
    const stored = h.store.getProposal(proposed.proposalId)!;
    expect(stored.viewTokenSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(stored.viewTokenSha256).not.toBe(result.viewToken);
    expect(stored.viewedAt).toBe(h.clock.now().toISOString());
  });

  it("a reply's view has its source and quote, the quote's links not listed", async () => {
    const id = stored({ subject: "Invented question", bodyText: "Original at www.example.org/old" });
    const proposed = await propose({ kind: "reply", sourceMessageId: id, accountId: undefined, subject: undefined, to: [], body: "Yes" });
    const result = await viewProposal(d, proposed);
    if (result.state !== "ready") throw new Error(result.state);
    expect(result.view.source).toEqual({ fromAddress: "sender@example.org", subject: "Invented question" });
    expect(result.view.quoteText).toContain("Original at www.example.org/old");
    expect(result.view.links).toEqual([]);
  });

  it("recomputes the hash: a draft changed after proposing refuses the proposal and drops the draft", async () => {
    const proposed = await propose();
    const draftId = h.store.getProposal(proposed.proposalId)!.draftId!;
    const draft = h.store.getDraft(draftId)!;
    h.store.saveDraft(draftId, draft.revision, { ...draft, subject: "Changed" }, h.clock.now().toISOString());
    expect(await viewProposal(d, proposed)).toEqual({ state: "changed" });
    expect(h.store.getProposal(proposed.proposalId)).toMatchObject({ state: "refused", draftId: null });
    expect(h.store.getDraft(draftId)).toBeNull();
  });

  it("a wrong hash, an unknown id, an expired card", async () => {
    const proposed = await propose();
    expect(await viewProposal(d, { ...proposed, contentHash: "0".repeat(64) })).toEqual({ state: "changed" });
    expect(await viewProposal(d, { ...proposed, proposalId: "nope" })).toEqual({ state: "gone" });
    h.advance(PROPOSAL_TTL_MS);
    expect(await viewProposal(d, proposed)).toEqual({ state: "gone" });
  });

  it("token rotation: only the latest view submits, and a view after the card was answered is opened_elsewhere", async () => {
    const proposed = await propose();
    const first = await viewProposal(d, proposed);
    const second = await viewProposal(d, proposed);
    if (first.state !== "ready" || second.state !== "ready") throw new Error("not ready");
    expect(first.viewToken).not.toBe(second.viewToken);
    expect(await checkSubmit(d, proposed.proposalId, submit("send", { ...proposed, token: second.viewToken }))).toEqual({
      action: "send",
    });
    expect(await viewProposal(d, proposed)).toEqual({ state: "opened_elsewhere" });
  });

  it("an older view's token leaves the proposal pending with its draft, and does not count toward the cool-down", async () => {
    const proposed = await propose();
    const first = await viewProposal(d, proposed);
    await viewProposal(d, proposed);
    if (first.state !== "ready") throw new Error("not ready");
    const draftId = h.store.getProposal(proposed.proposalId)!.draftId!;
    const draftBefore = JSON.stringify(h.store.getDraft(draftId));
    for (let i = 0; i < 3; i += 1) {
      expect(await checkSubmit(d, proposed.proposalId, submit("send", { ...proposed, token: first.viewToken }))).toEqual({
        retry: "opened_elsewhere",
      });
    }
    expect(h.store.getProposal(proposed.proposalId)).toMatchObject({ state: "pending", draftId });
    expect(JSON.stringify(h.store.getDraft(draftId))).toBe(draftBefore);
    expect(h.store.listOutbox(null)).toEqual([]);
    expect(h.store.proposalCapRows(h.clock.now().toISOString()).map((r) => r.state)).toEqual(["pending"]);
    // Reopened: the latest view submits.
    const again = await viewProposal(d, proposed);
    if (again.state !== "ready") throw new Error("not ready");
    expect(await checkSubmit(d, proposed.proposalId, submit("send", { ...proposed, token: again.viewToken }))).toEqual({
      action: "send",
    });
  });

  it("a content change still refuses even with a stale token", async () => {
    const proposed = await propose();
    await viewProposal(d, proposed);
    const draftId = h.store.getProposal(proposed.proposalId)!.draftId!;
    h.store.addAttachment(draftId, { fileName: "x.txt", mimeType: "text/plain", size: 1, sha256: "0".repeat(64), data: new Uint8Array(1) });
    expect(await checkSubmit(d, proposed.proposalId, submit("send", { ...proposed, token: "t".repeat(43) }))).toEqual({
      refused: "changed",
    });
    expect(h.store.getProposal(proposed.proposalId)!.state).toBe("refused");
  });
});

describe("proposeMail caps under concurrency", () => {
  it("8 concurrent proposals in one thread: exactly one is stored, the rest hit the cap and leave no draft", async () => {
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => propose()));
    const ok = results.filter((r) => r.status === "fulfilled");
    expect(ok).toHaveLength(1);
    for (const r of results) {
      if (r.status === "rejected") {
        expect(r.reason).toBeInstanceOf(ProposalError);
        expect((r.reason as ProposalError).kind).toBe("caps:pending_thread");
      }
    }
    expect(h.store.proposalCapRows(h.clock.now().toISOString())).toHaveLength(1);
    expect(h.store.listDrafts("acc_1")).toHaveLength(1);
  });

  it("concurrent proposals in different threads stop at the total pending cap", async () => {
    const results = await Promise.allSettled(Array.from({ length: 6 }, (_, i) => propose({}, `thread_${i}`)));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(3);
    expect(h.store.listDrafts("acc_1")).toHaveLength(3);
  });
});

describe("viewProposal hidden text", () => {
  it("reveals soft hyphens, invisible operators, variation selectors and line separators, and counts them", async () => {
    const proposed = await propose({ body: "Pay\u00AD now\u2062\uFE0F\u2028done" });
    const result = await viewProposal(d, proposed);
    if (result.state !== "ready") throw new Error(result.state);
    expect(result.view.bodyText).toBe("Pay nowdone");
    expect(result.view.hiddenChars).toBe(4);
  });
});

describe("checkSubmit", () => {
  const refusedCases: [string, (p: Awaited<ReturnType<typeof viewed>>) => unknown][] = [
    ["a malformed value", (p) => ({ ...submit("send", p), extra: 1 })],
    ["another proposal's id", (p) => ({ ...submit("send", p), proposalId: "other" })],
    ["a wrong hash", (p) => ({ ...submit("send", p), contentHash: "f".repeat(64) })],
    ["a missing token", (p) => ({ action: "send", proposalId: p.proposalId, contentHash: p.contentHash })],
  ];
  for (const [name, value] of refusedCases) {
    it(`refuses ${name}, drops the draft and queues nothing`, async () => {
      const p = await viewed();
      const draftId = h.store.getProposal(p.proposalId)!.draftId!;
      expect(await checkSubmit(d, p.proposalId, value(p))).toEqual({ refused: "changed" });
      expect(h.store.getProposal(p.proposalId)).toMatchObject({ state: "refused", draftId: null });
      expect(h.store.getDraft(draftId)).toBeNull();
      expect(h.store.listOutbox(null)).toEqual([]);
    });
  }

  it("a wrong token or a submit with no view is not a content change: the card was opened elsewhere", async () => {
    const p = await propose();
    expect(await checkSubmit(d, p.proposalId, submit("send", { ...p, token: "t".repeat(43) }))).toEqual({
      retry: "opened_elsewhere",
    });
    const v = await viewed({}, "thread_2");
    expect(await checkSubmit(d, v.proposalId, { ...submit("send", v), viewToken: "x".repeat(43) })).toEqual({
      retry: "opened_elsewhere",
    });
    expect(h.store.getProposal(p.proposalId)!.state).toBe("pending");
    expect(h.store.getProposal(v.proposalId)!.state).toBe("pending");
  });

  it("refuses a hidden draft changed after the view", async () => {
    const p = await viewed();
    const draftId = h.store.getProposal(p.proposalId)!.draftId!;
    h.store.addAttachment(draftId, { fileName: "x.txt", mimeType: "text/plain", size: 1, sha256: "0".repeat(64), data: new Uint8Array(1) });
    expect(await checkSubmit(d, p.proposalId, submit("send", p))).toEqual({ refused: "changed" });
    expect(h.store.getDraft(draftId)).toBeNull();
  });

  it("refuses after expiry", async () => {
    const p = await viewed();
    h.advance(PROPOSAL_TTL_MS);
    expect(await checkSubmit(d, p.proposalId, submit("send", p))).toEqual({ refused: "changed" });
    expect(h.store.getProposal(p.proposalId)).toMatchObject({ state: "expired", draftId: null });
  });

  it("a reused submit loses and leaves the first one alone", async () => {
    const p = await viewed();
    expect(await checkSubmit(d, p.proposalId, submit("send", p))).toEqual({ action: "send" });
    expect(await checkSubmit(d, p.proposalId, submit("send", p))).toEqual({ refused: "changed" });
    const proposal = h.store.getProposal(p.proposalId)!;
    expect(proposal.state).toBe("confirming");
    expect(h.store.getDraft(proposal.draftId!)).not.toBeNull();
  });

  it("two racing submits give one confirming", async () => {
    const p = await viewed();
    const results = await Promise.all([
      checkSubmit(d, p.proposalId, submit("send", p)),
      checkSubmit(d, p.proposalId, submit("send", p)),
    ]);
    expect(results.filter((r) => "action" in r)).toHaveLength(1);
    expect(h.store.getProposal(p.proposalId)!.state).toBe("confirming");
  });

  it("open releases the draft in the same call", async () => {
    const p = await viewed();
    const draftId = h.store.getProposal(p.proposalId)!.draftId!;
    expect(await checkSubmit(d, p.proposalId, submit("open", p))).toEqual({ action: "open" });
    expect(h.store.getProposal(p.proposalId)).toMatchObject({ state: "opened", draftId });
    expect(h.store.getDraft(draftId)).toMatchObject({ proposalId: null, origin: "agent" });
  });

  it("describes each outcome with a true title and the proposal id only", () => {
    expect(describeProposalSubmission("p1", { action: "send" })).toEqual({ title: "Email confirmed", payload: { proposalId: "p1" } });
    expect(describeProposalSubmission("p1", { action: "open" }).title).toBe("Opened in Mail");
    expect(describeProposalSubmission("p1", { refused: "changed" }).title).toBe("Not sent: the proposal changed");
    expect(describeProposalSubmission("p1", { retry: "opened_elsewhere" }).title).toBe(
      "Not sent: this card was opened elsewhere; reopen it",
    );
  });
});

describe("queueConfirmed", () => {
  async function confirmed() {
    const p = await viewed();
    expect(await checkSubmit(d, p.proposalId, submit("send", p))).toEqual({ action: "send" });
    return p;
  }

  it("queues the hidden draft as an agent send with id = proposal id and the MIME queueSend builds", async () => {
    const p = await confirmed();
    const draftId = h.store.getProposal(p.proposalId)!.draftId!;
    const result = await queueConfirmed(d, p.proposalId);
    expect(result).toEqual({ outboxId: p.proposalId });
    const row = h.store.getOutbox(p.proposalId)!;
    expect(row).toMatchObject({ origin: "agent", draftId, state: "queued" });
    const expected = await new FakeBuilder().build(
      outgoingOf(d, h.store.getAccount("acc_1")!, h.store.getDraft(draftId)!, true),
    );
    expect(text(h.store.outboxPayload(p.proposalId)!.mime)).toBe(text(expected));
    expect(h.store.getProposal(p.proposalId)).toMatchObject({ state: "queued", outboxId: p.proposalId });
    expect(h.notifier.events).toEqual([{ accountId: "acc_1", id: p.proposalId, state: "queued" }]);
  });

  it("only a confirming proposal is queued", async () => {
    const p = await viewed();
    expect(await queueConfirmed(d, p.proposalId)).toEqual({ notQueued: "account" });
    expect(h.store.listOutbox(null)).toEqual([]);
  });

  it("a confirmed proposal whose hidden draft is gone is settled as expired, not left confirming", async () => {
    const p = await confirmed();
    h.store.deleteDraft(h.store.getProposal(p.proposalId)!.draftId!);
    expect(await queueConfirmed(d, p.proposalId)).toEqual({ lost: true });
    expect(h.store.getProposal(p.proposalId)).toMatchObject({ state: "expired", draftId: null });
    expect(h.store.listOutbox(null)).toEqual([]);
    // It no longer blocks the thread.
    await expect(propose()).resolves.toMatchObject({ proposalId: expect.any(String) });
  });

  it("a From name or address changed after the check refuses with changed and queues nothing", async () => {
    for (const [field, value, thread] of [["displayName", "Renamed Owner", "thread_f1"], ["email", "renamed@example.org", "thread_f2"]] as const) {
      const p = await viewed({}, thread);
      expect(await checkSubmit(d, p.proposalId, submit("send", p))).toEqual({ action: "send" });
      const account = h.store.getAccount("acc_1")!;
      h.store.saveAccount({ ...account, [field]: value });
      expect(await queueConfirmed(d, p.proposalId), field).toEqual({ refused: "changed" });
      expect(h.store.getProposal(p.proposalId), field).toMatchObject({ state: "refused", draftId: null });
      expect(h.store.listOutbox(null), field).toEqual([]);
      h.store.saveAccount(account);
    }
  });

  it("a From renamed while the hash is computed is caught by queueSend's From check", async () => {
    const p = await confirmed();
    const account = h.store.getAccount("acc_1")!;
    const original = h.store.attachmentData.bind(h.store);
    let calls = 0;
    h.store.attachmentData = (id: string) => {
      calls += 1;
      if (calls === 1) queueMicrotask(() => h.store.saveAccount({ ...account, displayName: "Renamed Owner" }));
      return original(id);
    };
    expect(await queueConfirmed(d, p.proposalId)).toEqual({ refused: "changed" });
    expect(h.store.getProposal(p.proposalId)).toMatchObject({ state: "refused", draftId: null });
    expect(h.store.listOutbox(null)).toEqual([]);
  });

  it("the send cap after the click keeps the message as an owner draft", async () => {
    const p = await confirmed();
    for (let i = 0; i < SEND_RATE_PER_MINUTE; i++) d.rate.take("acc_1");
    const draftId = h.store.getProposal(p.proposalId)!.draftId!;
    expect(await queueConfirmed(d, p.proposalId)).toEqual({ notQueued: "rate_limited" });
    expect(h.store.getProposal(p.proposalId)!.state).toBe("opened");
    expect(h.store.getDraft(draftId)!.proposalId).toBeNull();
    expect(h.store.listOutbox(null)).toEqual([]);
    expect(AGENT_RESULT.notQueued("rate_limited")).toBe(
      "The owner confirmed the message, but it could not be queued: too many messages were sent in the last minute. It is kept as a draft in Mail and has not been sent.",
    );
  });

  it("a locked vault or a failed sign-in after the click", async () => {
    const p = await confirmed();
    h.proposal.vaultOpen = false;
    expect(await queueConfirmed(d, p.proposalId)).toEqual({ notQueued: "account" });
    expect(h.store.getProposal(p.proposalId)!.state).toBe("opened");

    h.proposal.vaultOpen = true;
    const q = await viewed({ to: ["other@example.com"] }, );
    expect(await checkSubmit(d, q.proposalId, submit("send", q))).toEqual({ action: "send" });
    h.store.recordSyncResult("acc_1", { lastSyncAt: null, lastError: null, authFailed: true });
    expect(await queueConfirmed(d, q.proposalId)).toEqual({ notQueued: "account" });
    expect(h.store.getProposal(q.proposalId)!.state).toBe("opened");
  });

  it("Undo of an agent send turns the draft into an owner draft and marks the proposal opened", async () => {
    const p = await confirmed();
    await queueConfirmed(d, p.proposalId);
    const draftId = h.store.getProposal(p.proposalId)!.draftId!;
    expect(cancelSend(d, p.proposalId)).toEqual({ cancelled: true, draftId });
    expect(h.store.getOutbox(p.proposalId)).toBeNull();
    expect(h.store.getDraft(draftId)).toMatchObject({ proposalId: null, origin: "agent" });
    expect(h.store.getProposal(p.proposalId)!.state).toBe("opened");
    expect(h.notifier.events.at(-1)).toEqual({ accountId: "acc_1", id: p.proposalId, state: "cancelled" });
  });

  it("Edit of a held agent send does the same; Send now keeps origin agent", async () => {
    const p = await confirmed();
    await queueConfirmed(d, p.proposalId);
    h.advance(UNDO_MS + 1);
    h.store.recoverOutboxOnStart(h.clock.now().toISOString());
    sendNow(d, p.proposalId);
    expect(h.store.getOutbox(p.proposalId)).toMatchObject({ state: "queued", origin: "agent" });
    h.advance(UNDO_MS + 1);
    h.store.recoverOutboxOnStart(h.clock.now().toISOString());
    expect(cancelSend(d, p.proposalId).cancelled).toBe(true);
    expect(h.store.getProposal(p.proposalId)!.state).toBe("opened");
  });

  it("Retry of a failed agent send keeps origin agent", async () => {
    const p = await confirmed();
    await queueConfirmed(d, p.proposalId);
    h.advance(UNDO_MS + 1);
    h.transport.answer(new SendError("rejected_message", false));
    await runOutboxOnce(h.deps, new AbortController().signal);
    expect(h.store.getOutbox(p.proposalId)!.state).toBe("failed");
    retrySend(d, p.proposalId);
    expect(h.store.getOutbox(p.proposalId)).toMatchObject({ state: "queued", origin: "agent" });
  });
});

describe("cancelProposal", () => {
  it("cancels or expires a pending card and deletes its hidden draft", async () => {
    const a = await propose();
    const draftId = h.store.getProposal(a.proposalId)!.draftId!;
    expect(cancelProposal(d, a.proposalId, "user")).toBe(true);
    expect(h.store.getProposal(a.proposalId)).toMatchObject({ state: "cancelled", draftId: null });
    expect(h.store.getDraft(draftId)).toBeNull();
    expect(cancelProposal(d, a.proposalId, "user")).toBe(false);

    const b = await propose({}, "thread_2");
    expect(cancelProposal(d, b.proposalId, "expired")).toBe(true);
    expect(h.store.getProposal(b.proposalId)!.state).toBe("expired");
  });

  it("settles a confirming proposal too: cancelled or expired, its hidden draft deleted", async () => {
    for (const [reason, state, thread] of [["user", "cancelled", "thread_c1"], ["expired", "expired", "thread_c2"]] as const) {
      const p = await viewed({}, thread);
      expect(await checkSubmit(d, p.proposalId, submit("send", p))).toEqual({ action: "send" });
      const draftId = h.store.getProposal(p.proposalId)!.draftId!;
      expect(cancelProposal(d, p.proposalId, reason)).toBe(true);
      expect(h.store.getProposal(p.proposalId)).toMatchObject({ state, draftId: null });
      expect(h.store.getDraft(draftId)).toBeNull();
    }
  });

  it("never deletes a draft the owner opened in Mail", async () => {
    const p = await viewed();
    await checkSubmit(d, p.proposalId, submit("open", p));
    const draftId = h.store.getProposal(p.proposalId)!.draftId!;
    expect(cancelProposal(d, p.proposalId, "expired")).toBe(false);
    h.store.dropProposalDraft(p.proposalId);
    expect(h.store.getDraft(draftId)).not.toBeNull();
  });

  it("the agent's sentences carry no content", () => {
    for (const sentence of [AGENT_RESULT.sent, AGENT_RESULT.opened, AGENT_RESULT.cancelled, AGENT_RESULT.expired, AGENT_RESULT.changed]) {
      expect(sentence).not.toMatch(/@|\{|<|token|hash/i);
    }
    expect(AGENT_RESULT.changed).toBe("The confirmation did not match the proposal; nothing was sent.");
  });
});

describe("resolveSendingAccount", () => {
  const ICLOUD = { id: "acc-1", addresses: ["owner@example.com", "alias@example.com"] };
  const GMAIL = { id: "acc-2", addresses: ["owner.two@example.org"] };

  it("uses the only account when the agent names none", () => {
    expect(resolveSendingAccount([ICLOUD], undefined)).toEqual({ accountId: "acc-1", address: null });
  });

  it("asks the agent to choose by address when there are several, naming only the owner's addresses", () => {
    expect(() => resolveSendingAccount([ICLOUD, GMAIL], undefined)).toThrow(
      /several mail accounts.*Accounts: owner@example\.com, owner\.two@example\.org\./,
    );
  });

  it("accepts an id or an email address, case-insensitively", () => {
    expect(resolveSendingAccount([ICLOUD, GMAIL], "acc-2")).toEqual({ accountId: "acc-2", address: null });
    expect(resolveSendingAccount([ICLOUD, GMAIL], " owner.two@EXAMPLE.org ")).toEqual({ accountId: "acc-2", address: null });
  });

  it("an alias address selects that identity of its account", () => {
    expect(resolveSendingAccount([ICLOUD, GMAIL], "ALIAS@example.com")).toEqual({ accountId: "acc-1", address: "alias@example.com" });
  });

  it("refuses an unknown account and lists the choices", () => {
    expect(() => resolveSendingAccount([ICLOUD, GMAIL], "stranger@example.net")).toThrow(/not one of the owner's mail accounts.*Accounts:/);
  });

  it("no accounts at all is the plain account refusal", () => {
    expect(() => resolveSendingAccount([], undefined)).toThrow(/cannot send right now/);
  });

  it.each<[string, { accountId: string; lastReceived: string | null; lastSent: string | null }[], string | null]>([
    ["the account that received mail from the recipients", [{ accountId: "acc-2", lastReceived: "2026-06-01T00:00:00.000Z", lastSent: null }], "acc-2"],
    ["the most recent receipt wins over a later send", [
      { accountId: "acc-1", lastReceived: null, lastSent: "2026-09-01T00:00:00.000Z" },
      { accountId: "acc-2", lastReceived: "2026-01-01T00:00:00.000Z", lastSent: null },
    ], "acc-2"],
    ["a tie in receipts goes to the latest send", [
      { accountId: "acc-1", lastReceived: "2026-01-01T00:00:00.000Z", lastSent: "2026-05-01T00:00:00.000Z" },
      { accountId: "acc-2", lastReceived: "2026-01-01T00:00:00.000Z", lastSent: "2026-02-01T00:00:00.000Z" },
    ], "acc-1"],
    ["sent only", [{ accountId: "acc-1", lastReceived: null, lastSent: "2026-01-01T00:00:00.000Z" }], "acc-1"],
    ["no history: the agent must choose", [], null],
  ])("several accounts, none named: %s", (_name, history, picked) => {
    const resolve = () => resolveSendingAccount([ICLOUD, GMAIL], undefined, () => history);
    if (picked === null) expect(resolve).toThrow(/several mail accounts.*Accounts: owner@example\.com, owner\.two@example\.org\./);
    else expect(resolve()).toEqual({ accountId: picked, address: null });
  });

  it("a named account wins over history, and history is not read for one account", () => {
    let reads = 0;
    const history = () => {
      reads++;
      return [{ accountId: "acc-2", lastReceived: "2026-06-01T00:00:00.000Z", lastSent: null }];
    };
    expect(resolveSendingAccount([ICLOUD, GMAIL], "acc-1", history)).toEqual({ accountId: "acc-1", address: null });
    expect(resolveSendingAccount([ICLOUD], undefined, history)).toEqual({ accountId: "acc-1", address: null });
    expect(reads).toBe(0);
  });
});

describe("proposeMail picks the sending account from the recipients' history", () => {
  beforeEach(() => {
    h.store.saveAccount(
      makeStoredAccount({
        id: "acc_2",
        email: "second@example.org",
        username: "second@example.org",
        createdAt: "2026-02-01T00:00:00.000Z",
        passwordSealed: "invented-password",
        smtp: { host: "smtp.example.org", port: 465, security: "tls", username: null },
        sentCopy: "append",
      }),
    );
  });

  it("a new message without accountId goes from the account that received mail from the To recipient", async () => {
    h.store.upsertMessages("acc_2", "INBOX", [
      makeFetchedMessage(1, {
        from: { name: "Bob", address: "Bob@example.com" },
        to: [{ name: null, address: "second@example.org" }],
        bulkHeaders: { listId: null, listUnsubscribe: null, precedence: null, autoSubmitted: null },
      }),
    ]);
    const { proposalId } = await propose({ accountId: undefined });
    expect(h.store.getProposal(proposalId)!.accountId).toBe("acc_2");
  });

  it("refuses with the owner's addresses when no To recipient has history, and ignores bulk mail", async () => {
    h.store.upsertMessages("acc_2", "INBOX", [
      makeFetchedMessage(1, {
        from: { name: "Bob", address: "bob@example.com" },
        bulkHeaders: { listId: "<list.example.com>", listUnsubscribe: null, precedence: null, autoSubmitted: null },
      }),
    ]);
    const error = await refusal(propose({ accountId: undefined }));
    expect(error.kind).toBe("account_required");
    expect(error.message).toMatch(/owner@example\.org, second@example\.org/);
  });
});

// ---- Slice 3d: identities, signatures, templates and checks in proposals ----

describe("proposals by identity (slice 3d)", () => {
  const ALIAS = "alias@example.net";
  const T = "2026-11-15T09:00:00.000Z";
  const SIG = (line: string) => ({
    type: "doc" as const,
    content: [
      {
        type: "paragraph" as const,
        content: [
          { type: "text" as const, text: line },
          { type: "text" as const, text: " site", marks: [{ type: "link" as const, attrs: { href: "https://sig.example.com/x" } }] },
        ],
      },
    ],
  });
  const TEMPLATE = {
    type: "doc" as const,
    content: [
      { type: "paragraph" as const, content: [{ type: "text" as const, text: "Template line", marks: [{ type: "bold" as const }] }] },
      { type: "bulletList" as const, content: [{ type: "listItem" as const, content: [{ type: "paragraph" as const, content: [{ type: "text" as const, text: "Point" }] }] }] },
    ],
  };

  function addAlias(signature: ReturnType<typeof SIG> | null = null) {
    h.store.upsertIdentity({ accountId: "acc_1", address: ALIAS, displayName: "Alias Name" }, T);
    if (signature !== null) h.store.updateIdentity("acc_1", ALIAS, { signature }, T);
  }

  function addTemplate(name = "Thanks", doc: typeof TEMPLATE = TEMPLATE) {
    const saved = h.store.saveTemplate({ id: null, name, nameKey: name.toLowerCase(), doc }, `tpl_${name}`, T);
    if ("conflict" in saved) throw new Error("conflict");
  }

  const draftOf = (proposalId: string) => h.store.getDraft(h.store.getProposal(proposalId)!.draftId!)!;

  async function cardOf(proposed: { proposalId: string; contentHash: string }) {
    const result = await viewProposal(d, proposed);
    if (result.state !== "ready") throw new Error(result.state);
    return result.view;
  }

  it("a new message from an alias named in accountId sends from the alias with its signature", async () => {
    addAlias(SIG("Alias sig"));
    const proposed = await propose({ accountId: "Alias@example.net" });
    const draft = draftOf(proposed.proposalId);
    expect(draft.fromAddress).toBe(ALIAS);
    expect(draft.messageId).toMatch(/@example\.net>$/);
    expect(draft.doc.content.at(-1)).toMatchObject({ type: "signature" });
    expect(outgoingOf(h.deps, h.store.getAccount("acc_1")!, draft, true).from).toEqual({ name: "Alias Name", address: ALIAS });
    const view = await cardOf(proposed);
    expect(view.fromAlias).toBe(true);
    expect(view.fromName).toBe("Alias Name");
    expect(view.account.address).toBe(ALIAS);
    expect(view.signatureText).toBe("Alias sig site <https://sig.example.com/x>");
    expect(view.bodyText).not.toContain("Alias sig");
    expect(view.links.map((l) => l.url)).toContain("https://sig.example.com/x");
  });

  it("without accountId and with one account the own address sends", async () => {
    addAlias();
    const proposed = await propose({ accountId: undefined });
    expect(draftOf(proposed.proposalId).fromAddress).toBeNull();
    const view = await cardOf(proposed);
    expect(view.fromAlias).toBe(false);
    expect(view.signatureText).toBeNull();
  });

  it("a reply to mail sent to an alias goes from the alias; naming the own address refuses", async () => {
    addAlias();
    const id = stored({ from: { name: "Anna", address: "anna@example.org" }, to: [{ name: null, address: ALIAS }] });
    const reply = { kind: "reply" as const, sourceMessageId: id, accountId: undefined, subject: undefined, to: [] };
    const proposed = await propose(reply);
    expect(draftOf(proposed.proposalId).fromAddress).toBe(ALIAS);
    const error = await refusal(propose({ ...reply, accountId: "owner@example.org" }, "thread_2"));
    expect(error.kind).toBe("account_mismatch");
    expect(error.message).toBe("A reply or forward is sent from the address the message came to; leave accountId out.");
    await propose({ ...reply, accountId: ALIAS }, "thread_3");
    await propose({ ...reply, accountId: "acc_1" }, "thread_4");
  });

  it("splices the template after the body and before the signature, marks kept, and records its name", async () => {
    h.store.setAccountSignature("acc_1", SIG("Own sig"));
    addTemplate();
    const proposed = await propose({ template: "THANKS" });
    const draft = draftOf(proposed.proposalId);
    expect(draft.doc.content.map((b) => b.type)).toEqual([
      "paragraph",
      "paragraph",
      "paragraph",
      "paragraph",
      "bulletList",
      "signature",
    ]);
    expect(JSON.stringify(draft.doc.content[3])).toContain('"bold"');
    expect(h.store.getProposal(proposed.proposalId)!.templateName).toBe("Thanks");
    const view = await cardOf(proposed);
    expect(view.templateName).toBe("Thanks");
    expect(view.bodyText).toContain("Template line");
    expect(view.signatureText).toBe("Own sig site <https://sig.example.com/x>");
  });

  it("a reply puts the template and the signature before the quote", async () => {
    addTemplate();
    const id = stored({ bodyText: "Original" });
    const proposed = await propose({ kind: "reply", sourceMessageId: id, accountId: undefined, subject: undefined, to: [], body: "", template: "thanks" });
    const types = draftOf(proposed.proposalId).doc.content.map((b) => b.type);
    expect(types).toEqual(["paragraph", "bulletList", "signature", "blockquote"]);
  });

  it("an unknown template refuses with template_unknown", async () => {
    const error = await refusal(propose({ template: "Nope" }));
    expect(error.kind).toBe("template_unknown");
    expect(error.message).toBe("No template has that name; call mail_templates for the names.");
  });

  it("the hash covers the signature and the template; a later template edit leaves the proposal alone", async () => {
    h.store.setAccountSignature("acc_1", SIG("Own sig"));
    addTemplate();
    const proposed = await propose({ template: "Thanks" });
    const draft = draftOf(proposed.proposalId);
    expect(await draftHash(h.store, draft)).toBe(proposed.contentHash);
    const plain = await propose({}, "thread_2");
    expect(plain.contentHash).not.toBe(proposed.contentHash);
    h.store.saveTemplate({ id: "tpl_Thanks", name: "Thanks", nameKey: "thanks", doc: { type: "doc", content: [{ type: "paragraph" }] } }, "x", T);
    const view = await cardOf(proposed);
    expect(view.bodyText).toContain("Template line");
    const edited = { ...draft, doc: { ...draft.doc, content: draft.doc.content.filter((b) => b.type !== "signature") } };
    expect(await draftHash(h.store, edited)).not.toBe(proposed.contentHash);
  });

  it("the card's checks leave new_recipients out", async () => {
    const proposed = await propose({ to: ["fresh@example.com"], body: "See the attached plan" });
    const view = await cardOf(proposed);
    expect(view.checks).toEqual([{ kind: "attachment_mentioned", phrase: "attached" }]);
    expect(view.to[0]!.flags).toContain("new");
  });

  it("the card's checks ignore attachment words in an inherited Re: subject", async () => {
    const id = stored({ from: { name: "Anna", address: "anna@example.org" }, subject: "Report attached" });
    const proposed = await propose({ kind: "reply", sourceMessageId: id, accountId: undefined, subject: undefined, to: [], body: "Thanks" });
    const view = await cardOf(proposed);
    expect(view.subject).toBe("Re: Report attached");
    expect(view.checks.filter((c) => c.kind === "attachment_mentioned")).toEqual([]);
  });

  it("a reply to own mail leaves the own signature out of the agent's quote", async () => {
    const id = stored({
      from: { name: "Owner", address: "owner@example.org" },
      to: [{ name: null, address: "anna@example.org" }],
      bodyText: "Own words\n-- \nOwner Sig",
    });
    const proposed = await propose({ kind: "reply", sourceMessageId: id, accountId: undefined, subject: undefined, to: [], body: "More" });
    const view = await cardOf(proposed);
    expect(view.quoteText).toContain("Own words");
    expect(view.quoteText).not.toContain("Owner Sig");
  });
});
