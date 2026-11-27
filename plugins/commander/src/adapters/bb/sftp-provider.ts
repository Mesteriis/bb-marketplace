// FileProvider for SFTP, reached through Remote Hub's plugin RPC (hub_sftp_*). Adapter: it knows the
// Remote Hub wire contract (src/core/wire/remote-hub-sftp.ts) and maps it onto the core's ports.
// Commander holds no secret here: keys, host keys and sign-in stay inside Remote Hub.
import { randomUUID } from "node:crypto";
import { ZodError } from "zod";
import { CommanderError, type ErrorCode } from "../../core/errors.ts";
import { Entry } from "../../core/model.ts";
import type { Capability, Endpoint, Fingerprint } from "../../core/model.ts";
import type { NameSegment, ResourcePath } from "../../core/path.ts";
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
  /** The temporary file beside the target; known from the start, stable until commit or abort. */
  readonly tempPath: ResourcePath;
}

export interface SftpProviderOptions {
  port: RemoteHubPort;
  profileId: string;
  endpoint: Endpoint;
}

const SLASH = 0x2f;
const DOT = 0x2e;
const IDEMPOTENT: ReadonlySet<SftpOp> = new Set<SftpOp>(["list", "stat", "realpath", "read"]);

/** Refusal code → core error code. Remote Hub's own text is never copied into the message. */
const ERROR_CODE: Record<SftpRefusalCode, ErrorCode> = {
  caller_not_plugin: "permission_denied",
  consent_required: "consent_required",
  consent_revoked: "consent_required",
  host_key_unknown: "host_key_rejected",
  host_key_changed: "host_key_rejected",
  permission_denied: "permission_denied",
  profile_not_found: "not_found",
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

/** Fixed, safe messages: no key path, no Keychain name, no text from the server. */
const MESSAGE: Partial<Record<ErrorCode, string>> = {
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
  changed_since_plan: "The target changed since the plan",
  outcome_unknown: "The outcome of the write is unknown",
  cancelled: "Cancelled",
  internal: "Remote Hub call failed",
};

function commanderError(code: ErrorCode): CommanderError {
  return new CommanderError(code, MESSAGE[code] ?? "Remote Hub call failed", code === "connection_failed");
}

/** Maps a refusal to the core error; core errors and schema errors pass through unchanged. */
async function guard<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof SftpRefusal) throw commanderError(ERROR_CODE[error.code]);
    if (error instanceof CommanderError || error instanceof ZodError) throw error;
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

function segmentBytes(name: NameSegment): Uint8Array {
  return "t" in name ? new TextEncoder().encode(name.t) : new Uint8Array(Buffer.from(name.b, "base64"));
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

function toWirePath(path: ResourcePath): SftpPath {
  if (path.segments.length === 0) return { text: "/" };
  const bytes = concat(path.segments.map((name) => concat([new Uint8Array([SLASH]), segmentBytes(name)])));
  if (bytes.length > SFTP_LIMITS.pathBytes) throw commanderError("invalid_path");
  return wireOf(bytes);
}

/** The root has no name of its own; a listing never returns it, so only stat of "/" reaches this. */
function nameOfPath(path: ResourcePath): NameSegment {
  const last = path.segments.at(-1);
  return last ?? { t: "/" };
}

function isHidden(name: NameSegment): boolean {
  return "t" in name ? name.t.startsWith(".") : Buffer.from(name.b, "base64")[0] === DOT;
}

function linkFromWire(target: SftpPath): { t: string } | { b: string } {
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
    linkTarget: attrs.linkTarget === null ? null : linkFromWire(attrs.linkTarget),
    hidden: isHidden(name),
  };
}

function fingerprintOf(entry: Entry): Fingerprint {
  return { size: entry.size, mtimeNs: entry.mtimeNs };
}

function sameFingerprint(a: Fingerprint, b: Fingerprint): boolean {
  return a.size === b.size && a.mtimeNs === b.mtimeNs;
}

/** The core's FileProvider, with openWrite giving the session that carries its tempPath. */
export type SftpProvider = Omit<FileProvider, "openWrite"> & {
  openWrite(target: ResourcePath, signal: AbortSignal): Promise<SftpWriteSession>;
  close(): Promise<void>;
};

