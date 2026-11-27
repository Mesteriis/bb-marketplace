// The SFTP contract Remote Hub offers to OTHER plugins (Commander first), as plain zod schemas. Host-free.
//
// Who may call: only another plugin (`experimental_caller.kind === "plugin"`); the plugin's id is taken from the caller the
// host reports, never from the input. What it gets: file operations on a saved SSH connection the OWNER granted to that
// plugin on the Remote Hub page, at the `read` or `write` level, until the owner revokes it. What it never gets: a secret, a
// key file path, a credential reference, a Keychain item name: none of the schemas below has a field for one (`.strict()`).
// Host keys are the owner's decision on the Remote Hub page, for every kind of sign-in.
import { z } from "zod";

export const SFTP_LIMITS = {
  /** The most bytes one read returns or one write carries. */
  chunkBytes: 4 * 1024 * 1024,
  /** Open channels one plugin may hold at a time. */
  channelsPerPlugin: 4,
  /** Entries in one page of a listing. */
  listPage: 1000,
  /** Entries of one directory a listing walks; past it the listing ends with `limit_exceeded`. */
  listTotal: 10_000,
  pathBytes: 4096,
  reasonChars: 200,
} as const;

export const SFTP_LEVELS = ["read", "write"] as const;
export type SftpLevel = (typeof SFTP_LEVELS)[number];

/** `write` includes `read`. */
export function levelAllows(granted: SftpLevel, needed: SftpLevel): boolean {
  return SFTP_LEVELS.indexOf(granted) >= SFTP_LEVELS.indexOf(needed);
}

const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const base64Schema = (maxBytes: number) => z.string().max(Math.ceil(maxBytes / 3) * 4).regex(BASE64);

/**
 * A remote path or name. `text` when it is valid UTF-8; `bytes` (base64 of the raw bytes) when it is not, so a name the
 * server holds is never silently changed. Remote Hub answers with `text` whenever the bytes are valid UTF-8.
 */
export const sftpPathSchema = z.union([
  z.object({ text: z.string().min(1).max(SFTP_LIMITS.pathBytes).refine((s) => !s.includes("\u0000"), "a path has no NUL") }).strict(),
  z.object({ bytes: base64Schema(SFTP_LIMITS.pathBytes).min(4) }).strict(),
]);
export type SftpPath = z.infer<typeof sftpPathSchema>;

const UINT64_MAX = 18446744073709551615n;
/** An unsigned 64-bit number as a decimal string: sizes and offsets past 2^53 stay exact. */
export const uint64Schema = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,19})$/)
  .refine((s) => BigInt(s) <= UINT64_MAX, "larger than an unsigned 64-bit number");

export const sftpAttrsSchema = z
  .object({
    type: z.enum(["file", "dir", "symlink", "other"]),
    size: uint64Schema,
    /** Seconds since the epoch, as the server reports it (SFTP v3 has whole seconds); null when it sent none. */
    mtime: z.number().int().min(0).nullable(),
    /** The POSIX mode bits with the file type, as the server reports them; null when it sent none. */
    mode: z.number().int().min(0).max(0xffffffff).nullable(),
    /** Where a symlink points, as stored (not resolved); null for anything else or when it could not be read. */
    linkTarget: sftpPathSchema.nullable(),
  })
  .strict();
export type SftpAttrs = z.infer<typeof sftpAttrsSchema>;

const channelId = z.string().uuid();
const profileId = z.string().uuid();
const generation = z.string().regex(/^[0-9a-f]{32}$/);

const onChannel = <T extends z.ZodRawShape>(op: string, shape: T) => z.object({ channelId, op: z.literal(op), ...shape }).strict();

const writeSchema = onChannel("write", {
  path: sftpPathSchema,
  offset: uint64Schema,
  data: base64Schema(SFTP_LIMITS.chunkBytes),
  /**
   * How the file is opened for this chunk. `exclusive`: it must not exist yet (the first chunk of a new file; a second
   * writer gets `exists`). `truncate`: created or emptied (the first chunk when replacing). `existing`: it must exist; the
   * chunk is written at `offset` (every later chunk). The first two start at offset 0.
   */
  create: z.enum(["exclusive", "truncate", "existing"]),
}).refine((w) => w.create === "existing" || w.offset === "0", "exclusive and truncate start at offset 0");

export const sftpOpInputSchema = z.union([
  z.discriminatedUnion("op", [
    onChannel("list", { path: sftpPathSchema, cursor: z.string().min(1).max(128).optional(), limit: z.number().int().min(1).max(SFTP_LIMITS.listPage).optional() }),
    onChannel("stat", { path: sftpPathSchema, /** true: what a symlink points to; false: the link itself. */ follow: z.boolean() }),
    onChannel("realpath", { path: sftpPathSchema }),
    onChannel("read", { path: sftpPathSchema, offset: uint64Schema, length: z.number().int().min(1).max(SFTP_LIMITS.chunkBytes) }),
    onChannel("mkdir", { path: sftpPathSchema }),
    /** `overwrite: true` replaces an existing target atomically where the server can (posix-rename); else `unsupported`. */
    onChannel("rename", { from: sftpPathSchema, to: sftpPathSchema, overwrite: z.boolean() }),
    /** Removes one file or one EMPTY directory; nothing recursive happens on the server. */
    onChannel("remove", { path: sftpPathSchema, kind: z.enum(["file", "dir"]) }),
  ]),
  writeSchema,
]);
export type SftpOpInput = z.infer<typeof sftpOpInputSchema>;
export type SftpOp = SftpOpInput["op"];

