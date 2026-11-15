import { beforeEach, describe, expect, it } from "vitest";
import {
  ATTACHMENT_CAP_BYTES,
  ComposeError,
  addComposeAttachment,
  createComposeDraft,
  discardCompose,
  newCompose,
  openDraft,
  planCompose,
  planNew,
  prepareCompose,
  removeComposeAttachment,
  saveCompose,
  writeServerCopy,
  type SaveComposeInput,
} from "./compose.ts";
import { SERVER_COPY_IDLE_MS } from "./compose-drafts.ts";
import type { MailAddress } from "./model.ts";
import { composeHarness, imapError, makeFetchedMessage, makeStoredAccount } from "./testing/fakes.ts";

let h: ReturnType<typeof composeHarness>;

beforeEach(() => {
  h = composeHarness();
});

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const addr = (address: string, name: string | null = null): MailAddress => ({ name, address });

/** Stores one INBOX message and returns its id. */
function stored(overrides: Parameters<typeof makeFetchedMessage>[1] = {}, folder = "INBOX", uid = 1): string {
  h.store.upsertMessages("acc_1", folder, [makeFetchedMessage(uid, overrides)]);
  const id = h.store.localFolderIndex("acc_1", folder, "1970-01-01T00:00:00.000Z").find((e) => e.uid === uid)!.id;
  return id;
}

async function save(draftId: string, overrides: Partial<SaveComposeInput> = {}) {
  const draft = h.store.getDraft(draftId)!;
  return saveCompose(h.deps, {
    draftId,
    baseRevision: draft.revision,
    accountId: draft.accountId,
    to: ["bob@example.com"],
    cc: [],
    bcc: ["hidden@example.net"],
    subject: "Invented plan",
    doc: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Hello" }] }] },
    ...overrides,
  });
}

/** Every uid expungeOwn was asked to remove, by folder. */
function expungeCalls(): { path: string; uid: number }[] {
  return h.gateway.sessions.flatMap((s) =>
    s.calls.filter((c) => c.method === "expungeOwn").map((c) => ({ path: s.path, uid: c.uid! })),
  );
}

describe("newCompose", () => {
  it("creates an empty draft at revision 1 with a Message-ID at the account's domain", () => {
    const { draftId } = newCompose(h.deps, "acc_1");
    const draft = h.store.getDraft(draftId)!;
    expect(draft).toMatchObject({
      kind: "new",
      accountId: "acc_1",
      revision: 1,
      to: [],
      subject: "",
      serverState: "none",
      origin: "owner",
    });
    expect(draft.messageId).toMatch(/^<id\d+@example\.org>$/);
  });

  it("refuses an unknown account", () => {
    expect(() => newCompose(h.deps, "nope")).toThrow(ComposeError);
  });
});

