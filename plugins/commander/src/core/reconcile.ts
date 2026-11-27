import { CommanderError } from "./errors.ts";
import type { Checkpoint } from "./job-store.ts";
import type { Entry, Fingerprint, OperationPlan, PlanItem, ResourceRef } from "./model.ts";
import { join, NameSegment, parent, samePath } from "./path.ts";
import { LIST_PAGE_MAX, type FileProvider } from "./provider.ts";
import { fromBig, toBig } from "./size.ts";

export interface Location {
  provider: FileProvider;
  path: ResourceRef["path"];
}

export function tempNameFor(jobId: string, itemIndex: number): NameSegment {
  return NameSegment.parse({ t: `.commander-${jobId}-${itemIndex}.part` });
}

type Observation = Entry & { sha256?: string };

export function fingerprint(entry: Observation | null): Fingerprint | null {
  if (!entry) return null;
  return entry.sha256 ? { size: entry.size, mtimeNs: entry.mtimeNs, sha256: entry.sha256 }
    : { size: entry.size, mtimeNs: entry.mtimeNs };
}

export function matches(actual: Fingerprint | null, expected: Fingerprint | null): boolean {
  return actual === null || expected === null ? actual === expected
    : actual.size === expected.size && actual.mtimeNs === expected.mtimeNs
      && (!expected.sha256 || actual.sha256 === expected.sha256);
}

// SHA-256, FIPS 180-4. Keep only one 64-byte block and its message schedule.
const rounds = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotate(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits));
}

export class TransferHash {
  private readonly state = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  private readonly block = new Uint8Array(64);
  private readonly view = new DataView(this.block.buffer);
  private readonly schedule = new Uint32Array(64);
  private length = 0n;
  private used = 0;

  update(bytes: Uint8Array): void {
    this.length += BigInt(bytes.length);
    for (let offset = 0; offset < bytes.length;) {
      const count = Math.min(64 - this.used, bytes.length - offset);
      this.block.set(bytes.subarray(offset, offset + count), this.used);
      this.used += count;
      offset += count;
      if (this.used === 64) {
        this.compress();
        this.used = 0;
      }
    }
  }

  finish(): string {
    this.block[this.used++] = 0x80;
    this.block.fill(0, this.used);
    if (this.used > 56) {
      this.compress();
      this.block.fill(0);
    }
    this.view.setBigUint64(56, this.length * 8n);
    this.compress();
    return Array.from(this.state, (word) => word.toString(16).padStart(8, "0")).join("");
  }

  private compress(): void {
    const w = this.schedule;
    for (let i = 0; i < 16; i++) w[i] = this.view.getUint32(i * 4);
    for (let i = 16; i < 64; i++) {
      const x = w[i - 15];
      const y = w[i - 2];
      w[i] = w[i - 16] + (rotate(x, 7) ^ rotate(x, 18) ^ (x >>> 3))
        + w[i - 7] + (rotate(y, 17) ^ rotate(y, 19) ^ (y >>> 10));
    }
    let [a, b, c, d, e, f, g, h] = this.state;
    for (let i = 0; i < 64; i++) {
      const t1 = h + (rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25))
        + ((e & f) ^ (~e & g)) + rounds[i] + w[i];
      const t2 = (rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22))
        + ((a & b) ^ (a & c) ^ (b & c));
      h = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) | 0;
    }
    const result = [a, b, c, d, e, f, g, h];
    for (let i = 0; i < 8; i++) this.state[i] += result[i];
  }
}


export type ProviderCall = <T>(call: () => Promise<T>) => Promise<T>;

