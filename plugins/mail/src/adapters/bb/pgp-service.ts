// OpenPGP for the owner (slice 3k): the keys Mail keeps, signing and
// encrypting what the owner sends, and opening or checking what arrives.
// Rules this module holds:
// - A private key is stored sealed by the vault and unsealed only here, for
//   one operation; it never goes to the page (a backup leaves locked by the
//   owner's passphrase), to an agent, to a model, to BB or into a log.
// - Decrypted text is returned to the owner's page for that one view and is
//   never stored, indexed, or handed to anything else.
// - Log lines name an outcome and a message id, never an address, a
//   fingerprint, a subject or text.
import PostalMime from "postal-mime";
import { ComposeError } from "../../core/compose.ts";
import { PGP_SEND_TEXT, type ProtectRequest } from "../../core/compose-outbox.ts";
import {
  PgpMimeError,
  armorBlock,
  boundaryFor,
  extractEncrypted,
  extractSigned,
  publicKeyBlocks,
  splitForProtection,
  wrapEncrypted,
  wrapSigned,
} from "../../core/pgp-mime.ts";
import type { PgpEngine, PgpKeyInfo, PgpSignature } from "../../core/pgp.ts";
import type { Clock, MailStore, PgpKeyRow, SecretVault } from "../../core/ports.ts";

export type PgpCertView = {
  id: string;
  kind: "own" | "contact";
  fingerprint: string;
  addresses: string[];
  userIds: string[];
  createdAt: string;
  expiresAt: string | null;
  addedAt: string;
  source: "generated" | "imported" | "message";
  expired: boolean;
};

export type PgpImportResult = "added" | "exists" | "full" | "unreadable" | "locked" | "wrong_phrase" | "revoked";

export type PgpSignatureView = {
  state: "valid" | "invalid" | "no_cert";
  fingerprint: string | null;
  /** The key id the signature names, for "no_cert". */
  signer: string | null;
  /** The saved key that made it belongs to the message's sender. */
  fromSender: boolean;
};

export type PgpOpened =
  | { state: "not_pgp" | "no_cert" | "failed" }
  | {
      state: "opened";
      text: string | null;
      html: string | null;
      attachments: { fileName: string; size: number }[];
      signature: PgpSignatureView | null;
    };

export type PgpServiceDeps = {
  store: MailStore;
  engine: PgpEngine;
  /** Null while the credential key is not set. */
  vault: () => SecretVault | null;
  clock: Clock;
  newId: () => string;
  log: (line: string) => void;
};

/** Decrypted content shown to the owner is capped like any other body. */
const OPENED_TEXT_MAX = 2 * 1024 * 1024;
const OPENED_ATTACHMENTS_MAX = 50;

const lower = (address: string) => address.trim().toLowerCase();

