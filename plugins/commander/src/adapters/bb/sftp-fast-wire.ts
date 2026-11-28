import { z } from "zod";
import { base64Bytes, SFTP_LIMITS, sftpMethods, sftpOpOutputSchema } from "../../core/wire/remote-hub-sftp.ts";

/**
 * The same answer as the mirrored `base64Bytes` (src/core/wire/remote-hub-sftp.ts, byte for byte the Remote Hub
 * contract), computed natively for a 4 MiB read reply. The mirror's loop costs 40 to 110 ms per chunk, 29 s of 48 s
 * CPU on a 1 GiB read (S18). Only ASCII text can pass the fast path: `Buffer.from` decodes a non-ASCII character by its
 * low byte (so "ŁAAA" would count as 3 bytes), and the byte length of the text equals its length only if it is ASCII.
 * The decoder also skips whitespace and other junk and accepts the URL alphabet; a decoded length equal to the expected
 * one, with no `-` or `_`, proves every character before the padding was standard. Everything else goes to the mirror.
 */
export function fastBase64Bytes(text: string): number | null {
  const n = text.length;
  if (n % 4 !== 0) return null;
  if (Buffer.byteLength(text, "utf8") === n) {
    const decoded = Buffer.from(text, "base64");
    const pad = n > 0 && text.charCodeAt(n - 1) === 61 ? (text.charCodeAt(n - 2) === 61 ? 2 : 1) : 0;
    if (decoded.length === (n / 4) * 3 - pad && !text.includes("-") && !text.includes("_")) return decoded.length;
  }
  return base64Bytes(text);
}

const readReply = z.object({
  op: z.literal("read"),
  data: z.string().max(Math.ceil(SFTP_LIMITS.chunkBytes / 3) * 4).refine((text) => {
    const bytes = fastBase64Bytes(text);
    return bytes !== null && bytes <= SFTP_LIMITS.chunkBytes;
  }, "not canonical base64, or more bytes than allowed"),
  eof: z.boolean(),
}).strict();

const others = sftpOpOutputSchema.options.filter((option) => option.shape.op.value !== "read");
const opReply = z.discriminatedUnion("op", [readReply, ...others]);

/** The mirrored method table with the read reply checked by `fastBase64Bytes`; everything else is the mirror's. */
export const sftpFastMethods = {
  ...sftpMethods,
  hub_sftp_op: { ...sftpMethods.hub_sftp_op, output: opReply },
} as unknown as typeof sftpMethods;