describe("prepareCompose", () => {
  it("replies from stored Reply-To without reading the server", async () => {
    const id = stored({
      from: addr("anna@example.org", "Anna"),
      replyTo: [addr("list@example.net", "List")],
      subject: "Re: Re[2]: Garden",
      messageId: "m1@example.org",
      references: ["r0@example.org"],
      bodyHtml: "<p>Original</p>",
    });
    const result = await prepareCompose(h.deps, { kind: "reply", messageId: id });
    expect(result.warning).toBeNull();
    expect(h.reader.reads).toEqual([]);
    const draft = h.store.getDraft(result.draftId)!;
    expect(draft).toMatchObject({
      kind: "reply",
      sourceMessageId: id,
      to: [addr("list@example.net", "List")],
      cc: [],
      subject: "Re: Garden",
      inReplyTo: "<m1@example.org>",
      references: ["<r0@example.org>", "<m1@example.org>"],
      importHtml: { html: "<p>Original</p>", into: "quote" },
    });
    expect(JSON.stringify(draft.doc)).toContain("Anna <anna@example.org> wrote:");
  });

  it("reads Reply-To from the server for a row stored before it was kept", async () => {
    const id = stored({ replyTo: undefined as unknown as MailAddress[] });
    h.reader.originals.set(id, { replyTo: [addr("desk@example.net")], html: null, attachments: [], bcc: [] });
    const result = await prepareCompose(h.deps, { kind: "reply", messageId: id });
    expect(h.reader.reads).toEqual([id]);
    expect(h.store.getDraft(result.draftId)!.to).toEqual([addr("desk@example.net")]);
  });

  it("falls back to the stored fields when the original cannot be read", async () => {
    const id = stored({ replyTo: undefined as unknown as MailAddress[], bodyText: "Line one\nLine two" });
    const result = await prepareCompose(h.deps, { kind: "reply", messageId: id });
    expect(result.warning).toBe("original_unavailable");
    const draft = h.store.getDraft(result.draftId)!;
    expect(draft.to).toEqual([addr("sender@example.org", "Sender")]);
    expect(draft.importHtml).toBeNull();
    expect(JSON.stringify(draft.doc)).toContain("blockquote");
    expect(JSON.stringify(draft.doc)).toContain("Line two");
  });

  it("reply all removes the owner's addresses of every account and reports unusable ones", async () => {
    h.store.saveAccount(makeStoredAccount({ id: "acc_2", email: "second@example.com", username: "second@example.com" }));
    const id = stored({
      from: addr("anna@example.org"),
      to: [addr("owner@example.org"), addr("bob@example.com"), addr("broken@")],
      cc: [addr("SECOND@example.com"), addr("carl@example.com")],
    });
    const result = await prepareCompose(h.deps, { kind: "reply_all", messageId: id });
    expect(result.dropped).toEqual(["broken@"]);
    const draft = h.store.getDraft(result.draftId)!;
    expect(draft.to).toEqual([addr("anna@example.org"), addr("bob@example.com")]);
    expect(draft.cc).toEqual([addr("carl@example.com")]);
    expect(draft.bcc).toEqual([]);
  });

  it("forwards with no recipients, a Fwd subject, no threading and the original's attachments", async () => {
    const id = stored({ subject: "Fwd: Report", messageId: "m2@example.org" });
    const file = new Uint8Array([1, 2, 3]);
    h.reader.originals.set(id, {
      replyTo: [],
      bcc: [],
      html: "<p>Body</p>",
      attachments: [
        { fileName: "report.txt", mimeType: "text/plain", bytes: file, contentId: null },
        { fileName: "logo.png", mimeType: "image/png", bytes: new Uint8Array([9]), contentId: "logo@example.org" },
      ],
    });
    const result = await prepareCompose(h.deps, { kind: "forward", messageId: id });
    expect(result.warning).toBeNull();
    const draft = h.store.getDraft(result.draftId)!;
    expect(draft).toMatchObject({ to: [], cc: [], subject: "Fwd: Report", inReplyTo: null, references: [] });
    expect(draft.importHtml).toEqual({ html: "<p>Body</p>", into: "quote" });
    expect(JSON.stringify(draft.doc)).toContain("Forwarded message");
    const data = h.store.attachmentData(result.draftId);
    expect(data.map((a) => [a.fileName, a.size, a.contentId])).toEqual([
      ["report.txt", 3, null],
      ["logo.png", 1, "logo@example.org"],
    ]);
    expect(data[0]!.sha256).toBe("039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81");
  });

  it("leaves out forwarded attachments over the cap and says so", async () => {
    const id = stored();
    h.reader.originals.set(id, {
      replyTo: [],
      bcc: [],
      html: null,
      attachments: [
        { fileName: "big.bin", mimeType: "application/octet-stream", bytes: new Uint8Array(ATTACHMENT_CAP_BYTES + 1), contentId: null },
        { fileName: "small.txt", mimeType: "text/plain", bytes: new Uint8Array(4), contentId: null },
      ],
    });
    const result = await prepareCompose(h.deps, { kind: "forward", messageId: id });
    expect(result.warning).toBe("attachments_left_out");
    expect(h.store.listAttachments(result.draftId).map((a) => a.fileName)).toEqual(["small.txt"]);
  });

  it("refuses an unknown message", async () => {
    await expect(prepareCompose(h.deps, { kind: "reply", messageId: "nope" })).rejects.toThrow(ComposeError);
  });
});