export function createSftpProvider(options: SftpProviderOptions): SftpProvider {
  const { port, profileId, endpoint } = options;
  const capabilities = new Set<Capability>(["list", "stat", "read", "write", "mkdir", "rename", "remove", "seek"]);

  let channelId: string | null = null;
  let opening: Promise<string> | null = null;

  function callPort<M extends SftpMethodName>(method: M, input: SftpInput<M>, signal: AbortSignal): Promise<SftpOutput<M>> {
    return port.call(method, input, signal).then((raw) => sftpMethods[method].output.parse(raw) as SftpOutput<M>);
  }

  function openChannel(signal: AbortSignal): Promise<string> {
    if (channelId !== null) return Promise.resolve(channelId);
    if (opening === null) {
      opening = callPort("hub_sftp_open", { profileId }, signal).then(
        (opened) => {
          channelId = opened.channelId;
          opening = null;
          // atomicReplace belongs to a channel: it is declared again only after a replacing rename passes here.
          capabilities.delete("atomicReplace");
          return opened.channelId;
        },
        (error: unknown) => {
          opening = null;
          throw error;
        },
      );
    }
    return opening;
  }

  /**
   * One operation on the open channel. A closed channel (helper restart, or consent revoked and the
   * channel dropped) is reopened once for idempotent operations; a mutating one is never repeated and
   * its outcome is reported as unknown.
   */
  async function execute(
    build: (channel: string) => SftpOpInput,
    idempotent: boolean,
    signal: AbortSignal,
  ): Promise<SftpOpOutput> {
    const first = await openChannel(signal);
    try {
      return await callPort("hub_sftp_op", build(first), signal);
    } catch (error) {
      if (!(error instanceof SftpRefusal && error.code === "channel_closed")) throw error;
      if (channelId === first) channelId = null;
      if (!idempotent) throw commanderError("outcome_unknown");
      const second = await openChannel(signal);
      return callPort("hub_sftp_op", build(second), signal);
    }
  }

  async function statEntry(path: ResourcePath, signal: AbortSignal): Promise<Entry | null> {
    try {
      const out = narrow(
        await execute((channel) => ({ channelId: channel, op: "stat", path: toWirePath(path), follow: false }), true, signal),
        "stat",
      );
      return toEntry(nameOfPath(path), out.attrs);
    } catch (error) {
      if (error instanceof SftpRefusal && error.code === "no_such_file") return null;
      throw error;
    }
  }

  async function removeOp(path: ResourcePath, kind: "file" | "dir", signal: AbortSignal): Promise<void> {
    narrow(
      await execute((channel) => ({ channelId: channel, op: "remove", path: toWirePath(path), kind }), false, signal),
      "remove",
    );
  }

  async function renameOp(from: ResourcePath, to: ResourcePath, replace: boolean, signal: AbortSignal): Promise<void> {
    await execute(
      (channel) => ({ channelId: channel, op: "rename", from: toWirePath(from), to: toWirePath(to), overwrite: replace }),
      false,
      signal,
    );
    if (replace) capabilities.add("atomicReplace");
  }

  async function openWriteSession(target: ResourcePath): Promise<SftpWriteSession> {
    const last = target.segments.at(-1);
    if (last === undefined) throw commanderError("invalid_path");
    const parent = target.segments.slice(0, -1);
    const tempName = segmentFromBytes(
      concat([new Uint8Array([DOT]), segmentBytes(last), new TextEncoder().encode(`.commander-${randomUUID()}.part`)]),
    );
    const tempPath: ResourcePath = { segments: [...parent, tempName] };

    let wroteAny = false;
    let finished = false;

    return {
      tempPath,

      async write(offset: bigint, bytes: Uint8Array, signal: AbortSignal): Promise<void> {
        return guard(async () => {
          if (finished) throw commanderError("internal");
          if (bytes.length === 0) return;
          if (!wroteAny && offset !== 0n) throw new CommanderError("internal", "A write session starts at offset 0");
          for (let done = 0; done < bytes.length; done += READ_CHUNK_MAX) {
            const slice = bytes.subarray(done, done + READ_CHUNK_MAX);
            const at = offset + BigInt(done);
            const create = wroteAny ? "existing" : "exclusive";
            wroteAny = true;
            const out = narrow(
              await execute(
                (channel) => ({
                  channelId: channel,
                  op: "write",
                  path: toWirePath(tempPath),
                  offset: at.toString(),
                  data: Buffer.from(slice).toString("base64"),
                  create,
                }),
                false,
                signal,
              ),
              "write",
            );
            if (out.written !== slice.length) throw commanderError("internal");
          }
        });
      },

      async commit(opts, signal: AbortSignal): Promise<Fingerprint> {
        return guard(async () => {
          if (finished) throw commanderError("internal");
          if (!wroteAny) {
            // An empty file: the contract allows an empty first chunk.
            narrow(
              await execute(
                (channel) => ({
                  channelId: channel,
                  op: "write",
                  path: toWirePath(tempPath),
                  offset: "0",
                  data: "",
                  create: "exclusive",
                }),
                false,
                signal,
              ),
              "write",
            );
            wroteAny = true;
          }
          const target = { segments: [...parent, last] };
          if (opts.replace && opts.expectTarget !== null) {
            const current = await statEntry(target, signal);
            if (current === null || !sameFingerprint(fingerprintOf(current), opts.expectTarget)) {
              throw commanderError("changed_since_plan");
            }
          }
          await renameOp(tempPath, target, opts.replace, signal);
          finished = true;
          const landed = await statEntry(target, signal);
          if (landed === null) throw commanderError("internal");
          return fingerprintOf(landed);
        });
      },

      async abort(): Promise<void> {
        return guard(async () => {
          if (finished) return;
          try {
            await removeOp(tempPath, "file", new AbortController().signal);
          } catch (error) {
            if (error instanceof SftpRefusal && error.code === "no_such_file") return;
            throw error;
          }
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
            true,
            signal,
          ),
          "list",
        );
        return {
          entries: out.entries.map((item) => toEntry(segmentFromWire(item.name), item.attrs)),
          cursor: out.nextCursor,
        };
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
              true,
              signal,
            ),
            "read",
          );
          const chunk = new Uint8Array(Buffer.from(out.data, "base64"));
          parts.push(chunk);
          total += chunk.length;
          position += BigInt(chunk.length);
          if (out.eof || chunk.length === 0) break;
        }
        return concat(parts);
      });
    },

    openWrite(target, _signal) {
      return guard(() => openWriteSession(target));
    },

    async mkdir(path, signal) {
      await guard(async () => {
        narrow(await execute((channel) => ({ channelId: channel, op: "mkdir", path: toWirePath(path) }), false, signal), "mkdir");
      });
    },

    async rename(from, to, opts, signal) {
      await guard(() => renameOp(from, to, opts.replace, signal));
    },

    async remove(path, opts, signal) {
      await guard(() => removeOp(path, opts.kind === "dir" ? "dir" : "file", signal));
    },

    async close() {
      await guard(async () => {
        if (opening !== null) await opening.catch(() => undefined);
        const open = channelId;
        if (open === null) return;
        channelId = null;
        await callPort("hub_sftp_close", { channelId: open }, new AbortController().signal);
      });
    },
  };
}
