import { describe, expect, it } from "vitest";
import { prepareCompose } from "./compose.ts";
import { applyTemplate, checkDraft } from "./sending-settings.ts";
import { ATTACHMENT_CAP_BYTES } from "./compose.ts";
import { composeHarness, makeFetchedMessage } from "./testing/fakes.ts";

describe("checkDraft: reply_to_elsewhere (slice 3i, resolution 17)", () => {
  function replyTo(replyToAddress: string) {
    const h = composeHarness();
    h.store.upsertMessages("acc_1", "INBOX", [
      makeFetchedMessage(1, {
        from: { name: "Billing", address: "billing@example.com" },
        replyTo: [{ name: null, address: replyToAddress }],
        subject: "Invented invoice",
      }),
    ]);
    const id = h.store.localFolderIndex("acc_1", "INBOX", "1970-01-01T00:00:00.000Z")[0]!.id;
    return { h, id };
  }

  it("raises it for a reply whose source has a foreign Reply-To still in To, and not after it is removed", async () => {
    const { h, id } = replyTo("collect@elsewhere.example.net");
    const { draftId } = await prepareCompose(h.deps, { kind: "reply", messageId: id });
    const draft = h.store.getDraft(draftId)!;
    expect(draft.to.map((a) => a.address)).toEqual(["collect@elsewhere.example.net"]);
    expect(checkDraft(h.store, draft, draft.revision)).toContainEqual({ kind: "reply_to_elsewhere", addresses: ["collect@elsewhere.example.net"] });
    const fixed = { ...draft, to: [{ name: null, address: "billing@example.com" }] };
    expect(checkDraft(h.store, fixed, draft.revision).map((issue) => issue.kind)).not.toContain("reply_to_elsewhere");
  });

  it("stays quiet for a Reply-To on a domain the owner writes to, and for a forward", async () => {
    const { h, id } = replyTo("desk@partner.example.net");
    h.store.upsertMessages("acc_1", "Sent", [
      makeFetchedMessage(2, { from: { name: null, address: "owner@example.org" }, to: [{ name: null, address: "someone@partner.example.net" }] }),
    ]);
    const { draftId } = await prepareCompose(h.deps, { kind: "reply", messageId: id });
    const draft = h.store.getDraft(draftId)!;
    expect(checkDraft(h.store, draft, draft.revision).map((issue) => issue.kind)).not.toContain("reply_to_elsewhere");

    const other = replyTo("collect@elsewhere.example.net");
    const forward = await prepareCompose(other.h.deps, { kind: "forward", messageId: other.id });
    const fwd = other.h.store.getDraft(forward.draftId)!;
    const withAddress = { ...fwd, to: [{ name: null, address: "collect@elsewhere.example.net" }] };
    expect(checkDraft(other.h.store, withAddress, fwd.revision).map((issue) => issue.kind)).not.toContain("reply_to_elsewhere");
  });
});

describe("applyTemplate", () => {
  it("attaches the template's files that fit the draft and names the ones left out", async () => {
    const h = composeHarness();
    h.store.upsertMessages("acc_1", "INBOX", [makeFetchedMessage(1, {})]);
    const id = h.store.localFolderIndex("acc_1", "INBOX", "1970-01-01T00:00:00.000Z")[0]!.id;
    const { draftId } = await prepareCompose(h.deps, { kind: "reply", messageId: id });
    const doc = { type: "doc" as const, content: [{ type: "paragraph" as const, content: [{ type: "text" as const, text: "Invented" }] }] };
    h.store.saveTemplate({ id: null, name: "T", nameKey: "t", doc }, "tpl_1", "2026-11-19T10:00:00.000Z");
    const file = (fileId: string, size: number) => ({ id: fileId, name: `${fileId}.pdf`, mimeType: "application/pdf", size, sha256: "a".repeat(64), data: new Uint8Array(size) });
    h.store.addTemplateFile("tpl_1", file("big", 2048), "2026-11-19T10:00:00.000Z");
    h.store.addTemplateFile("tpl_1", file("small", 16), "2026-11-19T10:00:01.000Z");
    // The draft is 1 KiB short of the message's limit.
    const fill = ATTACHMENT_CAP_BYTES - 1024;
    h.store.addAttachment(draftId, { fileName: "fill.bin", mimeType: "application/octet-stream", size: fill, sha256: "b".repeat(64), data: new Uint8Array(fill) });
    const applied = applyTemplate(h.store, draftId, "tpl_1");
    expect(applied.leftOut).toEqual(["big.pdf"]);
    expect(applied.attached.map((a) => [a.fileName, a.size])).toEqual([["small.pdf", 16]]);
    expect(h.store.listAttachments(draftId).map((a) => a.fileName)).toEqual(["fill.bin", "small.pdf"]);
    // The same template again: its file is already there and is not attached a second time.
    const again = applyTemplate(h.store, draftId, "tpl_1");
    expect(again.attached).toEqual([]);
    expect(again.leftOut).toEqual(["big.pdf"]);
    expect(h.store.listAttachments(draftId).map((a) => a.fileName)).toEqual(["fill.bin", "small.pdf"]);
  });
});
