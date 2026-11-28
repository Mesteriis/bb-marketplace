import { open } from "node:fs/promises";
import { CommanderError } from "../../core/errors.ts";
import { checkEntryName } from "../../core/archive-guard.ts";
import type { Fingerprint } from "../../core/model.ts";
import type { NameSegment, ResourcePath } from "../../core/path.ts";
import type { FileProvider } from "../../core/provider.ts";
import type { ArchiveRpc } from "./archive-provider.ts";

/**
 * Creating archives (S14 spec §6). The helper writes into a private staging file; the finished file is then
 * published through the target's WriteSession (temp name, commit with expectTarget), so a half-written archive
 * never appears under its final name, locally or over SFTP.
 */

export interface PackEntry {
  /** Name inside the archive, "/"-separated; checked like an extracted name. */
  name: string;
  kind: "file" | "dir";
  size: bigint;
  mtime: number | null;
  mode: number | null;
  /** Reads the source with the plan's fingerprint as expectation: a changed file fails changed_since_plan. */
  read(offset: bigint, length: number, signal: AbortSignal): Promise<Uint8Array>;
}

export interface PackOptions {
  format: "zip" | "tar";
  /** Absolute path of the staging file the helper creates (exclusively, mode 0600). */
  stagingPath: string;
  entries: PackEntry[];
  encryption?: "none" | "aes256";
  password?: () => Promise<Uint8Array | null>;
  limits?: { maxTotalBytes: number; maxEntries: number; maxRatio: number };
  signal: AbortSignal;
}

const CHUNK = 4 * 1024 * 1024;
const b64 = (s: string) => Buffer.from(s).toString("base64");

export async function packToStaging(rpc: ArchiveRpc, opts: PackOptions): Promise<{ size: bigint; sha256: string }> {
  const { signal } = opts;
  const names = new Set<string>();
  for (const entry of opts.entries) {
    if (checkEntryName(entry.name) === "refused") throw new CommanderError("invalid_path", "An entry name is not allowed in an archive");
    const key = entry.name.replace(/\/$/, "");
    if (names.has(key)) throw new CommanderError("invalid_archive", "An entry name is repeated", false, "duplicate_name");
    names.add(key);
  }
  await rpc.request({
    t: "pack_open", format: opts.format, staging: b64(opts.stagingPath),
    ...(opts.encryption === "aes256" ? { zip: { encryption: "aes256" } } : {}),
    ...(opts.limits ? { limits: opts.limits } : {}),
  }, { signal, ...(opts.password ? { password: opts.password } : {}) });
  try {
    for (const entry of opts.entries) {
      signal.throwIfAborted();
      await rpc.request({
        t: "pack_add", nameB64: b64(entry.name), kind: entry.kind, size: entry.kind === "file" ? entry.size.toString() : "0",
        ...(entry.mtime === null ? {} : { mtime: entry.mtime }), ...(entry.mode === null ? {} : { mode: entry.mode }),
      }, { signal });
      if (entry.kind === "file") {
        for (let offset = 0n; offset < entry.size;) {
          const length = Number(entry.size - offset < BigInt(CHUNK) ? entry.size - offset : BigInt(CHUNK));
          const bytes = await entry.read(offset, length, signal);
          if (bytes.length === 0) throw new CommanderError("changed_since_plan", "A source file ended early");
          await rpc.request({ t: "pack_data" }, { signal, data: bytes });
          offset += BigInt(bytes.length);
        }
      }
      await rpc.request({ t: "pack_end_entry" }, { signal });
    }
    const { json } = await rpc.request({ t: "pack_finish" }, { signal });
    return { size: BigInt(json.size as string), sha256: json.sha256 as string };
  } catch (error) {
    await rpc.request({ t: "pack_abort" }).catch(() => undefined);
    throw error;
  }
}

/** Writes a finished local file to the target through a WriteSession: temp name, then one guarded commit. */
export async function publishStaging(opts: {
  stagingPath: string;
  provider: FileProvider;
  target: ResourcePath;
  tempName: NameSegment;
  replace: boolean;
  expectTarget: Fingerprint | null;
  signal: AbortSignal;
}): Promise<Fingerprint> {
  const { signal } = opts;
  const session = await opts.provider.openWrite(opts.target, { tempName: opts.tempName }, signal);
  const file = await open(opts.stagingPath, "r");
  try {
    const { size } = await file.stat({ bigint: true });
    const buffer = Buffer.allocUnsafe(CHUNK);
    for (let offset = 0n; offset < size;) {
      signal.throwIfAborted();
      const { bytesRead } = await file.read(buffer, 0, CHUNK, offset);
      if (bytesRead === 0) throw new CommanderError("changed_since_plan", "The staging file ended early");
      await session.write(offset, Uint8Array.from(buffer.subarray(0, bytesRead)), signal);
      offset += BigInt(bytesRead);
    }
    return await session.commit({ replace: opts.replace, expectTarget: opts.expectTarget }, signal);
  } catch (error) {
    // An answer lost on commit leaves the temp for reconciliation; every other failure removes it.
    if (!(error instanceof CommanderError) || error.code !== "outcome_unknown") await session.abort().catch(() => undefined);
    throw error;
  } finally {
    await file.close();
  }
}
