import PostalMime from "postal-mime";
import { beforeAll, describe, expect, it } from "vitest";
import {
  PgpMimeError,
  boundaryFor,
  extractEncrypted,
  extractSigned,
  publicKeyBlocks,
  splitForProtection,
  wrapEncrypted,
  wrapSigned,
} from "../../core/pgp-mime.ts";
import { createMimeBuilder } from "./mime-builder.ts";
import { DECRYPTED_MAX_BYTES, createPgpEngine } from "./pgp-openpgp.ts";

const engine = createPgpEngine();
const builder = createMimeBuilder();
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

// Keys are made at test time: no key material lives in the repository.
let alice: { publicArmor: string; privateArmor: string };
let bob: { publicArmor: string; privateArmor: string };
let raw: Uint8Array;

beforeAll(async () => {
  alice = await engine.generate({ name: "Alice Invented", address: "alice@example.org" });
  bob = await engine.generate({ name: null, address: "bob@example.com" });
  raw = await builder.build({
    from: { name: "Alice Invented", address: "alice@example.org" },
    to: [{ name: null, address: "bob@example.com" }],
    cc: [],
    bcc: [],
    subject: "Invented plan",
    messageId: "<pgp-1@example.org>",
    date: "2026-11-17T10:00:00.000Z",
    inReplyTo: null,
    references: [],
    text: "Hello Bob,\r\n\r\nInvented text with a trailing space \r\nand кириллица.\r\n",
    html: "<p>Hello Bob</p>",
    attachments: [
      { fileName: "note.txt", mimeType: "text/plain", bytes: new TextEncoder().encode("Invented attachment"), contentId: null },
    ],
  });
}, 60_000);

describe("keys", () => {
  it("makes a key for the address and reads it back", async () => {
    const info = await engine.inspect(alice.publicArmor);
    expect(info).toMatchObject({ addresses: ["alice@example.org"], hasPrivate: false, locked: false, revoked: false });
    expect(info!.fingerprint).toMatch(/^[0-9A-F]{40}$/);
    expect(info!.userIds).toEqual(["Alice Invented <alice@example.org>"]);
    const own = await engine.inspect(alice.privateArmor);
    expect(own).toMatchObject({ hasPrivate: true, locked: false, fingerprint: info!.fingerprint });
    expect((await engine.inspect(bob.publicArmor))!.addresses).toEqual(["bob@example.com"]);
    expect(await engine.publicOf(alice.privateArmor)).toContain("BEGIN PGP PUBLIC KEY BLOCK");
  });

  it("refuses text that is not one key", async () => {
    expect(await engine.inspect("not a key")).toBeNull();
    expect(await engine.inspect(`${alice.publicArmor}\n${bob.publicArmor}`)).toBeNull();
  });

  it("locks a private key for a backup and opens it only with the same passphrase", async () => {
    const phrase = ["invented", "backup", "words", String(Date.now())].join(" ");
    const locked = await engine.lock(alice.privateArmor, phrase);
    expect(await engine.inspect(locked)).toMatchObject({ hasPrivate: true, locked: true });
    expect(await engine.unlock(locked, `${phrase} wrong`)).toBeNull();
    const open = await engine.unlock(locked, phrase);
    expect(await engine.inspect(open!)).toMatchObject({ hasPrivate: true, locked: false });
    // A locked key cannot sign.
    await expect(engine.signDetached(new Uint8Array([1]), locked)).rejects.toThrow();
  });
});

describe("a signed message (PGP/MIME)", () => {
  it("keeps the outer headers, wraps the content, and verifies from the raw bytes", async () => {
    const { outer, entity } = splitForProtection(raw);
    expect(outer.some((line) => /^Subject: Invented plan$/.test(line))).toBe(true);
    expect(outer.some((line) => /^content-type/i.test(line))).toBe(false);
    expect(text(entity)).toMatch(/^Content-Type: multipart\/mixed/);

    const signature = await engine.signDetached(entity, alice.privateArmor);
    const signed = wrapSigned(outer, entity, signature, boundaryFor("pgp-1", [entity]));

    // Another mail program reads it as a normal message with a signature part.
    const parsed = await PostalMime.parse(signed);
    expect(parsed.subject).toBe("Invented plan");
    expect(parsed.text).toContain("Invented text with a trailing space");
    expect(parsed.attachments.map((a) => a.filename)).toEqual(expect.arrayContaining(["note.txt", "signature.asc"]));

    const cut = extractSigned(signed);
    expect(text(cut.entity)).toBe(text(entity));
    expect(await engine.verifyDetached(cut.entity, cut.signatureArmor, [alice.publicArmor])).toMatchObject({
      state: "valid",
      fingerprint: (await engine.inspect(alice.publicArmor))!.fingerprint,
    });
    expect(await engine.verifyDetached(cut.entity, cut.signatureArmor, [bob.publicArmor])).toMatchObject({ state: "no_key" });
    expect(await engine.verifyDetached(cut.entity, cut.signatureArmor, [])).toMatchObject({ state: "no_key" });
  });

  it("says invalid when one byte of the signed content changed", async () => {
    const { outer, entity } = splitForProtection(raw);
    const signature = await engine.signDetached(entity, alice.privateArmor);
    const signed = wrapSigned(outer, entity, signature, boundaryFor("pgp-1", [entity]));
    const at = text(signed).indexOf("Hello Bob");
    const forged = signed.slice();
    forged[at] = "J".charCodeAt(0);
    const cut = extractSigned(forged);
    expect(await engine.verifyDetached(cut.entity, cut.signatureArmor, [alice.publicArmor])).toMatchObject({ state: "invalid" });
  });

  it("refuses a message that is not PGP-signed, and a boundary that occurs in the content", () => {
    expect(() => extractSigned(raw)).toThrow(PgpMimeError);
    const tricky = new TextEncoder().encode("line\r\n------makosh-pgp-x-0\r\n");
    expect(boundaryFor("x", [tricky])).toBe("----makosh-pgp-x-1");
  });
});