export async function readChunks(
  location: Location, expected: Fingerprint, chunkBytes: number, signal: AbortSignal,
  call: ProviderCall, consume: (bytes: Uint8Array, offset: bigint) => Promise<void>,
): Promise<void> {
  const size = toBig(expected.size);
  const version = { size: expected.size, mtimeNs: expected.mtimeNs };
  for (let offset = 0n; offset < size;) {
    const length = Math.min(chunkBytes, Number(size - offset));
    const bytes = await call(() => location.provider.read(location.path, offset, length, version, signal));
    if (!bytes.length || bytes.length > length) {
      throw new CommanderError("changed_since_plan", "Unexpected source length");
    }
    await consume(bytes, offset);
    offset += BigInt(bytes.length);
  }
  // Providers with an integrity barrier (archives) confirm the whole entry before the caller commits.
  await call(() => location.provider.finishRead?.(location.path, version, signal) ?? Promise.resolve());
}

async function digest(location: Location, expected: Fingerprint, context: VerifyContext): Promise<string> {
  const { call, signal, chunkBytes } = context;
  const { provider, path } = location;
  if (provider.sha256) {
    signal.throwIfAborted();
    const hash = await provider.sha256(path, signal);
    if (!matches(fingerprint(await call(() => provider.stat(path, signal))), { size: expected.size, mtimeNs: expected.mtimeNs })) {
      throw new CommanderError("changed_since_plan", "File changed during checksum");
    }
    return hash;
  }
  const hash = new TransferHash();
  await readChunks(location, expected, chunkBytes, signal, call, async (bytes) => { hash.update(bytes); });
  const actual = await call(() => provider.stat(path, signal));
  if (!matches(actual, { size: expected.size, mtimeNs: expected.mtimeNs })) {
    throw new CommanderError("changed_since_plan", "File changed during checksum");
  }
  return hash.finish();
}

export interface VerifyContext {
  signal: AbortSignal;
  chunkBytes: number;
  call: ProviderCall;
}

export async function observe(location: Location, context: VerifyContext, withHash = false): Promise<Observation | null> {
  const { provider, path } = location;
  const entry = await context.call(() => provider.stat(path, context.signal));
  if (withHash && entry?.kind === "file") return { ...entry, sha256: await digest(location, entry, context) };
  return entry;
}

export function matchesTarget(entry: Observation | null, expected: Checkpoint["expectTarget"]): boolean {
  return expected === "absent" || expected === null ? entry === null : matches(entry, expected);
}

export async function verifyCopy(
  source: Location, target: Location, expected: Fingerprint, mode: OperationPlan["verify"],
  context: VerifyContext, sourceHash?: string, committed?: Fingerprint,
): Promise<NonNullable<Checkpoint["verified"]>> {
  const entry = await observe(target, context, Boolean(committed?.sha256));
  if (entry?.kind !== "file" || entry.size !== expected.size || (committed && !matches(entry, committed))) {
    throw new CommanderError("changed_since_plan", "Destination verification failed");
  }
  if (mode === "size") return { size: entry.size };
  const hash = sourceHash ?? await digest(source, expected, context);
  if (hash !== (entry.sha256 ?? await digest(target, entry, context))) {
    throw new CommanderError("changed_since_plan", "Destination checksum differs");
  }
  return { size: entry.size, sha256: hash };
}

export async function confirmVerified(
  target: Location, checkpoint: Checkpoint, kind: PlanItem["kind"], context: VerifyContext,
): Promise<boolean> {
  const proof = checkpoint.verified;
  if (!proof) return false;
  const entry = await observe(target, context, Boolean(proof.sha256 || checkpoint.committed?.sha256));
  return entry?.kind === kind && entry.size === proof.size && (!proof.sha256 || entry.sha256 === proof.sha256)
    && (!checkpoint.committed || matches(entry, checkpoint.committed));
}