describe("saveCompose", () => {
  it("writes the local row before any server step, keeping invalid chips as typed", async () => {
    const { draftId } = newCompose(h.deps, "acc_1");
    const result = await save(draftId, {
      to: ["Bob <bob@example.com>", "not an address"],
      subject: "Line\r\nBcc: evil@example.net",
    });
    expect(result).toEqual({ revision: 2 });
    expect(h.gateway.sessions).toEqual([]);
    const draft = h.store.getDraft(draftId)!;
    expect(draft.to).toEqual([addr("bob@example.com", "Bob"), addr("not an address")]);
    expect(draft.subject).toBe("Line Bcc: evil@example.net");
    expect(draft.updatedAt).toBe("2026-11-15T10:00:00.000Z");
  });

  it("strips nodes the editor schema does not know, keeping their text", async () => {
    const { draftId } = newCompose(h.deps, "acc_1");
    await save(draftId, {
      doc: { type: "doc", content: [{ type: "heading", content: [{ type: "text", text: "Kept" }] }] },
    });
    const doc = JSON.stringify(h.store.getDraft(draftId)!.doc);
    expect(doc).not.toContain("heading");
    expect(doc).toContain("Kept");
  });

  it("answers conflict to a stale tab and keeps the newer text", async () => {
    const { draftId } = newCompose(h.deps, "acc_1");
    await save(draftId, { subject: "Newer" });
    const stale = await saveCompose(h.deps, {
      draftId,
      baseRevision: 1,
      accountId: "acc_1",
      to: [],
      cc: [],
      bcc: [],
      subject: "Older",
      doc: { type: "doc", content: [] },
    });
    expect(stale).toEqual({ conflict: true, revision: 2 });
    expect(h.store.getDraft(draftId)!.subject).toBe("Newer");
  });

  it("clears the one-time import on the first save", async () => {
    const id = stored({ bodyHtml: "<p>Quoted</p>" });
    const { draftId } = await prepareCompose(h.deps, { kind: "reply", messageId: id });
    expect((await openDraft(h.deps, { draftId })).draft.import).not.toBeNull();
    await save(draftId);
    expect((await openDraft(h.deps, { draftId })).draft.import).toBeNull();
  });
});

