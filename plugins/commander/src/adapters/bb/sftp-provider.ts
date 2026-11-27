// FileProvider for SFTP, reached through Remote Hub's plugin RPC (hub_sftp_*). Adapter: it knows the
// Remote Hub wire contract (src/core/wire/remote-hub-sftp.ts) and maps it onto the core's ports.
// Commander holds no secret here: keys, host keys and sign-in stay inside Remote Hub.
//
// Error rules, applied in one place (`send`):
// - a refusal is definitive when the server says the operation was not applied (see DEFINITIVE);
// - any other failure of a mutation after it was sent is outcome_unknown and is never repeated;
// - a read may be repeated once on a closed channel; a cancelled read is cancelled.
import { ZodError } from "zod";
import { CommanderError, type ErrorCode } from "../../core/errors.ts";
import { Entry, type Capability, type Endpoint, type Fingerprint } from "../../core/model.ts";
import { NameSegment, type ResourcePath } from "../../core/path.ts";
import { LIST_PAGE_MAX, READ_CHUNK_MAX, type FileProvider, type WriteSession } from "../../core/provider.ts";
import {
  SFTP_LIMITS,
  SftpRefusal,
  sftpMethods,
  type RemoteHubPort,
  type SftpAttrs,
  type SftpInput,
  type SftpMethodName,
  type SftpOp,
  type SftpOpInput,
  type SftpOpOutput,
  type SftpOutput,
  type SftpPath,
  type SftpRefusalCode,
} from "../../core/wire/remote-hub-sftp.ts";

export interface SftpWriteSession extends WriteSession {
  /** The temporary file: parent(target) + the caller's tempName; known from the start, stable until commit or abort. */
  readonly tempPath: ResourcePath;
}

/** The core's FileProvider, with openWrite giving the session that carries its tempPath. */
export type SftpProvider = Omit<FileProvider, "openWrite"> & {
  openWrite(target: ResourcePath, opts: { tempName: NameSegment }, signal: AbortSignal): Promise<SftpWriteSession>;
  close(): Promise<void>;
};

export interface SftpProviderOptions {
  port: RemoteHubPort;
  profileId: string;
  endpoint: Endpoint;
}

const SLASH = 0x2f;
const DOT = 0x2e;

/** Refusal code → core error code. Remote Hub's own text is never copied into the message. */
const ERROR_CODE: Record<SftpRefusalCode, ErrorCode> = {
  caller_not_plugin: "permission_denied",
  consent_required: "consent_required",
  consent_revoked: "consent_required",
  host_key_unknown: "host_key_rejected",
  host_key_changed: "host_key_rejected",
  permission_denied: "permission_denied",
  profile_not_found: "unsupported",
  channel_closed: "connection_failed",
  no_such_file: "not_found",
  profile_not_sftp: "unsupported",
  limit_exceeded: "limit_exceeded",
  invalid_path: "invalid_path",
  profile_needs_config: "unsupported",
  agent_unavailable: "auth_failed",
  keychain_locked: "auth_failed",
  keychain_needs_approval: "auth_failed",
  credential_missing: "auth_failed",
  auth_failed: "auth_failed",
  unreachable: "connection_failed",
  exists: "already_exists",
  not_empty: "is_a_directory",
  unsupported: "unsupported",
  failure: "internal",
};

/**
 * Refusals the server gives when it did NOT apply the operation. Any other refusal of a mutation
 * (unreachable, failure, channel_closed) can hide an applied change, so it is outcome_unknown.
 */
const DEFINITIVE: ReadonlySet<SftpRefusalCode> = new Set<SftpRefusalCode>([
  "caller_not_plugin",
  "consent_required",
  "consent_revoked",
  "host_key_unknown",
  "host_key_changed",
  "permission_denied",
  "profile_not_found",
  "profile_not_sftp",
  "limit_exceeded",
  "invalid_path",
  "profile_needs_config",
  "agent_unavailable",
  "keychain_locked",
  "keychain_needs_approval",
  "credential_missing",
  "auth_failed",
  "no_such_file",
  "exists",
  "not_empty",
  "unsupported",
]);