export async function removeStagedTemp(
  temp: Location, context: VerifyContext, expected?: Fingerprint, requirePresent = false,
): Promise<void> {
  const staged = await observe(temp, context, Boolean(expected?.sha256)).catch(() => {
    throw new CommanderError("outcome_unknown", "Temporary file version could not be confirmed");
  });
  if (!staged && !requirePresent) return;
  if (staged?.kind !== "file" || (expected ? !matches(staged, expected) : staged.size !== "0")) {
    throw new CommanderError("outcome_unknown", "Temporary file does not match the recorded evidence");
  }
  try {
    await temp.provider.remove(temp.path, { kind: "file", expect: fingerprint(staged)! }, context.signal);
  } catch {
    throw new CommanderError("outcome_unknown", "Temporary file could not be removed");
  }
}

/**
 * Remove a temp that this queue created, trusting only recorded evidence: the
 * last fingerprint and write intent in the checkpoint, or a saved cleanup intent.
 * The intent is saved before the removal, so a repeated recovery may find the
 * temp already gone.
 */
async function recoverTemp(
  checkpoint: Checkpoint, temp: Location, context: VerifyContext, save: (checkpoint: Checkpoint) => Promise<void>,
): Promise<void> {
  const unknown = (message: string) => new CommanderError("outcome_unknown", message);
  const copying = checkpoint.phase === "copying";
  const recorded = checkpoint.tempFingerprint;
  if (copying && !recorded) throw unknown("Temporary file has no recorded version");
  const staged = await observe(temp, context).catch(() => {
    throw unknown("Temporary file version could not be confirmed");
  });
  let cleanup = checkpoint.cleanup;
  if (cleanup) {
    if (!samePath(cleanup.tempPath, temp.path, temp.provider.endpoint.caseSensitive)) {
      throw unknown("Cleanup intent names another path");
    }
    if (staged && (staged.kind !== "file" || !matches(staged, cleanup.tempFingerprint))) {
      throw unknown("Temporary file does not match the saved cleanup intent");
    }
  } else if (staged) {
    let ours = staged.kind === "file";
    if (ours && !copying) ours = staged.size === "0";
    if (ours && copying) {
      const size = toBig(staged.size);
      const upper = checkpoint.writing ? toBig(checkpoint.writing.offset) + BigInt(checkpoint.writing.length) : toBig(checkpoint.bytesDone);
      // Trust the stat lag window: a buffered handle may have grown the file after it was recorded.
      // Without a write intent the file must also not be older than the recorded version.
      ours = size >= toBig(recorded!.size) && size <= upper
        && (checkpoint.writing !== undefined || (staged.mtimeNs !== null && recorded!.mtimeNs !== null && BigInt(staged.mtimeNs) >= BigInt(recorded!.mtimeNs)));
    }
    if (!ours) throw unknown("Temporary file does not match the recorded evidence");
    cleanup = { tempPath: temp.path, tempFingerprint: fingerprint(staged)! };
    await save({ ...checkpoint, cleanup });
  } else if (copying && checkpoint.expectTarget === null) {
    // Same rule as for a checkpoint without a temp: no recorded target version, no proof.
    throw unknown("Recorded temporary file is missing without a recorded target version");
  }
  // A missing temp is not proof by itself either way: the caller still checks
  // that source and target match the recorded versions.
  if (staged) {
    try {
      await temp.provider.remove(temp.path, { kind: "file", expect: cleanup!.tempFingerprint }, context.signal);
    } catch {
      throw unknown("Temporary file could not be removed");
    }
  }
  await save({ ...checkpoint, phase: "prepared", tempFingerprint: undefined, writing: undefined, cleanup: undefined });
}


/** One entry named by two spellings that differ only in case on a case-insensitive endpoint. */
export function isCaseOnlyPair(source: Location, target: Location): boolean {
  const from = source.path.segments.at(-1);
  const to = target.path.segments.at(-1);
  return source.provider.endpoint.id === target.provider.endpoint.id
    && samePath(source.path, target.path, source.provider.endpoint.caseSensitive)
    && !samePath(source.path, target.path, true)
    // A change of Unicode form alone is an ordinary rename: the listing cannot tell the spellings apart.
    && from !== undefined && to !== undefined && nameKey(from) !== nameKey(to);
}

