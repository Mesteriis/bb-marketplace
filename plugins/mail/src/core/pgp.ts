// The cryptography port for OpenPGP (slice 3k). The core and the server
// speak in armored text and bytes; the adapter holds the library. A private
// key is only ever passed in unlocked armor that the caller got from the
// vault, and never leaves the server.

export type PgpKeyInfo = {
  /** Upper-case hex, no spaces. */
  fingerprint: string;
  /** User ids as the key states them ("Name <address>"); data, never markup. */
  userIds: string[];
  /** Lower-case addresses found in the user ids. */
  addresses: string[];
  /** ISO 8601. */
  createdAt: string;
  expiresAt: string | null;
  /** The armor holds the private half. */
  hasPrivate: boolean;
  /** The private half needs a passphrase before use. */
  locked: boolean;
  revoked: boolean;
};

export type PgpSignatureState =
  /** The signature is by a key the caller passed in. */
  | "valid"
  /** A passed key made a signature, but not over these bytes. */
  | "invalid"
  /** No passed key made the signature. */
  | "no_key";

export type PgpSignature = { state: PgpSignatureState; fingerprint: string | null; signerKeyId: string | null };

export interface PgpEngine {
  generate(input: { name: string | null; address: string }): Promise<{ publicArmor: string; privateArmor: string }>;
  /** What an armored public or private key is; null when it is not one key that can be read. */
  inspect(armor: string): Promise<PgpKeyInfo | null>;
  publicOf(privateArmor: string): Promise<string>;
  /** The private key without its passphrase; null when the passphrase is wrong. */
  unlock(privateArmor: string, phrase: string): Promise<string | null>;
  /** The private key protected by a passphrase, for a backup file. */
  lock(privateArmor: string, phrase: string): Promise<string>;
  signDetached(data: Uint8Array, privateArmor: string): Promise<string>;
  verifyDetached(data: Uint8Array, signatureArmor: string, publicArmors: readonly string[]): Promise<PgpSignature>;
  /** Encrypts to every key; also signs when `signWith` is given. */
  encrypt(data: Uint8Array, publicArmors: readonly string[], signWith: string | null): Promise<string>;
  /** Null when none of the private keys opens it. `signature` is null for an unsigned message. */
  decrypt(
    messageArmor: string,
    privateArmors: readonly string[],
    verifyWith: readonly string[],
  ): Promise<{ data: Uint8Array; signature: PgpSignature | null } | null>;
}