const NEEDED: Record<SftpOp, SftpLevel> = { list: "read", stat: "read", realpath: "read", read: "read", write: "write", mkdir: "write", rename: "write", remove: "write" };
export function neededLevel(op: SftpOp): SftpLevel {
  return NEEDED[op];
}

export const sftpOpOutputSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("list"), entries: z.array(z.object({ name: sftpPathSchema, attrs: sftpAttrsSchema }).strict()).max(SFTP_LIMITS.listPage), nextCursor: z.string().nullable() }).strict(),
  z.object({ op: z.literal("stat"), attrs: sftpAttrsSchema }).strict(),
  z.object({ op: z.literal("realpath"), path: sftpPathSchema }).strict(),
  /** `eof`: the chunk reached the end of the file (it may be shorter than asked, or empty). */
  z.object({ op: z.literal("read"), data: base64Schema(SFTP_LIMITS.chunkBytes), eof: z.boolean() }).strict(),
  z.object({ op: z.literal("write"), written: z.number().int().min(0).max(SFTP_LIMITS.chunkBytes) }).strict(),
  z.object({ op: z.literal("mkdir") }).strict(),
  z.object({ op: z.literal("rename") }).strict(),
  z.object({ op: z.literal("remove") }).strict(),
]);
export type SftpOpOutput = z.infer<typeof sftpOpOutputSchema>;

const consent = z.enum(["none", "pending", "granted", "revoked"]);
const level = z.enum(SFTP_LEVELS);

/** The six calls. Every one refuses a caller that is not a plugin with `caller_not_plugin`. */
export const sftpMethods = {
  /** The saved SSH connections, without secrets, with what THIS plugin may do with each. */
  hub_sftp_profiles: {
    input: z.object({}).strict(),
    output: z
      .object({
        profiles: z.array(
          z
            .object({
              id: profileId,
              name: z.string(),
              group: z.string().nullable(),
              host: z.string(),
              port: z.number().int().min(1).max(65535),
              user: z.string().nullable(),
              authType: z.enum(["agent", "key", "password"]),
              consent,
              /** The granted level; null unless `consent` is "granted". */
              level: level.nullable(),
              hostKey: z.enum(["trusted", "unknown", "changed"]),
              /** The connection goes through the owner's SSH configuration in a way SFTP cannot follow: open refuses it. */
              needsConfig: z.boolean(),
            })
            .strict(),
        ),
      })
      .strict(),
  },
  /** Puts a request in front of the owner. It grants nothing; asking again for the same profile and level returns the same request. */
  hub_sftp_request_access: {
    input: z.object({ profileId, level, reason: z.string().max(SFTP_LIMITS.reasonChars).optional() }).strict(),
    output: z.object({ requestId: z.string().uuid(), state: z.enum(["pending", "granted"]) }).strict(),
  },
  hub_sftp_grants: {
    input: z.object({}).strict(),
    output: z.object({ grants: z.array(z.object({ profileId, level, state: z.enum(["pending", "granted", "revoked"]), /** ISO time; null while pending. */ grantedAt: z.string().nullable() }).strict()) }).strict(),
  },
  /** Opens a channel after checking the grant and the host key. A channel dies with the helper generation it was opened in. */
  hub_sftp_open: {
    input: z.object({ profileId }).strict(),
    output: z.object({ channelId, generation }).strict(),
  },
  hub_sftp_op: { input: sftpOpInputSchema, output: sftpOpOutputSchema },
  hub_sftp_close: {
    input: z.object({ channelId }).strict(),
    output: z.object({ closed: z.boolean() }).strict(),
  },
} as const;

/**
 * The stable refusal codes. A refusal is the host's `experimental_PluginRpcRefusal` with the class on the right and a message
 * that STARTS with the code and ": ". Messages never carry a key path, a prompt text or a Keychain item name.
 */
export const SFTP_REFUSALS = {
  caller_not_plugin: "forbidden",
  consent_required: "forbidden",
  consent_revoked: "forbidden",
  /** The server's key is not known yet: the owner decides on the Remote Hub page, then the plugin opens again. */
  host_key_unknown: "forbidden",
  host_key_changed: "forbidden",
  permission_denied: "forbidden",
  profile_not_found: "not_found",
  channel_closed: "not_found",
  no_such_file: "not_found",
  profile_not_sftp: "invalid",
  limit_exceeded: "invalid",
  invalid_path: "invalid",
  profile_needs_config: "conflict",
  /** An `agent` connection, and no SSH agent is running or it holds no key the server accepts. */
  agent_unavailable: "conflict",
  keychain_locked: "conflict",
  keychain_needs_approval: "conflict",
  credential_missing: "conflict",
  auth_failed: "conflict",
  unreachable: "conflict",
  exists: "conflict",
  not_empty: "conflict",
  /** The server cannot do what was asked (an atomic overwrite without posix-rename). */
  unsupported: "conflict",
  failure: "conflict",
} as const satisfies Record<string, "forbidden" | "not_found" | "conflict" | "invalid">;
export type SftpRefusalCode = keyof typeof SFTP_REFUSALS;

/** Realtime events (identifiers only), on the channel named below. */
export const SFTP_EVENTS_CHANNEL = "remote-hub.sftp";
export const sftpConsentEventSchema = z.object({ type: z.literal("sftp.consent"), profileId, state: consent }).strict();
export const sftpChannelEventSchema = z.object({ channelId, state: z.enum(["open", "closed", "revoked", "hostkey_changed"]) }).strict();