/** Fixed, safe messages: no key path, no Keychain name, no text from the server. */
const MESSAGE: Partial<Record<ErrorCode, string>> = {
  cancelled: "Cancelled",
  changed_since_plan: "The target changed since the plan",
  consent_required: "Remote Hub has no grant for this profile",
  host_key_rejected: "The server's host key is not trusted; decide it on the Remote Hub page",
  auth_failed: "Sign-in to the SFTP server failed",
  connection_failed: "The SFTP server is unreachable",
  permission_denied: "Permission denied on the server",
  not_found: "Not found on the server",
  already_exists: "Already exists on the server",
  is_a_directory: "Directory is not empty",
  unsupported: "The server cannot do this operation",
  limit_exceeded: "Directory has more entries than can be listed",
  invalid_path: "Invalid resource path",
  invalid_name: "Invalid name",
  outcome_unknown: "The outcome of the operation is unknown",
  internal: "Remote Hub call failed",
};

function commanderError(code: ErrorCode): CommanderError {
  return new CommanderError(code, MESSAGE[code] ?? "Remote Hub call failed", code === "connection_failed");
}

function isUnknown(error: unknown): boolean {
  return error instanceof CommanderError && error.code === "outcome_unknown";
}

function isAbort(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted || (typeof error === "object" && error !== null && "name" in error && error.name === "AbortError");
}

/** A transport failure of a read or of a call before anything was applied. */
function transportError(error: unknown, signal: AbortSignal): CommanderError {
  return isAbort(error, signal) ? commanderError("cancelled") : commanderError("connection_failed");
}

/**
 * Maps refusals to core errors. A core error passes. A schema error, a reply for another
 * operation, or anything unexpected becomes internal, with fixed text and no field name.
 */
async function guard<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof SftpRefusal) throw commanderError(ERROR_CODE[error.code]);
    if (error instanceof CommanderError) throw error;
    throw commanderError("internal");
  }
}

function narrow<K extends SftpOpOutput["op"]>(output: SftpOpOutput, op: K): Extract<SftpOpOutput, { op: K }> {
  if (output.op !== op) throw commanderError("internal");
  return output as Extract<SftpOpOutput, { op: K }>;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

const encode = (value: string) => new TextEncoder().encode(value);

function segmentBytes(name: NameSegment): Uint8Array {
  return "t" in name ? encode(name.t) : new Uint8Array(Buffer.from(name.b, "base64"));
}

/** Text when the bytes are valid UTF-8, else the raw bytes in base64 (the contract's rule). */
function wireOf(bytes: Uint8Array): SftpPath {
  try {
    return { text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes) };
  } catch {
    return { bytes: Buffer.from(bytes).toString("base64") };
  }
}

function segmentFromBytes(bytes: Uint8Array): NameSegment {
  try {
    return { t: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes) };
  } catch {
    return { b: Buffer.from(bytes).toString("base64") };
  }
}

function segmentFromWire(name: SftpPath): NameSegment {
  return "text" in name ? { t: name.text } : segmentFromBytes(new Uint8Array(Buffer.from(name.bytes, "base64")));
}

/**
 * A name the server sent, as a core segment. "." and ".." are skipped (null). Anything else the core
 * would not accept (a slash, a NUL, over 1024 characters) is internal; its text is not echoed.
 */
function trustedName(name: SftpPath): NameSegment | null {
  const segment = segmentFromWire(name);
  if ("t" in segment && (segment.t === "." || segment.t === "..")) return null;
  const parsed = NameSegment.safeParse(segment);
  if (!parsed.success) throw commanderError("internal");
  return parsed.data;
}

function toWirePath(path: ResourcePath): SftpPath {
  if (path.segments.length === 0) return { text: "/" };
  const bytes = concat(path.segments.map((name) => concat([new Uint8Array([SLASH]), segmentBytes(name)])));
  if (bytes.length > SFTP_LIMITS.pathBytes) throw commanderError("invalid_path");
  return wireOf(bytes);
}