describe("server copy", () => {
  it("Save draft appends to Drafts with \\Draft \\Seen and the Bcc kept", async () => {
    const { draftId } = newCompose(h.deps, "acc_1");
    await save(draftId, { saveToServer: true });
    expect(h.gateway.appended).toHaveLength(1);
    const copy = h.gateway.appended[0]!;
    expect(copy.path).toBe("Drafts");
    expect(copy.flags).toEqual(["\\Draft", "\\Seen"]);
    expect(text(copy.raw)).toContain("\r\nBcc: hidden@example.net\r\n");
    expect(h.store.getDraft(draftId)).toMatchObject({
      serverState: "saved",
      serverCopy: { folder: "Drafts", uidValidity: 7, uid: copy.uid, revision: 2, size: copy.raw.length },
    });
    expect(h.queue.runs).toEqual(["acc_1"]);
  });

  it("a newer copy replaces ours: expunge of the previous uid only after the APPEND, then its local row", async () => {
    const { draftId } = newCompose(h.deps, "acc_1");
    await save(draftId, { saveToServer: true });
    const first = h.gateway.appended[0]!;
    // Sync stored our copy as an ordinary Drafts message.
    h.store.upsertMessages("acc_1", "Drafts", h.drafts.messages.map((m) => structuredClone(m)));
    await save(draftId, { subject: "Second", saveToServer: true });
    const second = h.gateway.appended[1]!;
    expect(expungeCalls()).toEqual([{ path: "Drafts", uid: first.uid }]);
    const call = h.gateway.sessions.flatMap((s) => s.calls).find((c) => c.method === "expungeOwn")!;
    expect(call.guard).toEqual({ messageId: h.store.getDraft(draftId)!.messageId, size: first.raw.length });
    const methods = h.gateway.sessions.at(-1)!.calls.map((c) => c.method);
    expect(methods.indexOf("appendMessage")).toBeLessThan(methods.indexOf("expungeOwn"));
    expect(h.drafts.messages.map((m) => m.uid)).toEqual([second.uid]);
    expect(h.store.localFolderIndex("acc_1", "Drafts", "1970-01-01T00:00:00.000Z")).toEqual([]);
    expect(h.store.getDraft(draftId)!.serverCopy?.uid).toBe(second.uid);
  });

  it("an APPEND failure keeps the local row and the previous copy, and deletes nothing", async () => {
    const { draftId } = newCompose(h.deps, "acc_1");
    await save(draftId, { saveToServer: true });
    const before = h.store.getDraft(draftId)!.serverCopy;
    h.gateway.failNext("appendMessage", imapError("AppendFailed"));
    expect(await save(draftId, { subject: "Kept locally", saveToServer: true })).toEqual({ revision: 3 });
    expect(h.store.getDraft(draftId)).toMatchObject({ subject: "Kept locally", serverState: "failed", serverCopy: before });
    expect(expungeCalls()).toEqual([]);
    expect(h.drafts.messages).toHaveLength(1);
  });

  it("a vanished previous copy is not replaced: the new copy is appended, nothing is deleted", async () => {
    const { draftId } = newCompose(h.deps, "acc_1");
    await save(draftId, { saveToServer: true });
    h.drafts.messages = []; // another client deleted it
    h.drafts.messages.push(makeFetchedMessage(1, { messageId: "other@example.org", size: 5 }));
    await save(draftId, { saveToServer: true });
    expect(h.gateway.appended).toHaveLength(2);
    expect(h.gateway.expunged).toEqual([]);
    expect(h.drafts.messages.map((m) => m.messageId)).toContain("other@example.org");
    expect(h.store.getDraft(draftId)!.serverCopy?.uid).toBe(h.gateway.appended[1]!.uid);
  });

  it("a changed UIDVALIDITY removes nothing", async () => {
    const { draftId } = newCompose(h.deps, "acc_1");
    await save(draftId, { saveToServer: true });
    h.drafts.uidValidity = 8;
    await save(draftId, { saveToServer: true });
    expect(expungeCalls()).toEqual([]);
  });

  it("without UIDPLUS the draft stays local only: no APPEND, no expunge", async () => {
    h.gateway.uidplus = false;
    const { draftId } = newCompose(h.deps, "acc_1");
    await save(draftId, { saveToServer: true });
    expect(h.gateway.appended).toEqual([]);
    expect(expungeCalls()).toEqual([]);
    expect(h.store.getDraft(draftId)!.serverState).toBe("local_only");
    expect((await openDraft(h.deps, { draftId })).draft.serverCopy).toBe("local_only");
  });

  it("without a Drafts folder the draft stays local only and no server is contacted", async () => {
    h.store.saveFolders("acc_1", h.gateway.folders.filter((f) => f.path !== "Drafts"));
    const { draftId } = newCompose(h.deps, "acc_1");
    await save(draftId, { saveToServer: true });
    expect(h.gateway.sessions).toEqual([]);
    expect(h.store.getDraft(draftId)!.serverState).toBe("local_only");
  });

  it("a tick copies only after 30 s idle, and never a draft with attachments", async () => {
    const { draftId } = newCompose(h.deps, "acc_1");
    await save(draftId);
    expect(await writeServerCopy(h.deps, draftId, "tick")).toBe("skipped");
    h.advance(SERVER_COPY_IDLE_MS);
    expect(await writeServerCopy(h.deps, draftId, "tick")).toBe("saved");
    expect(await writeServerCopy(h.deps, draftId, "tick")).toBe("skipped");

    const other = newCompose(h.deps, "acc_1").draftId;
    await save(other);
    addComposeAttachment(h.store, other, { fileName: "a.txt", mimeType: "text/plain", size: 1, sha256: "0".repeat(64), data: new Uint8Array(1) });
    h.advance(SERVER_COPY_IDLE_MS);
    expect(await writeServerCopy(h.deps, other, "tick")).toBe("skipped");
    expect(await writeServerCopy(h.deps, other, "close")).toBe("saved");
  });

  it("a tick never copies a draft the owner has not saved yet", async () => {
    const { draftId } = newCompose(h.deps, "acc_1");
    h.advance(SERVER_COPY_IDLE_MS);
    expect(await writeServerCopy(h.deps, draftId, "tick")).toBe("skipped");
    expect(h.gateway.appended).toEqual([]);
  });

  it("the synced copy of our draft carries its draftId (Edit draft)", async () => {
    const { draftId } = newCompose(h.deps, "acc_1");
    await save(draftId, { saveToServer: true });
    h.store.upsertMessages("acc_1", "Drafts", h.drafts.messages.map((m) => structuredClone(m)));
    const id = h.store.localFolderIndex("acc_1", "Drafts", "1970-01-01T00:00:00.000Z")[0]!.id;
    expect(h.store.getMessage(id)!.draftId).toBe(draftId);
    expect((await openDraft(h.deps, { draftMessageId: id })).draft.id).toBe(draftId);
  });

  it("moving the draft to another account removes the copy from the old account's Drafts", async () => {
    h.store.saveAccount(makeStoredAccount({ id: "acc_2", email: "second@example.com", passwordSealed: "x" }));
    const { draftId } = newCompose(h.deps, "acc_1");
    await save(draftId, { saveToServer: true });
    const first = h.gateway.appended[0]!;
    await save(draftId, { accountId: "acc_2" });
    expect(expungeCalls()).toEqual([{ path: "Drafts", uid: first.uid }]);
    expect(h.store.getDraft(draftId)).toMatchObject({ accountId: "acc_2", serverCopy: null });
  });
});