export function createPgpService(deps: PgpServiceDeps) {
  const { store, engine } = deps;

  const view = (row: PgpKeyRow): PgpCertView => ({
    id: row.id,
    kind: row.kind,
    fingerprint: row.fingerprint,
    addresses: row.addresses,
    userIds: row.userIds,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    addedAt: row.addedAt,
    source: row.source,
    expired: row.expiresAt !== null && Date.parse(row.expiresAt) <= deps.clock.now().getTime(),
  });

  const usable = (row: PgpKeyRow) => !view(row).expired;
  const keysFor = (kind: "own" | "contact", address: string) =>
    store.listPgpKeys().filter((row) => row.kind === kind && usable(row) && row.addresses.includes(lower(address)));

  /** The unsealed private armor of an own key; null when the vault is not ready or the key is gone. */
  function privateOf(id: string): string | null {
    const vault = deps.vault();
    const sealed = store.pgpPrivateSealed(id);
    if (vault === null || sealed === null) return null;
    try {
      return vault.open(sealed);
    } catch {
      return null;
    }
  }

  function rowOf(info: PgpKeyInfo, kind: "own" | "contact", publicArmor: string, source: PgpKeyRow["source"]): PgpKeyRow {
    return {
      id: `pgp_${deps.newId()}`,
      kind,
      fingerprint: info.fingerprint,
      addresses: info.addresses,
      userIds: info.userIds,
      publicArmor,
      createdAt: info.createdAt,
      expiresAt: info.expiresAt,
      addedAt: deps.clock.now().toISOString(),
      source,
    };
  }

  async function addPublic(armor: string, source: PgpKeyRow["source"]): Promise<{ result: PgpImportResult; cert: PgpCertView | null }> {
    const info = await engine.inspect(armor);
    if (info === null || info.addresses.length === 0) return { result: "unreadable", cert: null };
    if (info.revoked) return { result: "revoked", cert: null };
    // Only the public half is kept for a contact, whatever was pasted.
    const publicArmor = info.hasPrivate ? await engine.publicOf(armor).catch(() => null) : armor;
    if (publicArmor === null) return { result: "unreadable", cert: null };
    const row = rowOf({ ...info, hasPrivate: false, locked: false }, "contact", publicArmor, source);
    const saved = store.savePgpKey(row, null);
    return saved === "saved" ? { result: "added", cert: view(row) } : { result: saved, cert: null };
  }

  return {
    list(): PgpCertView[] {
      return store.listPgpKeys().map(view);
    },

    /** A new key pair for one of the owner's sending addresses. */
    async generate(address: string, name: string | null): Promise<PgpCertView | { refused: "vault" | "exists" | "full" }> {
      const vault = deps.vault();
      if (vault === null) return { refused: "vault" };
      if (keysFor("own", address).length > 0) return { refused: "exists" };
      const made = await engine.generate({ name, address: lower(address) });
      const info = await engine.inspect(made.publicArmor);
      if (info === null) throw new Error("pgp: the new key cannot be read");
      const row = rowOf(info, "own", made.publicArmor, "generated");
      const saved = store.savePgpKey(row, vault.seal(made.privateArmor));
      if (saved !== "saved") return { refused: saved };
      deps.log("pgp: key made");
      return view(row);
    },

    /**
     * Pasted armor: a public key becomes a contact key; a private key (a
     * backup, with its passphrase) becomes an own key.
     */
    async importArmor(armor: string, phrase: string | null): Promise<{ result: PgpImportResult; added: PgpCertView[] }> {
      const secret = armorBlock(armor, "PRIVATE KEY BLOCK");
      if (secret !== null) {
        const vault = deps.vault();
        const info = await engine.inspect(secret);
        if (info === null || info.addresses.length === 0 || vault === null) return { result: "unreadable", added: [] };
        if (info.revoked) return { result: "revoked", added: [] };
        let open = secret;
        if (info.locked) {
          if (phrase === null || phrase === "") return { result: "locked", added: [] };
          const unlocked = await engine.unlock(secret, phrase);
          if (unlocked === null) return { result: "wrong_phrase", added: [] };
          open = unlocked;
        }
        const publicArmor = await engine.publicOf(open);
        const row = rowOf({ ...info, locked: false }, "own", publicArmor, "imported");
        const saved = store.savePgpKey(row, vault.seal(open));
        deps.log(`pgp: own key import ${saved}`);
        return saved === "saved" ? { result: "added", added: [view(row)] } : { result: saved, added: [] };
      }
      const blocks = publicKeyBlocks(armor);
      if (blocks.length === 0) return { result: "unreadable", added: [] };
      const added: PgpCertView[] = [];
      let last: PgpImportResult = "unreadable";
      for (const block of blocks) {
        const one = await addPublic(block, "imported");
        last = one.result;
        if (one.cert !== null) added.push(one.cert);
      }
      return { result: added.length > 0 ? "added" : last, added };
    },

    remove(id: string): boolean {
      const removed = store.deletePgpKey(id);
      if (removed) deps.log("pgp: key removed");
      return removed;
    },

    /**
     * The public key as armor; with a passphrase, an own key's private half
     * locked by it, for a backup the owner keeps.
     */
    async exportArmor(id: string, phrase: string | null): Promise<{ armor: string; fileName: string } | null> {
      const row = store.getPgpKey(id);
      if (row === null) return null;
      const short = row.fingerprint.slice(-16);
      if (phrase === null) return { armor: row.publicArmor, fileName: `openpgp-${short}-public.asc` };
      if (row.kind !== "own") return null;
      const open = privateOf(id);
      if (open === null) return null;
      deps.log("pgp: private key backup made");
      return { armor: await engine.lock(open, phrase), fileName: `openpgp-${short}-private-backup.asc` };
    },

    /** Whether `from` can sign, and which recipients have no usable key. */
    check(from: string, recipients: readonly string[]): { canSign: boolean; missing: string[] } {
      const all = store.listPgpKeys().filter(usable);
      const has = (kind: "own" | "contact", address: string) =>
        all.some((row) => row.kind === kind && row.addresses.includes(lower(address)));
      return {
        canSign: has("own", from),
        // The owner's own addresses count: a key made here can receive too.
        missing: [...new Set(recipients.map(lower))].filter((a) => !has("contact", a) && !has("own", a)),
      };
    },

    /** queueSend's `protect`: the built message, signed and/or encrypted. */
    async protect(mime: Uint8Array, request: ProtectRequest): Promise<Uint8Array> {
      const own = keysFor("own", request.from)[0];
      const signer = own === undefined ? null : privateOf(own.id);
      if ((request.sign || request.encrypt) && (own === undefined || signer === null)) {
        throw new ComposeError("invalid", PGP_SEND_TEXT.no_own);
      }
      try {
        const { outer, entity } = splitForProtection(mime);
        if (!request.encrypt) {
          const signature = await engine.signDetached(entity, signer!);
          return wrapSigned(outer, entity, signature, boundaryFor(request.seed, [entity]));
        }
        const armors: string[] = [own!.publicArmor];
        for (const address of request.recipients) {
          const key = keysFor("contact", address)[0] ?? keysFor("own", address)[0];
          if (key === undefined) throw new ComposeError("invalid", PGP_SEND_TEXT.missing);
          if (!armors.includes(key.publicArmor)) armors.push(key.publicArmor);
        }
        const armor = await engine.encrypt(entity, armors, request.sign ? signer : null);
        return wrapEncrypted(outer, armor, boundaryFor(request.seed, []));
      } catch (error) {
        if (error instanceof ComposeError) throw error;
        deps.log("pgp: protect failed");
        throw new ComposeError("invalid", PGP_SEND_TEXT.failed);
      }
    },

    signatureView(signature: PgpSignature, sender: string | null): PgpSignatureView {
      const key =
        signature.fingerprint === null
          ? undefined
          : store.listPgpKeys().find((row) => row.fingerprint === signature.fingerprint);
      return {
        state: signature.state === "no_key" ? "no_cert" : signature.state,
        fingerprint: signature.fingerprint,
        signer: signature.signerKeyId,
        fromSender: key !== undefined && sender !== null && key.addresses.includes(lower(sender)),
      };
    },

    /** Checks a PGP/MIME signed message against every saved key. */
    async verify(raw: Uint8Array, sender: string | null): Promise<PgpSignatureView | { state: "not_pgp" | "failed" }> {
      let cut: ReturnType<typeof extractSigned>;
      try {
        cut = extractSigned(raw);
      } catch (error) {
        return { state: error instanceof PgpMimeError && error.kind === "not_pgp" ? "not_pgp" : "failed" };
      }
      const armors = store.listPgpKeys().map((row) => row.publicArmor);
      return this.signatureView(await engine.verifyDetached(cut.entity, cut.signatureArmor, armors), sender);
    },

    /** Opens an encrypted message with the owner's keys. The result is for the owner's page only. */
    async open(raw: Uint8Array, sender: string | null): Promise<PgpOpened> {
      let armor: string;
      try {
        armor = extractEncrypted(raw);
      } catch (error) {
        return { state: error instanceof PgpMimeError && error.kind === "not_pgp" ? "not_pgp" : "failed" };
      }
      const owns = store.listPgpKeys().filter((row) => row.kind === "own");
      const privates = owns.map((row) => privateOf(row.id)).filter((a): a is string => a !== null);
      if (privates.length === 0) return { state: "no_cert" };
      const opened = await engine.decrypt(armor, privates, store.listPgpKeys().map((row) => row.publicArmor));
      if (opened === null) return { state: "no_cert" };
      try {
        const inner = await PostalMime.parse(opened.data);
        const clip = (text: string | undefined) =>
          text === undefined || text === "" ? null : text.slice(0, OPENED_TEXT_MAX);
        // Bytes that are not a MIME entity are the text itself (an inline armored body).
        const plain = inner.text === undefined && inner.html === undefined && inner.attachments.length === 0;
        return {
          state: "opened",
          text: plain ? clip(new TextDecoder().decode(opened.data)) : clip(inner.text),
          html: clip(inner.html),
          attachments: inner.attachments.slice(0, OPENED_ATTACHMENTS_MAX).map((a) => ({
            fileName: (a.filename ?? "").replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 255),
            size: typeof a.content === "string" ? a.content.length : a.content.byteLength,
          })),
          signature: opened.signature === null ? null : this.signatureView(opened.signature, sender),
        };
      } catch {
        return { state: "failed" };
      }
    },

    /** Saves the public keys a message carries (attached or pasted) as contact keys. */
    async importFromMessage(raw: Uint8Array): Promise<{ result: PgpImportResult; added: PgpCertView[] }> {
      let found: string[];
      try {
        const parsed = await PostalMime.parse(raw);
        const texts = [
          parsed.text ?? "",
          ...parsed.attachments
            .filter((a) => /pgp-keys|\.asc$|\.key$|\.gpg$/i.test(`${a.mimeType} ${a.filename ?? ""}`))
            .slice(0, 5)
            .map((a) => (typeof a.content === "string" ? a.content : new TextDecoder().decode(a.content)).slice(0, 200_000)),
        ];
        found = texts.flatMap(publicKeyBlocks).slice(0, 5);
      } catch {
        return { result: "unreadable", added: [] };
      }
      if (found.length === 0) return { result: "unreadable", added: [] };
      const added: PgpCertView[] = [];
      let last: PgpImportResult = "unreadable";
      for (const block of found) {
        const one = await addPublic(block, "message");
        last = one.result;
        if (one.cert !== null) added.push(one.cert);
      }
      return { result: added.length > 0 ? "added" : last, added };
    },
  };
}

export type PgpService = ReturnType<typeof createPgpService>;