/** The root has no name of its own; the valid segment t:"root" stands for it (as in S4). */
function nameOfPath(path: ResourcePath): NameSegment {
  return path.segments.at(-1) ?? { t: "root" };
}

function isHidden(name: NameSegment): boolean {
  return "t" in name ? name.t.startsWith(".") : Buffer.from(name.b, "base64")[0] === DOT;
}

function linkTargetOf(target: SftpPath): { t: string } | { b: string } {
  const segment = segmentFromWire(target);
  return "t" in segment ? { t: segment.t } : { b: segment.b };
}

function toEntry(name: NameSegment, attrs: SftpAttrs): Entry {
  return {
    name,
    kind: attrs.type,
    size: attrs.size,
    mtimeNs: attrs.mtime === null ? null : (BigInt(attrs.mtime) * 1_000_000_000n).toString(),
    mtimePrecision: attrs.mtime === null ? "unknown" : "s",
    mode: attrs.mode !== null && attrs.mode <= 0o177777 ? attrs.mode : null,
    linkTarget: attrs.linkTarget === null ? null : linkTargetOf(attrs.linkTarget),
    hidden: isHidden(name),
  };
}

function fingerprintOf(entry: Entry): Fingerprint {
  return { size: entry.size, mtimeNs: entry.mtimeNs };
}

function sameFingerprint(a: Fingerprint, b: Fingerprint): boolean {
  return a.size === b.size && a.mtimeNs === b.mtimeNs;
}

