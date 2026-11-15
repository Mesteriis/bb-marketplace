import { describe, expect, it } from "vitest";
import type { FolderSession, ImapGateway, MailStore, RawRef } from "../../core/index.ts";
import { makeStoredAccount } from "../../core/testing/fakes.ts";
import { RawRefusal, type RawDeps } from "./downloads.ts";
import { createOriginalReader } from "./original-reader.ts";

const RAW = [
  "From: Invented Sender <sender@example.org>",
  "Reply-To: Desk <desk@example.org>, other@example.org",
  "To: owner@example.org",
  "Bcc: Hidden <hidden@example.org>",
  "Subject: Invented",
  "Message-ID: <orig-1@example.org>",
  "MIME-Version: 1.0",
  'Content-Type: multipart/mixed; boundary="outer"',
  "",
  "--outer",
  "Content-Type: text/html; charset=utf-8",
  "",
  '<p>Invented <img src="cid:logo@example.org"></p>',
  "--outer",
  'Content-Type: text/html; name="../../evil.html"',
  'Content-Disposition: attachment; filename="../../evil‮.html"',
  "Content-ID: <not-inline@example.org>",
  "",
  "<script>alert(1)</script>",
  "--outer",
  "Content-Type: image/png",
  "Content-Disposition: inline",
  "Content-ID: <logo@example.org>",
  "Content-Transfer-Encoding: base64",
  "",
  "iVBORw0KGgo=",
  "--outer--",
  "",
].join("\r\n");
const BYTES = new TextEncoder().encode(RAW);

function deps(options: { raw?: Uint8Array; uidValidity?: number } = {}): RawDeps & { reads: string[] } {
  const raw = options.raw ?? BYTES;
  const ref: RawRef = {
    accountId: "acc_1",
    folder: "INBOX",
    uid: 5,
    size: raw.byteLength,
    messageId: "<orig-1@example.org>",
    uidValidity: 3,
  };
  const reads: string[] = [];
  const store = {
    rawRef: (id: string) => (id === "m1" ? ref : null),
    getMessage: () => null,
    getAccount: () => makeStoredAccount(),
  } as unknown as MailStore;
  const gateway = {
    openFolder: async (_config: unknown, path: string, opts: { readOnly: boolean }) => {
      reads.push(`${path} ${opts.readOnly ? "ro" : "rw"}`);
      return {
        status: async () => ({ uidValidity: options.uidValidity ?? 3, uidNext: 9, exists: 1 }),
        fetchRaw: async () => raw.slice(),
        close: async () => undefined,
      } as unknown as FolderSession;
    },
  } as unknown as ImapGateway;
  return {
    store,
    gateway,
    vault: { seal: (p) => p, open: (s) => s },
    vaultReady: () => true,
    messages: { needsKey: "key", passwordNeeded: "password" },
    reads,
  };
}

describe("createOriginalReader", () => {
  it("reads Reply-To, HTML and attachments through a read-only guarded fetch", async () => {
    const d = deps();
    const original = await createOriginalReader(d).read("m1");
    expect(d.reads).toEqual(["INBOX ro"]);
    expect(original.replyTo).toEqual([
      { name: "Desk", address: "desk@example.org" },
      { name: null, address: "other@example.org" },
    ]);
    expect(original.bcc).toEqual([{ name: "Hidden", address: "hidden@example.org" }]);
    expect(original.html).toContain("cid:logo@example.org");
    expect(original.attachments).toHaveLength(2);
  });

  it("sanitizes names and types; only inline parts keep their Content-ID", async () => {
    const { attachments } = await createOriginalReader(deps()).read("m1");
    const evil = attachments.find((a) => a.fileName.includes("evil"))!;
    expect(evil.fileName).toBe("evil.html");
    expect(evil.mimeType).toBe("application/octet-stream");
    expect(evil.contentId).toBeNull();
    const logo = attachments.find((a) => a.mimeType === "image/png")!;
    expect(logo.contentId).toBe("logo@example.org");
    expect(logo.fileName).toBe("attachment");
    expect(logo.bytes).toEqual(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  });

  it("refuses an unknown message and a changed UIDVALIDITY", async () => {
    await expect(createOriginalReader(deps()).read("missing")).rejects.toBeInstanceOf(RawRefusal);
    await expect(createOriginalReader(deps({ uidValidity: 4 })).read("m1")).rejects.toBeInstanceOf(RawRefusal);
  });
});