describe("continuing a foreign draft", () => {
  function foreign(): string {
    h.drafts.messages.push(
      makeFetchedMessage(41, {
        messageId: "foreign@example.org",
        size: 321,
        subject: "Half written",
        to: [addr("bob@example.com")],
        bodyText: "Draft text",
      }),
    );
    h.drafts.uidNext = 42;
    h.store.saveSyncState("acc_1", "Drafts", { uidValidity: 7, lastUid: 41, syncedSince: "1970-01-01T00:00:00.000Z" });
    return stored(structuredClone(h.drafts.messages[0]!), "Drafts", 41);
  }

  it("opens it as a draft that keeps its Message-ID, loads its body and points at its uid", async () => {
    const id = foreign();
    h.reader.originals.set(id, { replyTo: [], html: "<p>Draft text</p>", attachments: [], bcc: [] });
    const { draft, warning } = await openDraft(h.deps, { draftMessageId: id });
    expect(warning).toBeNull();
    expect(draft).toMatchObject({ kind: "new", to: [addr("bob@example.com")], subject: "Half written", revision: 1 });
    expect(draft.import).toEqual({ html: "<p>Draft text</p>", into: "body" });
    const record = h.store.getDraft(draft.id)!;
    expect(record.messageId).toBe("<foreign@example.org>");
    expect(record.serverCopy).toEqual({ folder: "Drafts", uidValidity: 7, uid: 41, revision: 1, size: 321 });
    // Opening it again continues the same draft.
    expect((await openDraft(h.deps, { draftMessageId: id })).draft.id).toBe(draft.id);
  });

  it("our first server copy replaces it under the guard", async () => {
    const id = foreign();
    h.reader.originals.set(id, { replyTo: [], html: "<p>Draft text</p>", attachments: [], bcc: [] });
    const { draft } = await openDraft(h.deps, { draftMessageId: id });
    await save(draft.id, { saveToServer: true });
    expect(expungeCalls()).toEqual([{ path: "Drafts", uid: 41 }]);
    expect(h.drafts.messages.map((m) => m.messageId)).toEqual(["foreign@example.org"]);
    expect(h.drafts.messages[0]!.uid).toBe(h.gateway.appended[0]!.uid);
  });

  /** Our first server copy of the continued draft, then every uid expunged. */
  async function firstCopy(draftId: string) {
    await save(draftId, { saveToServer: true });
    return expungeCalls();
  }

  it("an original that could not be read is kept: a new local draft that never expunges it", async () => {
    const id = foreign();
    const { draft, warning } = await openDraft(h.deps, { draftMessageId: id });
    expect(warning).toBe("original_kept");
    expect(h.store.getDraft(draft.id)!.serverCopy).toBeNull();
    expect(await firstCopy(draft.id)).toEqual([]);
    expect(h.drafts.messages.map((m) => m.uid)).toContain(41);
  });

  it("a kept original is continued once: opening it again returns that draft, its attachments copied once", async () => {
    const id = foreign();
    const small = { fileName: "a.txt", mimeType: "text/plain", bytes: new Uint8Array(3), contentId: null };
    h.reader.originals.set(id, { replyTo: [], html: '<p style="color:red">Draft</p>', attachments: [small], bcc: [] });
    const first = await openDraft(h.deps, { draftMessageId: id });
    expect(first.warning).toBe("original_kept");
    expect(first.draft.continues).toBe(true);
    await save(first.draft.id);
    const again = await openDraft(h.deps, { draftMessageId: id });
    expect(again.draft.id).toBe(first.draft.id);
    expect(again.draft.attachments).toHaveLength(1);
    expect(h.store.listDrafts("acc_1")).toHaveLength(1);
  });

  it("a kept original continued again after its draft was discarded starts a new draft", async () => {
    const id = foreign();
    const { draft } = await openDraft(h.deps, { draftMessageId: id });
    await discardCompose(h.deps, draft.id);
    const again = await openDraft(h.deps, { draftMessageId: id });
    expect(again.draft.id).not.toBe(draft.id);
    expect(h.store.listDrafts("acc_1")).toHaveLength(1);
  });

  it("a kept original's continuation has its own Message-ID and keeps the reply threading", async () => {
    h.drafts.messages.push(
      makeFetchedMessage(41, {
        messageId: "foreign@example.org",
        inReplyTo: "<parent@example.org>",
        references: ["<root@example.org>", "<parent@example.org>"],
        subject: "Re: Plan",
      }),
    );
    h.store.saveSyncState("acc_1", "Drafts", { uidValidity: 7, lastUid: 41, syncedSince: "1970-01-01T00:00:00.000Z" });
    const id = stored(structuredClone(h.drafts.messages[0]!), "Drafts", 41);
    const { draft, warning } = await openDraft(h.deps, { draftMessageId: id });
    expect(warning).toBe("original_kept");
    const record = h.store.getDraft(draft.id)!;
    expect(record.messageId).not.toBe("<foreign@example.org>");
    expect(record.messageId).toMatch(/^<id\d+@example\.org>$/);
    expect(record.inReplyTo).toBe("<parent@example.org>");
    expect(record.references).toEqual(["<root@example.org>", "<parent@example.org>"]);
    await save(draft.id, { saveToServer: true });
    expect(h.drafts.messages.filter((m) => m.messageId === "foreign@example.org")).toHaveLength(1);
  });

  it("an import that lets the original go gives the draft its own Message-ID, and reopening returns it", async () => {
    const id = foreign();
    h.reader.originals.set(id, { replyTo: [], html: "<p>Draft text</p>", attachments: [], bcc: [] });
    const { draft } = await openDraft(h.deps, { draftMessageId: id });
    expect(h.store.getDraft(draft.id)!.messageId).toBe("<foreign@example.org>");
    await save(draft.id, {
      doc: { type: "doc", content: [{ type: "heading", content: [{ type: "text", text: "Draft text" }] }] },
      imported: true,
    });
    expect(h.store.getDraft(draft.id)!.messageId).not.toBe("<foreign@example.org>");
    expect((await openDraft(h.deps, { draftMessageId: id })).draft.id).toBe(draft.id);
  });

  it("an original with attachments over the cap is kept", async () => {
    const id = foreign();
    const big = { fileName: "big.bin", mimeType: "application/octet-stream", bytes: new Uint8Array(ATTACHMENT_CAP_BYTES), contentId: null };
    const small = { fileName: "a.txt", mimeType: "text/plain", bytes: new Uint8Array(3), contentId: null };
    h.reader.originals.set(id, { replyTo: [], html: "<p>Draft text</p>", attachments: [small, big], bcc: [] });
    const { draft, warning } = await openDraft(h.deps, { draftMessageId: id });
    expect(warning).toBe("original_kept");
    expect(await firstCopy(draft.id)).toEqual([]);
  });

  it("an original whose HTML the editor cannot hold (an image, styles) is kept", async () => {
    const id = foreign();
    const inline = { fileName: "p.png", mimeType: "image/png", bytes: new Uint8Array(3), contentId: "part1" };
    h.reader.originals.set(id, { replyTo: [], html: '<p style="color:red">Draft <img src="cid:part1"></p>', attachments: [inline], bcc: [] });
    const { draft, warning } = await openDraft(h.deps, { draftMessageId: id });
    expect(warning).toBe("original_kept");
    expect(await firstCopy(draft.id)).toEqual([]);
  });

  it("carries the original's Bcc over", async () => {
    const id = foreign();
    h.reader.originals.set(id, { replyTo: [], html: "<p>Draft text</p>", attachments: [], bcc: [addr("hidden@example.net", "Hidden")] });
    const { draft } = await openDraft(h.deps, { draftMessageId: id });
    expect(draft.bcc).toEqual([addr("hidden@example.net", "Hidden")]);
  });

  it("loading its body is not an edit: no revision bump, no server copy due, the original stays", async () => {
    const id = foreign();
    h.reader.originals.set(id, { replyTo: [], html: "<p>Draft text</p>", attachments: [], bcc: [] });
    const { draft } = await openDraft(h.deps, { draftMessageId: id });
    const imported = await save(draft.id, {
      to: ["bob@example.com"],
      bcc: [],
      subject: "Half written",
      doc: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Draft text" }] }] },
      imported: true,
    });
    expect(imported).toEqual({ revision: 1 });
    const record = h.store.getDraft(draft.id)!;
    expect(record).toMatchObject({ revision: 1, importHtml: null, serverCopy: { uid: 41, revision: 1 } });
    expect(JSON.stringify(record.doc)).toContain("Draft text");
    h.advance(SERVER_COPY_IDLE_MS);
    expect(await writeServerCopy(h.deps, draft.id, "tick")).toBe("skipped");
    expect(h.gateway.appended).toEqual([]);
    expect(expungeCalls()).toEqual([]);
    // A second import (another window) is refused: the first one already consumed it.
    expect(await save(draft.id, { imported: true })).toEqual({ conflict: true, revision: 1 });
  });

  it("an import the server schema has to strip keeps the original", async () => {
    const id = foreign();
    h.reader.originals.set(id, { replyTo: [], html: "<p>Draft text</p>", attachments: [], bcc: [] });
    const { draft } = await openDraft(h.deps, { draftMessageId: id });
    const result = await save(draft.id, {
      doc: { type: "doc", content: [{ type: "heading", content: [{ type: "text", text: "Draft text" }] }] },
      imported: true,
    });
    expect(result).toEqual({ revision: 1, originalKept: true });
    expect(h.store.getDraft(draft.id)!.serverCopy).toBeNull();
    expect(await firstCopy(draft.id)).toEqual([]);
  });

  it("refuses a message outside a Drafts folder", async () => {
    const id = stored();
    await expect(openDraft(h.deps, { draftMessageId: id })).rejects.toThrow(ComposeError);
  });
});

