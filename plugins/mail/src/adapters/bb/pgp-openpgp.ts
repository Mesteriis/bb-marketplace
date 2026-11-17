// PgpEngine on openpgp.js (slice 3k). Keys are Curve25519 (v4, the format
// other mail programs read today). Errors never carry key material or
// message text: a failure is null or a fixed state.
import * as openpgp from "openpgp";
import type { PgpEngine, PgpKeyInfo, PgpSignature } from "../../core/pgp.ts";

const ADDRESS = /<([^<>\s]+@[^<>\s]+)>\s*$|^([^<>\s]+@[^<>\s]+)$/;

function hex(fingerprint: string): string {
  return fingerprint.toUpperCase();
}

async function readOneKey(armor: string): Promise<openpgp.Key | null> {
  // The library reads the first armored block only: more than one is refused, not half-read.
  if ((armor.match(/-----BEGIN PGP /g) ?? []).length !== 1 || armor.length > 200_000) return null;
  try {
    const keys = await openpgp.readKeys({ armoredKeys: armor });
    return keys.length === 1 ? keys[0]! : null;
  } catch {
    return null;
  }
}

async function publicKeys(armors: readonly string[]): Promise<openpgp.PublicKey[]> {
  const keys: openpgp.PublicKey[] = [];
  for (const armor of armors) {
    const key = await readOneKey(armor);
    if (key !== null) keys.push(key.toPublic());
  }
  return keys;
}

async function privateKey(armor: string): Promise<openpgp.PrivateKey | null> {
  try {
    const key = await openpgp.readPrivateKey({ armoredKey: armor });
    return key.isDecrypted() ? key : null;
  } catch {
    return null;
  }
}

async function signatureOf(
  result: { keyID: openpgp.KeyID; verified: Promise<true> },
  keys: openpgp.PublicKey[],
): Promise<PgpSignature> {
  const signerKeyId = result.keyID.toHex().toUpperCase();
  const signer = keys.find((key) => key.getKeys(result.keyID).length > 0) ?? null;
  if (signer === null) return { state: "no_key", fingerprint: null, signerKeyId };
  try {
    await result.verified;
    return { state: "valid", fingerprint: hex(signer.getFingerprint()), signerKeyId };
  } catch {
    return { state: "invalid", fingerprint: hex(signer.getFingerprint()), signerKeyId };
  }
}

export function createPgpEngine(): PgpEngine {
  return {
    async generate({ name, address }) {
      const { publicKey, privateKey: secret } = await openpgp.generateKey({
        type: "curve25519",
        userIDs: [name === null || name.trim() === "" ? { email: address } : { name: name.trim(), email: address }],
        format: "armored",
      });
      return { publicArmor: publicKey, privateArmor: secret };
    },

    async inspect(armor): Promise<PgpKeyInfo | null> {
      const key = await readOneKey(armor);
      if (key === null) return null;
      const userIds = key.getUserIDs().slice(0, 20).map((id) => id.slice(0, 300));
      const addresses = [
        ...new Set(
          userIds
            .map((id) => {
              const match = ADDRESS.exec(id.trim());
              return match === null ? null : (match[1] ?? match[2] ?? null);
            })
            .filter((a): a is string => a !== null)
            .map((a) => a.toLowerCase()),
        ),
      ];
      let expiresAt: string | null = null;
      try {
        const expiry = await key.getExpirationTime();
        if (expiry instanceof Date) expiresAt = expiry.toISOString();
      } catch {
        expiresAt = null;
      }
      let revoked = false;
      try {
        revoked = await key.isRevoked();
      } catch {
        revoked = false;
      }
      return {
        fingerprint: hex(key.getFingerprint()),
        userIds,
        addresses,
        createdAt: key.getCreationTime().toISOString(),
        expiresAt,
        hasPrivate: key.isPrivate(),
        locked: key.isPrivate() && !(key as openpgp.PrivateKey).isDecrypted(),
        revoked,
      };
    },

    async publicOf(privateArmor) {
      const key = await openpgp.readPrivateKey({ armoredKey: privateArmor });
      return key.toPublic().armor();
    },

    async unlock(privateArmor, phrase) {
      try {
        const key = await openpgp.readPrivateKey({ armoredKey: privateArmor });
        if (key.isDecrypted()) return key.armor();
        const open = await openpgp.decryptKey({ privateKey: key, passphrase: phrase });
        return open.armor();
      } catch {
        return null;
      }
    },

    async lock(privateArmor, phrase) {
      const key = await openpgp.readPrivateKey({ armoredKey: privateArmor });
      const locked = await openpgp.encryptKey({ privateKey: key, passphrase: phrase });
      return locked.armor();
    },

    async signDetached(data, privateArmor) {
      const key = await privateKey(privateArmor);
      if (key === null) throw new Error("pgp: the signing key cannot be used");
      const message = await openpgp.createMessage({ binary: data });
      return (await openpgp.sign({ message, signingKeys: key, detached: true, format: "armored" })) as string;
    },

    async verifyDetached(data, signatureArmor, publicArmors) {
      try {
        const keys = await publicKeys(publicArmors);
        const signature = await openpgp.readSignature({ armoredSignature: signatureArmor });
        const message = await openpgp.createMessage({ binary: data });
        const { signatures } = await openpgp.verify({ message, signature, verificationKeys: keys });
        const first = signatures[0];
        if (first === undefined) return { state: "invalid", fingerprint: null, signerKeyId: null };
        return await signatureOf(first, keys);
      } catch {
        return { state: "invalid", fingerprint: null, signerKeyId: null };
      }
    },

    async encrypt(data, publicArmors, signWith) {
      const keys = await publicKeys(publicArmors);
      if (keys.length !== publicArmors.length || keys.length === 0) throw new Error("pgp: a recipient key cannot be used");
      const signer = signWith === null ? null : await privateKey(signWith);
      if (signWith !== null && signer === null) throw new Error("pgp: the signing key cannot be used");
      const message = await openpgp.createMessage({ binary: data });
      return (await openpgp.encrypt({
        message,
        encryptionKeys: keys,
        ...(signer === null ? {} : { signingKeys: signer }),
        format: "armored",
      })) as string;
    },

    async decrypt(messageArmor, privateArmors, verifyWith) {
      let message: openpgp.Message<string>;
      try {
        message = await openpgp.readMessage({ armoredMessage: messageArmor });
      } catch {
        return null;
      }
      const keys: openpgp.PrivateKey[] = [];
      for (const armor of privateArmors) {
        const key = await privateKey(armor);
        if (key !== null) keys.push(key);
      }
      if (keys.length === 0) return null;
      const verification = await publicKeys(verifyWith);
      try {
        const { data, signatures } = await openpgp.decrypt({
          message,
          decryptionKeys: keys,
          verificationKeys: verification,
          format: "binary",
        });
        const first = signatures[0];
        return {
          data: data as Uint8Array,
          signature: first === undefined ? null : await signatureOf(first, verification),
        };
      } catch {
        return null;
      }
    },
  };
}
