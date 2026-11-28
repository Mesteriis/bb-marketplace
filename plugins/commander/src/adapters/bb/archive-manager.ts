import { constants } from "node:fs";
import { lstat, open, realpath, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { CommanderError, isCommanderError } from "../../core/errors.ts";
import type { Endpoint, EndpointId, ResourceRef } from "../../core/model.ts";
import type { FileProvider } from "../../core/provider.ts";
import { EXTRACT_LIMITS, type ExtractLimits } from "../../core/archive-guard.ts";
import type { HelperResult, RequestOptions } from "./archive-helper.ts";
import type { ArchiveDirs } from "./archive-dirs.ts";
import { ArchiveProvider, type ArchiveRpc } from "./archive-provider.ts";
import type { ArchiveRegistry } from "./archive-registry.ts";

/**
 * Opens archives for the plugin (S14 spec §3, §7, §11). Every archive, local or remote, is first copied into a
 * private directory on the server's machine (the direct path for a same-machine file stays off until the primary
 * host is proven to be that machine). One helper process serves one open archive.
 */

export interface HelperLike {
  start(): Promise<{ rlimitAs: "enforced" | "not_enforced" | "failed" }>;
  request(body: Record<string, unknown> & { t: string }, options?: RequestOptions): Promise<HelperResult>;
  close(): Promise<void>;
}

export interface ArchiveManagerDeps {
  registry: ArchiveRegistry;
  dirs: ArchiveDirs;
  sourceProvider(endpoint: EndpointId): FileProvider;
  createHelper(): HelperLike;
  maxArchiveFileBytes?: number;
  limits?: () => ExtractLimits;
  freeBytes(dir: string): Promise<bigint>;
  /** The owner's password prompt for one archive; absent: no archive can ask. */
  askPassword?: (archiveId: string) => Promise<Uint8Array | null>;
  now?: () => Date;
  uuid?: () => string;
}

export interface OpenedArchive {
  archiveId: string;
  endpoint: EndpointId;
  entries: number;
  encrypted: boolean;
}

interface Session {
  id: string;
  source: ResourceRef;
  fingerprint: { size: string; mtimeNs: string | null };
  copyDir: string;
  openBody: Record<string, unknown> & { t: "open" };
  helper: HelperLike | null;
  restarts: number[];
  refused: boolean;
  provider: ArchiveProvider;
}

const CHUNK = 4 * 1024 * 1024;
const SPACE_RESERVE = 64n * 1024n * 1024n;
const RESTART_LIMIT = 3;
const RESTART_WINDOW_MS = 5 * 60_000;
const b64 = (s: string) => Buffer.from(s).toString("base64");
const CRASH_REASONS = new Set(["helper_crashed", "protocol_error"]);
const unavailable = () =>
  new CommanderError("unsupported", "Archive helper was restarted too often; open the archive again", false, "archives_unavailable");

export function createArchiveManager(deps: ArchiveManagerDeps) {
  const sessions = new Map<string, Session>();
  const now = deps.now ?? (() => new Date());
  const newId = deps.uuid ?? randomUUID;
  const limits = deps.limits ?? (() => EXTRACT_LIMITS);
  const maxFile = deps.maxArchiveFileBytes ?? 10 * 2 ** 30;

  async function copySource(ref: ResourceRef, id: string, signal: AbortSignal) {
    const provider = deps.sourceProvider(ref.endpoint);
    const entry = await provider.stat(ref.path, signal);
    if (!entry) throw new CommanderError("not_found", "The archive file does not exist");
    if (entry.kind !== "file") throw new CommanderError("invalid_path", "The archive must be a regular file");
    const size = BigInt(entry.size);
    if (size > BigInt(maxFile)) throw new CommanderError("limit_exceeded", "The archive file is larger than the limit", false, "total_bytes");
    const copyDir = await deps.dirs.newCopyDir(id);
    try {
      if ((await deps.freeBytes(copyDir)) < size + SPACE_RESERVE) throw new CommanderError("no_space", "Not enough disk space for the archive copy");
      const version = { size: entry.size, mtimeNs: entry.mtimeNs };
      const file = await open(join(copyDir, "archive.bin"), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try {
        for (let offset = 0n; offset < size;) {
          signal.throwIfAborted();
          const bytes = await provider.read(ref.path, offset, Number(size - offset < BigInt(CHUNK) ? size - offset : BigInt(CHUNK)), version, signal);
          if (bytes.length === 0) throw new CommanderError("changed_since_plan", "The archive file changed while it was copied");
          await file.write(bytes);
          offset += BigInt(bytes.length);
        }
      } finally {
        await file.close();
      }
      const after = await provider.stat(ref.path, signal);
      if (!after || after.size !== entry.size || after.mtimeNs !== entry.mtimeNs) {
        throw new CommanderError("changed_since_plan", "The archive file changed while it was copied");
      }
      return { copyDir, fingerprint: version };
    } catch (error) {
      await rm(copyDir, { recursive: true, force: true });
      throw error;
    }
  }

  async function openBodyFor(copyDir: string) {
    const root = await realpath(copyDir);
    const stat = await lstat(join(root, "archive.bin"), { bigint: true });
    return {
      t: "open" as const, rootB64: b64(root), segmentsB64: [b64("archive.bin")], format: "auto" as const,
      limits: { maxTotalBytes: limits().maxTotalBytes, maxEntries: limits().maxEntries, maxRatio: limits().maxRatio },
      expect: { size: String(stat.size), mtimeNs: String(stat.mtimeNs), dev: String(stat.dev), ino: String(stat.ino) },
    };
  }

  async function startHelper(session: Session, signal: AbortSignal): Promise<HelperResult> {
    const helper = deps.createHelper();
    try {
      await helper.start();
      const result = await helper.request(session.openBody, { signal });
      session.helper = helper;
      return result;
    } catch (error) {
      await helper.close().catch(() => undefined);
      throw error;
    }
  }

  function endpointOf(id: string, label: string): Endpoint {
    return {
      id: ("archive:" + id) as EndpointId, provider: "archive", label: label.slice(0, 200), machine: "server",
      hostId: null, readOnly: true, caseSensitive: true,
    };
  }

  function makeRpc(session: Session): ArchiveRpc {
    return {
      async request(body, options) {
        if (session.refused) throw unavailable();
        if (!session.helper) {
          const stamp = now().getTime();
          session.restarts = session.restarts.filter((t) => stamp - t < RESTART_WINDOW_MS);
          if (session.restarts.length >= RESTART_LIMIT) {
            session.refused = true;
            throw unavailable();
          }
          session.restarts.push(stamp);
          await startHelper(session, options?.signal ?? new AbortController().signal);
        }
        try {
          return await session.helper!.request(body, options);
        } catch (error) {
          if (isCommanderError(error) && error.reason !== undefined && CRASH_REASONS.has(error.reason)) {
            const dead = session.helper;
            session.helper = null;
            await dead?.close().catch(() => undefined);
          }
          throw error;
        }
      },
    };
  }

  async function verifySource(session: Session, signal: AbortSignal): Promise<void> {
    const entry = await deps.sourceProvider(session.source.endpoint).stat(session.source.path, signal);
    if (!entry || entry.kind !== "file" || entry.size !== session.fingerprint.size || entry.mtimeNs !== session.fingerprint.mtimeNs) {
      throw new CommanderError("changed_since_plan", "The archive file changed on disk");
    }
  }

  function build(id: string, source: ResourceRef, fingerprint: Session["fingerprint"], copyDir: string, openBody: Session["openBody"], owner: boolean) {
    const session = { id, source, fingerprint, copyDir, openBody, helper: null, restarts: [], refused: false } as unknown as Session;
    const name = source.path.segments.at(-1);
    const label = name && "t" in name ? name.t : "archive";
    session.provider = new ArchiveProvider({
      endpoint: endpointOf(id, label), rpc: makeRpc(session), verifySource: (signal) => verifySource(session, signal),
      ...(owner && deps.askPassword ? { password: () => deps.askPassword!(id) } : {}),
    });
    sessions.set(id, session);
    return session;
  }

  return {
    async open(ref: ResourceRef, signal: AbortSignal, opts: { owner?: boolean } = {}): Promise<OpenedArchive> {
      const id = newId();
      const { copyDir, fingerprint } = await copySource(ref, id, signal);
      let session: Session | null = null;
      try {
        const openBody = await openBodyFor(copyDir);
        session = build(id, ref, fingerprint, copyDir, openBody, opts.owner === true);
        const result = await startHelper(session, signal);
        deps.registry.register(ref, fingerprint, id);
        return {
          archiveId: id, endpoint: ("archive:" + id) as EndpointId,
          entries: Number(result.json.entries ?? 0), encrypted: result.json.encrypted === true,
        };
      } catch (error) {
        sessions.delete(id);
        await session?.helper?.close().catch(() => undefined);
        await rm(copyDir, { recursive: true, force: true });
        throw error;
      }
    },

    /** Opens an archive the registry knows (after a restart): copies it again and starts a helper. */
    async ensure(id: string, signal: AbortSignal, opts: { owner?: boolean } = {}): Promise<void> {
      if (sessions.has(id)) return;
      const known = deps.registry.get(id);
      if (!known) throw new CommanderError("not_found", "Archive is no longer available");
      const { copyDir } = await copySource(known.source, id, signal);
      let session: Session | null = null;
      try {
        const openBody = await openBodyFor(copyDir);
        session = build(id, known.source, known.fingerprint, copyDir, openBody, opts.owner === true);
        await startHelper(session, signal);
      } catch (error) {
        sessions.delete(id);
        await session?.helper?.close().catch(() => undefined);
        await rm(copyDir, { recursive: true, force: true });
        throw error;
      }
    },

    provider(id: string): FileProvider {
      const session = sessions.get(id);
      if (!session) throw new CommanderError("not_found", "Archive is not open");
      return session.provider;
    },

    has: (id: string) => sessions.has(id),

    async close(id: string): Promise<void> {
      const session = sessions.get(id);
      if (!session) return;
      sessions.delete(id);
      deps.registry.release(id);
      await session.helper?.close().catch(() => undefined);
      await rm(session.copyDir, { recursive: true, force: true });
    },

    async closeAll(): Promise<void> {
      await Promise.allSettled([...sessions.keys()].map((id) => this.close(id)));
    },
  };
}

export type ArchiveManager = ReturnType<typeof createArchiveManager>;