// Same spelling after NFC normalisation; case stays exact.
function nameKey(name: NameSegment): string {
  return "b" in name ? "b:" + name.b : "t:" + name.t.normalize("NFC");
}

/** Listing pages read when checking a spelling; a longer listing is treated as unreadable. */
const SPELLING_PAGE_BUDGET = 1000;

/**
 * stat sees one entry under both spellings, so only the directory listing shows
 * which spelling exists: "source" (not renamed yet), "target" (renamed) or null.
 */
export async function nameSpelling(
  source: Location, target: Location, context: VerifyContext,
): Promise<"source" | "target" | null> {
  const dir = parent(target.path);
  const from = source.path.segments.at(-1);
  const to = target.path.segments.at(-1);
  if (!dir || !from || !to) return null;
  const fromKey = nameKey(from);
  const toKey = nameKey(to);
  let sawSource = false;
  let sawTarget = false;
  const seenCursors = new Set<string>();
  let cursor: string | null = null;
  for (let pages = 1;; pages++) {
    context.signal.throwIfAborted();
    const page: Awaited<ReturnType<FileProvider["list"]>> = await context.call(
      () => target.provider.list(dir, { cursor, limit: LIST_PAGE_MAX }, context.signal));
    // A page without entries but with a cursor, a repeated cursor or an endless listing proves nothing.
    if (page.entries.length === 0 && page.cursor !== null) return null;
    for (const { name } of page.entries) {
      sawSource ||= nameKey(name) === fromKey;
      sawTarget ||= nameKey(name) === toKey;
    }
    if (page.cursor === null) break;
    if (pages >= SPELLING_PAGE_BUDGET || seenCursors.has(page.cursor)) return null;
    seenCursors.add(page.cursor);
    cursor = page.cursor;
  }
  return sawTarget && !sawSource ? "target" : sawSource && !sawTarget ? "source" : null;
}

async function reconcileCaseOnly(
  checkpoint: Checkpoint, source: Location, target: Location, expected: Fingerprint, item: PlanItem,
  context: VerifyContext, save: (checkpoint: Checkpoint) => Promise<void>,
): Promise<"pending" | "done"> {
  const unknown = () => new CommanderError("outcome_unknown", "Interrupted case-only rename could not be confirmed");
  const state = await nameSpelling(source, target, context);
  const entry = await observe(source, context, Boolean(expected.sha256));
  if (state === null || entry?.kind !== item.kind || !matches(entry, expected)) throw unknown();
  if (state === "source") {
    if (checkpoint.phase === "prepared" || checkpoint.phase === "copying") return "pending";
    throw unknown();
  }
  await save({
    ...checkpoint, phase: "verified", bytesDone: item.kind === "file" ? entry.size : "0", committed: fingerprint(entry)!,
    verified: entry.sha256 ? { size: entry.size, sha256: entry.sha256 } : { size: entry.size },
  });
  return "done";
}

/** The saved plan item may replace an existing target: only conflictPolicy survives a restart. */
function replacementProven(plan: OperationPlan, item: PlanItem, expectTarget: Fingerprint): boolean {
  if (plan.conflictPolicy === "overwrite") return true;
  if (plan.conflictPolicy !== "overwriteIfNewer") return false;
  const source = item.fingerprint?.mtimeNs;
  const target = expectTarget.mtimeNs;
  return source != null && target != null && BigInt(source) > BigInt(target);
}

/**
 * Recovery of an archive-source or pack item that saved commitIntent before session.commit.
 * Published: the temp is gone and the target's SHA-256 equals the intent. Not published: the temp still matches
 * the intent (fingerprint and SHA-256) and the target is as planned, so the temp is renamed into place.
 * Anything else is unknown. The earlier WriteSession is lost, so the republish uses provider.rename.
 */