describe("discardCompose", () => {
  it("removes our server copy by UID and the local draft with its attachments", async () => {
    const { draftId } = newCompose(h.deps, "acc_1");
    await save(draftId, { saveToServer: true });
    addComposeAttachment(h.store, draftId, { fileName: "a.txt", mimeType: "text/plain", size: 1, sha256: "0".repeat(64), data: new Uint8Array(1) });
    expect(await discardCompose(h.deps, draftId)).toEqual({ ok: true });
    expect(expungeCalls()).toEqual([{ path: "Drafts", uid: h.gateway.appended[0]!.uid }]);
    expect(h.store.getDraft(draftId)).toBeNull();
    expect(h.store.listAttachments(draftId)).toEqual([]);
  });

  it("without UIDPLUS deletes the local draft and never asks to expunge", async () => {
    const { draftId } = newCompose(h.deps, "acc_1");
    await save(draftId, { saveToServer: true });
    h.gateway.uidplus = false;
    await discardCompose(h.deps, draftId);
    expect(expungeCalls()).toEqual([]);
    expect(h.store.getDraft(draftId)).toBeNull();
  });
});

describe("attachments", () => {
  it("are refused over the per-file and per-message caps", () => {
    const { draftId } = newCompose(h.deps, "acc_1");
    const file = (size: number) => ({ fileName: "f", mimeType: "text/plain", size, sha256: "0".repeat(64), data: new Uint8Array(size) });
    addComposeAttachment(h.store, draftId, file(ATTACHMENT_CAP_BYTES - 10));
    expect(() => addComposeAttachment(h.store, draftId, file(11))).toThrow("Attachments are over the size limit");
    addComposeAttachment(h.store, draftId, file(10));
    expect(h.store.listAttachments(draftId)).toHaveLength(2);
    const id = h.store.listAttachments(draftId)[0]!.id;
    expect(removeComposeAttachment(h.store, draftId, id)).toBe(true);
    expect(removeComposeAttachment(h.store, draftId, id)).toBe(false);
  });
});

