import { z } from "zod";
import { Entry, EntryKind, Fingerprint } from "../model.ts";
import { canonicalBase64, NameSegment, ResourcePath } from "../path.ts";
import { LIST_PAGE_MAX, READ_CHUNK_MAX } from "../provider.ts";
import { Size } from "../size.ts";

const chunk = canonicalBase64(Math.ceil(READ_CHUNK_MAX / 3) * 4)
  .refine((b64) => b64.length / 4 * 3 - (b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0) <= READ_CHUNK_MAX)
  .or(z.literal(""));
const path = z.object({ path: ResourcePath }).strict();
const empty = z.object({}).strict();
const session = z.object({ session: z.uuid() }).strict();
const transfer = z.object({ from: ResourcePath, to: ResourcePath, replace: z.boolean() }).strict();

export const HostFsContract = {
  list: {
    input: path.extend({ cursor: z.string().max(160).nullable(), limit: z.int().min(1).max(LIST_PAGE_MAX) }),
    output: z.object({ entries: z.array(Entry).max(LIST_PAGE_MAX), cursor: z.string().max(160).nullable() }).strict(),
  },
  stat: { input: path, output: Entry.nullable() },
  read: {
    input: path.extend({ offset: Size, length: z.int().min(0).max(READ_CHUNK_MAX), expect: Fingerprint.nullable() }),
    output: z.object({ b64: chunk }).strict(),
  },
  writeOpen: {
    input: z.object({ target: ResourcePath }).strict(),
    output: session.extend({ tempName: NameSegment }),
  },
  writeChunk: { input: session.extend({ offset: Size, b64: chunk }), output: empty },
  writeCommit: {
    input: session.extend({ replace: z.boolean(), expectTarget: Fingerprint.nullable() }),
    output: Fingerprint,
  },
  writeAbort: { input: session, output: empty },
  mkdir: { input: path, output: empty },
  rename: { input: transfer, output: empty },
  remove: { input: path.extend({ kind: EntryKind }), output: empty },
  copyWithin: {
    input: transfer.extend({ expectTarget: Fingerprint.or(z.literal("absent")).optional() }),
    output: Fingerprint,
  },
  sha256: { input: path, output: z.object({ hex: z.string().regex(/^[0-9a-f]{64}$/) }).strict() },
  home: { input: empty, output: z.object({ path: ResourcePath, caseSensitive: z.boolean() }).strict() },
};

export type HostFsMethod = keyof typeof HostFsContract;
export type HostFsInput<M extends HostFsMethod> = z.infer<(typeof HostFsContract)[M]["input"]>;
export type HostFsOutput<M extends HostFsMethod> = z.infer<(typeof HostFsContract)[M]["output"]>;