async function reconcileCommitIntent(
  checkpoint: Checkpoint & { commitIntent: NonNullable<Checkpoint["commitIntent"]> },
  source: Location | null, target: Location, item: PlanItem, plan: OperationPlan,
  context: VerifyContext, save: (checkpoint: Checkpoint) => Promise<void>,
): Promise<"done"> {
  const unknown = (message = "Interrupted publication could not be confirmed") => new CommanderError("outcome_unknown", message);
  const { commitIntent: intent } = checkpoint;
  const { provider, path } = target;
  const sensitive = provider.endpoint.caseSensitive;
  const tempPath = checkpoint.tempPath;
  const dir = parent(path);
  if (!tempPath || !dir || !samePath(tempPath, join(dir, tempNameFor(checkpoint.jobId, checkpoint.itemIndex)), sensitive)
      || samePath(path, tempPath, sensitive)) throw unknown();
  const expectTarget = checkpoint.expectTarget ?? "absent";
  const expected = item.fingerprint;
  if (source) {
    const before = await observe(source, context);
    if (!expected || !before || !matches(before, expected)) throw unknown();
  }
  const staged = await observe({ provider, path: tempPath }, context, true);
  const published = await observe(target, context, true);
  const intended = (entry: Awaited<ReturnType<typeof observe>>) =>
    entry?.kind === "file" && entry.size === intent.size && entry.sha256 === intent.sha256;
  const finish = async (entry: NonNullable<Awaited<ReturnType<typeof observe>>>) => {
    await save({
      ...checkpoint, phase: "verified", bytesDone: entry.size, committed: fingerprint(entry)!, tempFingerprint: undefined,
      verified: { size: entry.size, sha256: intent.sha256 }, sourceHash: undefined,
    });
    return "done" as const;
  };
  if (staged === null && published && intended(published) && !matchesTarget(published, expectTarget)) return finish(published);
  if (!staged || staged.kind !== "file" || !intended(staged) || !matches(staged, intent.tempFingerprint)) throw unknown();
  if (!matchesTarget(published, expectTarget)) throw unknown();
  const replace = expectTarget !== "absent";
  if (replace && (!replacementProven(plan, item, expectTarget) || !provider.capabilities.has("atomicReplace"))) throw unknown();
  try {
    await provider.rename(tempPath, path, { replace, expectTarget }, context.signal);
  } catch {
    throw unknown();
  }
  const after = await observe(target, context, true);
  if (!after || !intended(after)) throw unknown();
  return finish(after);
}

type Recovery = "pending" | "done" | "deferred_directory" | { verified: NonNullable<Checkpoint["verified"]> };