export function createSftpProvider(options: SftpProviderOptions): SftpProvider {
  const { port, profileId, endpoint } = options;
  const capabilities = new Set<Capability>(["list", "stat", "read", "write", "mkdir", "rename", "remove", "seek"]);

  let channelId: string | null = null;
  let opening: Promise<string> | null = null;

  function callPort<M extends SftpMethodName>(method: M, input: SftpInput<M>, signal: AbortSignal): Promise<SftpOutput<M>> {
    return port.call(method, input, signal).then((raw) => sftpMethods[method].output.parse(raw) as SftpOutput<M>);
  }

  /** Losing a channel also withdraws what was declared on it: atomicReplace belongs to a channel. */
  function dropChannel(id: string): void {
    if (channelId === id) {
      channelId = null;
      capabilities.delete("atomicReplace");
    }
  }

  /**
   * Waits for a shared open on behalf of ONE caller. The caller's own signal decides its cancellation: the shared
   * open itself runs on a signal no caller owns, so one caller's abort never fails another caller's wait.
   */
  function waitForOpen(shared: Promise<string>, signal: AbortSignal): Promise<string> {
    if (signal.aborted) return Promise.reject(commanderError("cancelled"));
    return new Promise<string>((resolve, reject) => {
      const onAbort = () => reject(commanderError("cancelled"));
      signal.addEventListener("abort", onAbort, { once: true });
      shared.then(
        (value) => {
          signal.removeEventListener("abort", onAbort);
          resolve(value);
        },
        (error: unknown) => {
          signal.removeEventListener("abort", onAbort);
          // The shared failure is neutral; the caller's own signal turns it into cancelled if that is what it asked for.
          reject(signal.aborted ? commanderError("cancelled") : error);
        },
      );
    });
  }

  function openChannel(signal: AbortSignal): Promise<string> {
    if (channelId !== null) return Promise.resolve(channelId);
    if (opening === null) {
      opening = callPort("hub_sftp_open", { profileId }, new AbortController().signal).then(
        (opened) => {
          channelId = opened.channelId;
          opening = null;
          return opened.channelId;
        },
        (error: unknown) => {
          opening = null;
          if (error instanceof SftpRefusal || error instanceof ZodError) throw error;
          throw commanderError("connection_failed");
        },
      );
      // Every caller may have left (aborted) before the open failed; the shared failure is still handled here,
      // so it never surfaces as an unhandled rejection. Each caller still sees it through its own wait.
      opening.catch(() => undefined);
    }
    return waitForOpen(opening, signal);
  }

  /** One operation. A read is reopened once on a closed channel, and never after the caller has aborted. */
  async function execute(build: (channel: string) => SftpOpInput, mutating: boolean, signal: AbortSignal): Promise<SftpOpOutput> {
    if (signal.aborted) throw commanderError("cancelled");
    const first = await openChannel(signal);
    try {
      return await send(build(first), mutating, signal);
    } catch (error) {
      if (mutating || !(error instanceof SftpRefusal && error.code === "channel_closed")) throw error;
      if (signal.aborted) throw commanderError("cancelled");
      const second = await openChannel(signal);
      return send(build(second), false, signal);
    }
  }

  /** One call on the channel. A mutation is never repeated; its ambiguous failures are outcome_unknown. */
  async function send(input: SftpOpInput, mutating: boolean, signal: AbortSignal): Promise<SftpOpOutput> {
    // Checked right before the call: an abort during hub_sftp_open or before a retry sends nothing.
    if (signal.aborted) throw commanderError("cancelled");
    let output: SftpOpOutput;
    try {
      output = await callPort("hub_sftp_op", input, signal);
    } catch (error) {
      if (error instanceof SftpRefusal) {
        if (error.code === "channel_closed" || error.code === "consent_revoked") dropChannel(input.channelId);
        if (mutating && !DEFINITIVE.has(error.code)) throw commanderError("outcome_unknown");
        throw error;
      }
      // A reply the schema refuses (ZodError) or a lost reply: a mutation may have been applied, so its outcome is unknown.
      if (mutating) throw commanderError("outcome_unknown");
      if (error instanceof ZodError) throw error;
      throw transportError(error, signal);
    }
    // A reply to another operation says nothing about this one: unknown for a mutation, internal for a read.
    if (output.op !== input.op) throw commanderError(mutating ? "outcome_unknown" : "internal");
    return output;
  }

  async function statEntry(path: ResourcePath, signal: AbortSignal): Promise<Entry | null> {
    try {
      const out = narrow(
        await execute((channel) => ({ channelId: channel, op: "stat", path: toWirePath(path), follow: false }), false, signal),
        "stat",
      );
      return toEntry(nameOfPath(path), out.attrs);
    } catch (error) {
      if (error instanceof SftpRefusal && error.code === "no_such_file") return null;
      throw error;
    }
  }

  /** A removal. With an expectation (see `remove`), the check and the removal are two calls: the window is as in renameOp. */
  async function removeOp(path: ResourcePath, kind: "file" | "dir", signal: AbortSignal): Promise<void> {
    narrow(
      await execute((channel) => ({ channelId: channel, op: "remove", path: toWirePath(path), kind }), true, signal),
      "remove",
    );
  }

  /**
   * Rename under the S3 contract. A Fingerprint expectation is checked by a read first; a mismatch sends no rename.
   * "absent" is decided by the server's `exists` answer to an overwrite:false rename. atomicReplace is declared only
   * when an existing target was replaced atomically on the channel that is still open.
   *
   * Race window: the read and the rename are two calls. Another client may change the target between them; the
   * server's own rename check (overwrite) is the last guard, and a fingerprint change inside the window is not seen.
   * A Fingerprint expectation with replace:false is an inconsistent call (there is nothing to replace): internal.
   */
  async function renameOp(
    from: ResourcePath,
    to: ResourcePath,
    opts: { replace: boolean; expectTarget?: Fingerprint | "absent" },
    signal: AbortSignal,
  ): Promise<void> {
    if (!opts.replace && opts.expectTarget !== undefined && opts.expectTarget !== "absent") {
      throw commanderError("internal");
    }
    const overwrite = opts.expectTarget === "absent" ? false : opts.replace;
    let existed = false;
    if (opts.expectTarget !== undefined && opts.expectTarget !== "absent") {
      const current = await statEntry(to, signal);
      if (current === null || !sameFingerprint(fingerprintOf(current), opts.expectTarget)) {
        throw commanderError("changed_since_plan");
      }
      existed = true;
    } else if (overwrite) {
      existed = (await statEntry(to, signal)) !== null;
    }
    const sent: { channel: string | null } = { channel: null };
    try {
      narrow(
        await execute(
          (channel) => {
            sent.channel = channel;
            return { channelId: channel, op: "rename", from: toWirePath(from), to: toWirePath(to), overwrite };
          },
          true,
          signal,
        ),
        "rename",
      );
    } catch (error) {
      if (opts.expectTarget === "absent" && error instanceof SftpRefusal && error.code === "exists") {
        throw commanderError("changed_since_plan");
      }
      throw error;
    }
    if (overwrite && existed && sent.channel !== null && sent.channel === channelId) capabilities.add("atomicReplace");
  }

  /** One write call. A refused creation or an unknown outcome is reported to the session through `onHalt`. */
  async function writeChunk(
    tempPath: ResourcePath,
    offset: bigint,
    slice: Uint8Array,
    create: "exclusive" | "existing",
    signal: AbortSignal,
    onHalt: (code: ErrorCode) => void,
  ): Promise<number> {
    try {
      const out = narrow(
        await execute(
          (channel) => ({
            channelId: channel,
            op: "write",
            path: toWirePath(tempPath),
            offset: offset.toString(),
            data: Buffer.from(slice).toString("base64"),
            create,
          }),
          true,
          signal,
        ),
        "write",
      );
      return out.written;
    } catch (error) {
      if (isUnknown(error)) onHalt("outcome_unknown");
      if (error instanceof SftpRefusal && error.code === "exists" && create === "exclusive") onHalt("already_exists");
      throw error;
    }
  }

  /**
   * A session whose temp file is the caller's name in the target's directory. The name is checked as a core segment
   * and must differ from the target's own name; the creation is exclusive, so a name already taken is exists and the
   * file there is never overwritten.
   */
  async function openWriteSession(target: ResourcePath, tempName: NameSegment): Promise<SftpWriteSession> {
    const last = target.segments.at(-1);
    if (last === undefined) throw commanderError("invalid_path");
    const parsed = NameSegment.safeParse(tempName);
    if (!parsed.success || JSON.stringify(parsed.data) === JSON.stringify(last)) throw commanderError("invalid_name");
    const parent = target.segments.slice(0, -1);
    const tempPath: ResourcePath = { segments: [...parent, parsed.data] };

    // created: a creating write has been answered, so the temp is known to exist and is ours to remove.
    // halt: the session may no longer touch the temp (a refused creation, or an unknown outcome).
    let created = false;
    let halt: ErrorCode | null = null;
    let finished = false;
    const setHalt = (code: ErrorCode) => {
      halt = code;
    };
    const checkOpen = () => {
      if (halt !== null) throw commanderError(halt);
      if (finished) throw commanderError("internal");
    };

    return {
      tempPath,

      async write(offset: bigint, bytes: Uint8Array, signal: AbortSignal): Promise<void> {
        return guard(async () => {
          checkOpen();
          if (bytes.length === 0) return;
          if (!created && offset !== 0n) throw new CommanderError("internal", "A write session starts at offset 0");
          for (let done = 0; done < bytes.length; done += READ_CHUNK_MAX) {
            const slice = bytes.subarray(done, done + READ_CHUNK_MAX);
            const create = created ? "existing" : "exclusive";
            const written = await writeChunk(tempPath, offset + BigInt(done), slice, create, signal, setHalt);
            if (written !== slice.length) {
              setHalt("outcome_unknown");
              throw commanderError("outcome_unknown");
            }
            created = true;
          }
        });
      },

      async commit(opts, signal: AbortSignal): Promise<Fingerprint> {
        return guard(async () => {
          checkOpen();
          if (!created) {
            // An empty file: the contract allows an empty first chunk. Its reply must say 0 bytes written.
            const written = await writeChunk(tempPath, 0n, new Uint8Array(0), "exclusive", signal, setHalt);
            if (written !== 0) {
              setHalt("outcome_unknown");
              throw commanderError("outcome_unknown");
            }
            created = true;
          }
          const target: ResourcePath = { segments: [...parent, last] };
          const expectTarget = opts.replace && opts.expectTarget !== null ? opts.expectTarget : undefined;
          try {
            await renameOp(tempPath, target, { replace: opts.replace, expectTarget }, signal);
          } catch (error) {
            if (isUnknown(error)) setHalt("outcome_unknown");
            throw error;
          }
          finished = true;
          try {
            const landed = await statEntry(target, signal);
            if (landed === null) throw commanderError("outcome_unknown");
            return fingerprintOf(landed);
          } catch {
            // The rename has landed; whatever the final stat says, the outcome seen here is unknown.
            throw commanderError("outcome_unknown");
          }
        });
      },

      async abort(): Promise<void> {
        return guard(async () => {
          // Only a temp this session created, and whose state is known, may be removed.
          if (halt !== null || finished || !created) return;
          try {
            await removeOp(tempPath, "file", new AbortController().signal);
          } catch (error) {
            if (error instanceof SftpRefusal && error.code === "no_such_file") {
              created = false;
              return;
            }
            if (isUnknown(error)) setHalt("outcome_unknown");
            throw error;
          }
          created = false;
        });
      },
    };
  }

  return {
    endpoint,
    capabilities,

    async list(path, opts, signal) {
      return guard(async () => {
        const out = narrow(
          await execute(
            (channel) => ({
              channelId: channel,
              op: "list",
              path: toWirePath(path),
              ...(opts.cursor !== null ? { cursor: opts.cursor } : {}),
              limit: Math.min(opts.limit, LIST_PAGE_MAX),
            }),
            false,
            signal,
          ),
          "list",
        );
        const entries: Entry[] = [];
        for (const item of out.entries) {
          const name = trustedName(item.name);
          if (name !== null) entries.push(toEntry(name, item.attrs));
        }
        return { entries, cursor: out.nextCursor };
      });
    },

    async stat(path, signal) {
      return guard(() => statEntry(path, signal));
    },

    async read(path, offset, length, expect, signal) {
      return guard(async () => {
        if (expect !== null) {
          const current = await statEntry(path, signal);
          if (current === null || !sameFingerprint(fingerprintOf(current), expect)) {
            throw commanderError("changed_since_plan");
          }
        }
        const parts: Uint8Array[] = [];
        let total = 0;
        let position = offset;
        while (total < length) {
          const want = Math.min(length - total, READ_CHUNK_MAX);
          const readAt = position;
          const out = narrow(
            await execute(
              (channel) => ({ channelId: channel, op: "read", path: toWirePath(path), offset: readAt.toString(), length: want }),
              false,
              signal,
            ),
            "read",
          );
          const chunk = new Uint8Array(Buffer.from(out.data, "base64"));
          if (chunk.length > want) throw commanderError("internal");
          if (chunk.length === 0 && !out.eof) throw commanderError("internal");
          parts.push(chunk);
          total += chunk.length;
          position += BigInt(chunk.length);
          if (out.eof || chunk.length === 0) break;
        }
        return concat(parts);
      });
    },

    openWrite(target, opts, _signal) {
      return guard(() => openWriteSession(target, opts.tempName));
    },

    async mkdir(path, signal) {
      await guard(async () => {
        narrow(await execute((channel) => ({ channelId: channel, op: "mkdir", path: toWirePath(path) }), true, signal), "mkdir");
      });
    },

    async rename(from, to, opts, signal) {
      await guard(() => renameOp(from, to, opts, signal));
    },

    /**
     * Removes a file, or an empty directory. With `expect`, the entry is read first and a mismatch sends no remove.
     * Race window: the read and the remove are two calls; an entry changed between them is removed. Document, do not hide.
     */
    async remove(path, opts, signal) {
      await guard(async () => {
        if (opts.expect !== undefined) {
          const current = await statEntry(path, signal);
          if (current === null || !sameFingerprint(fingerprintOf(current), opts.expect)) {
            throw commanderError("changed_since_plan");
          }
        }
        await removeOp(path, opts.kind === "dir" ? "dir" : "file", signal);
      });
    },

    async close() {
      await guard(async () => {
        if (opening !== null) await opening.catch(() => undefined);
        const open = channelId;
        if (open === null) return;
        dropChannel(open);
        await callPort("hub_sftp_close", { channelId: open }, new AbortController().signal);
      });
    },
  };
}
