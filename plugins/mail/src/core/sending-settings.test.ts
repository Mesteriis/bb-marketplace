import { describe, expect, it } from "vitest";
import { prepareCompose } from "./compose.ts";
import { checkDraft } from "./sending-settings.ts";
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