describe("an encrypted message (PGP/MIME)", () => {
  it("is opened by each recipient's key, shows the signer, and hides the text from everyone else", async () => {
    const { outer, entity } = splitForProtection(raw);
    const armor = await engine.encrypt(entity, [bob.publicArmor, alice.publicArmor], alice.privateArmor);
    const encrypted = wrapEncrypted(outer, armor, boundaryFor("pgp-1", []));
    const wire = text(encrypted);
    expect(wire).toContain("Subject: Invented plan");
    expect(wire).not.toContain("Hello Bob");
    expect(wire).not.toContain("note.txt");
    expect(wire).toMatch(/Content-Type: multipart\/encrypted; protocol="application\/pgp-encrypted"/);

    const block = extractEncrypted(encrypted);
    for (const reader of [bob, alice]) {
      const opened = await engine.decrypt(block, [reader.privateArmor], [alice.publicArmor]);
      expect(opened).not.toBeNull();
      expect(opened!.signature).toMatchObject({ state: "valid" });
      const inner = await PostalMime.parse(opened!.data);
      expect(inner.text).toContain("Invented text with a trailing space");
      expect(inner.attachments.map((a) => a.filename)).toEqual(["note.txt"]);
    }
    const stranger = await engine.generate({ name: null, address: "eve@example.net" });
    expect(await engine.decrypt(block, [stranger.privateArmor], [])).toBeNull();
    expect(await engine.decrypt(block, [], [])).toBeNull();
    expect(await engine.decrypt("not a message", [bob.privateArmor], [])).toBeNull();
  });

  it("reads an inline armored body, and reports an unsigned message as unsigned", async () => {
    const armor = await engine.encrypt(new TextEncoder().encode("Invented inline text"), [bob.publicArmor], null);
    const inline = new TextEncoder().encode(`Subject: x\r\nContent-Type: text/plain\r\n\r\n${armor}\r\n`);
    const opened = await engine.decrypt(extractEncrypted(inline), [bob.privateArmor], [alice.publicArmor]);
    expect(text(opened!.data)).toBe("Invented inline text");
    expect(opened!.signature).toBeNull();
    expect(() => extractEncrypted(raw)).toThrow(PgpMimeError);
  });

  it("refuses to encrypt to something that is not a key", async () => {
    await expect(engine.encrypt(new Uint8Array([1]), ["nope"], null)).rejects.toThrow();
    await expect(engine.encrypt(new Uint8Array([1]), [], null)).rejects.toThrow();
  });
});

describe("publicKeyBlocks", () => {
  it("finds the keys pasted into a text, at most five", () => {
    expect(publicKeyBlocks(`hello\n${alice.publicArmor}\nand\n${bob.publicArmor}\n`)).toHaveLength(2);
    expect(publicKeyBlocks("no keys")).toEqual([]);
    expect(publicKeyBlocks(Array.from({ length: 9 }, () => alice.publicArmor).join("\n"))).toHaveLength(5);
  });
});

describe("hostile input", () => {
  it("refuses a message that unpacks past the cap instead of unpacking it", async () => {
    const openpgp = await import("openpgp");
    const key = await engine.generate({ name: null, address: "zip@example.org" });
    const big = new Uint8Array(DECRYPTED_MAX_BYTES + 1024 * 1024);
    const message = await openpgp.createMessage({ binary: big });
    const armor = (await openpgp.encrypt({
      message,
      encryptionKeys: await openpgp.readKey({ armoredKey: key.publicArmor }),
      config: { preferredCompressionAlgorithm: openpgp.enums.compression.zlib },
    })) as string;
    // The zeros pack down to a small block.
    expect(armor.length).toBeLessThan(2 * 1024 * 1024);
    expect(await engine.decrypt(armor, [key.privateArmor], [])).toBeNull();
  }, 120_000);
});