describe("plan and create (slice 3c)", () => {
  it("planCompose writes nothing; createComposeDraft writes one row with origin and proposal id", async () => {
    const id = stored({ subject: "Invented question" });
    const plan = await planCompose(h.deps, { kind: "reply", messageId: id });
    expect(h.store.listDrafts("acc_1")).toEqual([]);
    expect(plan).toMatchObject({ kind: "reply", subject: "Re: Invented question", warning: null, attachments: [] });
    expect(plan.original?.source.from.address).toBe("sender@example.org");

    const calls: unknown[] = [];
    const createDraft = h.store.createDraft.bind(h.store);
    h.store.createDraft = (input) => {
      calls.push(structuredClone(input));
      return createDraft(input);
    };
    const created = await createComposeDraft(h.deps, plan, { origin: "agent", proposalId: "p1" });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ origin: "agent", proposalId: "p1" });
    expect(h.store.getDraft(created.draftId)).toMatchObject({ origin: "agent", proposalId: "p1" });
    expect(created).toMatchObject({ warning: null, dropped: [], leftOut: 0 });
  });

  it("planNew is an empty new draft of the account", () => {
    expect(planNew(h.deps, "acc_1")).toMatchObject({ kind: "new", accountId: "acc_1", to: [], subject: "", original: null });
    expect(h.store.listDrafts("acc_1")).toEqual([]);
  });

  it("createComposeDraft counts attachments left out over the cap", async () => {
    const id = stored();
    h.reader.originals.set(id, {
      replyTo: [],
      bcc: [],
      html: null,
      attachments: [
        { fileName: "a.bin", mimeType: "application/octet-stream", bytes: new Uint8Array(10), contentId: null },
        { fileName: "b.bin", mimeType: "application/octet-stream", bytes: new Uint8Array(ATTACHMENT_CAP_BYTES), contentId: null },
      ],
    });
    const plan = await planCompose(h.deps, { kind: "forward", messageId: id });
    const created = await createComposeDraft(h.deps, plan, { origin: "owner", proposalId: null });
    expect(created).toMatchObject({ leftOut: 1, warning: "attachments_left_out" });
    expect(h.store.listAttachments(created.draftId).map((a) => a.fileName)).toEqual(["a.bin"]);
  });

  it("prepareCompose and newCompose still make owner drafts without a proposal", async () => {
    const id = stored();
    const reply = await prepareCompose(h.deps, { kind: "reply", messageId: id });
    expect(Object.keys(reply).sort()).toEqual(["draftId", "dropped", "warning"]);
    expect(h.store.getDraft(reply.draftId)).toMatchObject({ origin: "owner", proposalId: null });
    const fresh = newCompose(h.deps, "acc_1");
    expect(h.store.getDraft(fresh.draftId)).toMatchObject({ origin: "owner", proposalId: null });
  });

  it("writeServerCopy skips a hidden proposal draft", async () => {
    const plan = planNew(h.deps, "acc_1");
    const { draftId } = await createComposeDraft(h.deps, { ...plan, subject: "Invented" }, { origin: "agent", proposalId: "p1" });
    expect(await writeServerCopy(h.deps, draftId, "save")).toBe("skipped");
    expect(await writeServerCopy(h.deps, draftId, "tick")).toBe("skipped");
    expect(h.gateway.sessions).toHaveLength(0);
  });
});