export async function reconcileItem(
  checkpoint: Checkpoint, source: Location | null, target: Location | null, item: PlanItem,
  plan: OperationPlan, context: VerifyContext, save: (checkpoint: Checkpoint) => Promise<void>,
): Promise<Recovery> {
  const unknown = () => new CommanderError("outcome_unknown", "Interrupted mutation could not be confirmed");
  const expected = item.fingerprint;
  if (plan.kind === "rename" && source && target && expected && isCaseOnlyPair(source, target)) {
    return reconcileCaseOnly(checkpoint, source, target, expected, item, context, save);
  }
  if (checkpoint.phase === "prepared" || checkpoint.phase === "copying") {
    const expectTarget = checkpoint.expectTarget;
    const before = source && await observe(source, context, Boolean(expected?.sha256));
    const after = target && await observe(target, context,
      Boolean((expectTarget && expectTarget !== "absent" && expectTarget.sha256) || expected?.sha256));
    if (plan.kind === "mkdir" && after?.kind === "dir") return "done";
    if (plan.kind === "delete" && source && before === null) return "done";
    const wasRename = plan.kind === "rename" || (plan.kind === "move" && checkpoint.via === "rename"
      && source?.provider.endpoint.id === target?.provider.endpoint.id);
    if (wasRename && before === null && expected && after?.kind === item.kind && matches(after, expected)) {
      // A parent directory accepts a finished child only with recorded proof.
      await save({
        ...checkpoint, phase: "verified", bytesDone: item.kind === "file" ? after.size : "0", committed: fingerprint(after)!,
        verified: after.sha256 ? { size: after.size, sha256: after.sha256 } : { size: after.size },
      });
      return "done";
    }
    if (checkpoint.commitIntent && target) {
      return reconcileCommitIntent({ ...checkpoint, commitIntent: checkpoint.commitIntent }, source, target, item, plan, context, save);
    }
    const temp = checkpoint.tempPath;
    if (temp && target) {
      const { provider, path } = target;
      const dir = parent(path);
      const sensitive = provider.endpoint.caseSensitive;
      if (!dir || !samePath(temp, join(dir, tempNameFor(checkpoint.jobId, checkpoint.itemIndex)), sensitive)
          || samePath(path, temp, sensitive)
          || (source && provider.endpoint.id === source.provider.endpoint.id && samePath(source.path, temp, sensitive))) {
        throw unknown();
      }
      await recoverTemp(checkpoint, { provider, path: temp }, context, save);
    } else if (checkpoint.phase === "copying" && expectTarget === null) {
      // Without a temp or a recorded target version nothing proves the copy never committed.
      throw unknown();
    }
    if ((source && (!before || !matches(before, expected))) || !matchesTarget(after, expectTarget)) throw unknown();
    return "pending";
  }
  if (!target || !source || !expected) throw unknown();
  const observed = await observe(source, context, Boolean(expected.sha256));
  if (checkpoint.phase === "source_removed" || observed === null) {
    if ((plan.kind !== "move" && plan.kind !== "rename") || observed !== null) throw unknown();
    if (checkpoint.verified) {
      if (await confirmVerified(target, checkpoint, item.kind, context)) return "done";
      throw unknown();
    }
    if (checkpoint.phase === "committed" && checkpoint.committed?.size === checkpoint.bytesDone) {
      // A sha256 plan needs the source's hash as evidence; size and mtime alone prove nothing.
      const hash = expected.sha256 ?? checkpoint.sourceHash;
      const hashed = plan.verify === "sha256" || Boolean(hash);
      if (hashed && !hash) throw unknown();
      const destination = await observe(target, context, hashed || Boolean(checkpoint.committed.sha256));
      if (destination?.kind === item.kind && matches(destination, checkpoint.committed)
          && (!hashed || destination.sha256 === hash)) {
        await save({
          ...checkpoint, phase: "verified", sourceHash: undefined,
          verified: hashed ? { size: destination.size, sha256: hash } : { size: destination.size },
        });
        return "done";
      }
    }
    throw unknown();
  }
  if (checkpoint.phase === "verified" && plan.kind === "move" && item.kind === "dir") {
    // Moving children changes directory metadata. Finalization checks the
    // directory again and the provider removes it only if it is empty.
    if (checkpoint.verified && observed?.kind === "dir" && (await observe(target, context))?.kind === "dir") {
      return "deferred_directory";
    }
    throw unknown();
  }
  if (observed?.kind !== "file" || !matches(observed, expected) || checkpoint.bytesDone !== expected.size) throw unknown();
  // Both the hash in the plan and the hash taken during transfer identify the version that was copied.
  const hash = expected.sha256 ?? checkpoint.sourceHash;
  if (hash && (observed.sha256 ?? (await observe(source, context, true))?.sha256) !== hash) throw unknown();
  if (checkpoint.verified && !await confirmVerified(target, checkpoint, item.kind, context)) throw unknown();
  const verified = await verifyCopy(source, target, expected, plan.kind === "move" ? "sha256" : plan.verify, context,
    hash, checkpoint.committed);
  return plan.kind === "move" ? { verified } : "done";
}
