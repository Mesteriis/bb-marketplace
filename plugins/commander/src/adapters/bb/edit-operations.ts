import { createHash } from "node:crypto";
import type { z } from "zod";
import { checksum, scanFile } from "../../core/compare.ts";
import { EDIT_IDLE_MS, EDIT_SNAPSHOT_ENDPOINT, decideWriteBack, uploadExpired, type EditSession, type WriteBackRequest } from "../../core/edit-session.ts";
import { editTextValidator, readEditSource } from "../../core/edit-source.ts";
import { CommanderError } from "../../core/errors.ts";
import { assertWritable, segmentKey } from "../../core/guards.ts";
import type { JobStore } from "../../core/job-store.ts";
import { OperationPlan, planDigest, type Entry, type Fingerprint, type OperationJob, type ResourceRef } from "../../core/model.ts";
import { nextFreeName } from "../../core/naming.ts";
import { join, parent, samePath } from "../../core/path.ts";
import { buildPlan, type PlannerDeps } from "../../core/planner.ts";
import { entryName, readForView, replyFor } from "../../core/preview.ts";
import { LIST_PAGE_MAX, READ_CHUNK_MAX, type FileProvider } from "../../core/provider.ts";
import { fingerprint, matches, readChunks } from "../../core/reconcile.ts";
import { EDIT_OPENER, type editRpcSchemas } from "../../core/wire/edit.ts";
import { snapshotIds, snapshotRef, type EditHost } from "./edit-host-client.ts";
import type { EditStore } from "./edit-store.ts";

type Schemas = typeof editRpcSchemas;
type Input<K extends keyof Schemas> = z.infer<Schemas[K]["input"]>;
type Result<K extends keyof Schemas> = z.infer<Schemas[K]["output"]>;
const running = new Set(["pending", "running", "awaiting_decision", "cancel_requested", "interrupted", "unknown"]);
type Held = { sessionId: string; revision?: number; upload?: number; snapshots: string[] };

export function createEditOperations(deps: {
  host: EditHost;
  store: EditStore;
  jobs: JobStore;
  planner: PlannerDeps;
  prepare(ids: string[], signal: AbortSignal): Promise<void>;
  submit(plan: OperationPlan, request: WriteBackRequest): Promise<OperationJob>;
  failure(): void;
}) {
  const { host, store, jobs, planner } = deps;
  let tail = Promise.resolve();
  const stopping = new AbortController();
  const knownHosts = new Set<string>();

  function serialize<T>(signal: AbortSignal, run: (signal: AbortSignal) => Promise<T>) {
    const lifetime = AbortSignal.any([signal, stopping.signal]);
    const task = tail.then(() => {
      lifetime.throwIfAborted();
      return run(lifetime);
    });
    tail = task.then(() => {}, () => {});
    return task;
  }

  const expired = (session: EditSession) => planner.now().getTime() - Date.parse(session.lastSavedAt ?? session.createdAt) >= EDIT_IDLE_MS;

  async function activeSession(sessionId: string) {
    const session = store.get(sessionId);
    if (!session || expired(session)) throw new CommanderError("not_found", "Сеанс завершён — откройте файл снова");
    return refreshBase(session);
  }

  async function refreshBase(session: EditSession) {
    const pendingJob = session.state.pendingJob;
    if (!pendingJob) return session;
    const job = await jobs.get(pendingJob);
    if (job && running.has(job.state)) return session;
    if (job?.state === "completed" && job.items[0]?.outcome === "done") {
      const destination = job.plan.items[0]?.target;
      const writesOriginal = destination?.endpoint === session.ref.endpoint && samePath(destination.path, session.ref.path, true);
      const checkpoint = writesOriginal ? await jobs.lastCheckpoint(job.id, 0) : null;
      if (checkpoint?.committed) {
        const { size, mtimeNs } = checkpoint.committed;
        const sha256 = session.base.sha256 ? checkpoint.verified?.sha256 : undefined;
        session.base = { size, mtimeNs, ...(sha256 ? { sha256 } : {}) };
      }
    }
    delete session.state.pendingJob;
    store.save(session);
    return session;
  }

  async function discardExpiredUpload(session: EditSession, signal: AbortSignal, requestedBase?: number) {
    const upload = session.state.upload;
    if (!upload || !uploadExpired(session.state, planner.now().getTime())
        && (requestedBase === undefined || requestedBase === upload.baseRevision)) return;
    await host.call("editDelete", { sessionId: session.sessionId, source: { upload: upload.baseRevision } }, session.hostId, signal);
    session.state.upload = null;
    store.save(session);
  }

  async function route(session: EditSession, signal: AbortSignal): Promise<Result<"edit_route">> {
    const { sessionId, ref, hostId, state } = session;
    const filename = entryName(ref.path);
    const name = filename && Buffer.byteLength(filename) <= 255 ? filename : "Копия.txt";
    const { path } = await host.call("editRoute", { sessionId, revision: state.revision, name }, hostId, signal);
    return { id: EDIT_OPENER, hostId, path };
  }

  async function present(session: EditSession, signal: AbortSignal): Promise<Result<"edit_open">> {
    return { sessionId: session.sessionId, base: session.base, opener: await route(session, signal) };
  }

  async function assignConflict(session: EditSession, current: Awaited<ReturnType<typeof currentTarget>>, signal: AbortSignal) {
    const { sessionId, hostId, state } = session;
    const existing = state.conflict?.revision === state.revision ? state.conflict : null;
    const snapshotId = existing?.snapshotId ?? planner.uuid();
    const proof = existing?.proof ?? await host.call("editSnapshot", { sessionId, revision: state.revision, snapshotId }, hostId, signal);
    const id = planner.uuid();
    session.state.conflict = { id, snapshotId, proof, revision: state.revision, current: current?.fingerprint ?? null, targetKind: current?.kind ?? null };
    store.save(session);
    return {
      kind: "conflict", conflictId: id, revision: state.revision,
      reason: current === null ? "deleted" : "changed", current: current?.fingerprint ?? null,
    } as const;
  }

  async function existingSession(ref: ResourceRef, provider: FileProvider, signal: AbortSignal) {
    const { provider: kind, caseSensitive, hostId } = provider.endpoint;
    if (kind !== "local") return store.forRef(ref, caseSensitive);
    const exact = store.forRef(ref, true);
    if (exact || !hostId) return exact;
    const aliases = store.foldedRefs(ref);
    if (aliases.length === 0) return null;
    const sourceIdentity = (candidate: ResourceRef) => host.call("editSourceIdentity", { path: candidate.path }, hostId, signal);
    const identity = await sourceIdentity(ref);
    if (identity === null || identity.ino === "0") return null;
    for (const candidate of aliases) {
      const other = await sourceIdentity(candidate.ref);
      if (other?.dev === identity.dev && other.ino === identity.ino) return candidate;
    }
    return null;
  }

  async function verifiedPrefix(
    provider: FileProvider, ref: ResourceRef, expect: Fingerprint, signal: AbortSignal,
  ) {
    const budget = 256 * 1024;
    const prefix = Buffer.alloc(Math.min(Number(expect.size), budget));
    const digest = createHash("sha256");
    await readChunks({ provider, path: ref.path }, expect, READ_CHUNK_MAX, signal, (read) => read(), async (chunk, offset) => {
      digest.update(chunk);
      if (offset < BigInt(prefix.length)) prefix.set(chunk.subarray(0, prefix.length - Number(offset)), Number(offset));
    });
    const after = await provider.stat(ref.path, signal);
    if (after?.kind !== "file" || !matches(after, expect)) {
      throw new CommanderError("changed_since_plan", "Файл изменился во время сравнения");
    }
    return { prefix, sha256: digest.digest("hex"), truncated: Number(expect.size) > budget };
  }

  async function currentTarget(session: EditSession, signal: AbortSignal) {
    const { endpoint, path } = session.ref;
    await deps.prepare([endpoint], signal);
    const provider = planner.provider(endpoint);
    assertWritable(provider.endpoint);
    const entry = await provider.stat(path, signal);
    if (!entry) return null;
    const actual = fingerprint(entry)!;
    if (entry.kind === "file" && provider.sha256) actual.sha256 = await checksum(provider, path, signal, { expected: entry });
    return { kind: entry.kind, fingerprint: actual };
  }

  async function beside(ref: ResourceRef, signal: AbortSignal) {
    const directory = parent(ref.path)!;
    const provider = planner.provider(ref.endpoint);
    const key = (name: ResourceRef["path"]["segments"][number]) => segmentKey(name, provider.endpoint.caseSensitive);
    const used = new Set<string>();
    for (let cursor: string | null = null;;) {
      const page = await provider.list(directory, { cursor, limit: LIST_PAGE_MAX }, signal);
      for (const entry of page.entries) used.add(key(entry.name));
      if (page.cursor === null) break;
      if (cursor === page.cursor || used.size > 200_000) throw new CommanderError("limit_exceeded", "Не удалось подобрать соседнее имя");
      cursor = page.cursor;
    }
    return { ...ref, path: join(directory, nextFreeName(ref.path.segments.at(-1)!, (value) => used.has(key(value)))) };
  }

  return {
    open({ ref, estimateId }: Input<"edit_open">, signal: AbortSignal,
      confirm: (estimateId: string, ref: ResourceRef, entry: Entry) => void,
    ): Promise<Result<"edit_open">> {
      return serialize(signal, async (signal) => {
        const hostId = await host.primaryHost();
        knownHosts.add(hostId);
        await deps.prepare([ref.endpoint], signal);
        const provider = planner.provider(ref.endpoint);
        assertWritable(provider.endpoint);
        const caseSensitive = provider.endpoint.provider === "local" || provider.endpoint.caseSensitive;
        const existing = await existingSession(ref, provider, signal);
        if (existing && !expired(existing)) return present(await refreshBase(existing), signal);
        if (existing) store.close(existing.sessionId);
        let expected;
        if (provider.endpoint.provider === "sftp") {
          if (!estimateId) throw new CommanderError("consent_required", "Подтвердите объём чтения файла с сервера");
          const entry = await scanFile({ provider, path: ref.path }, signal);
          confirm(estimateId, ref, entry);
          expected = fingerprint(entry)!;
        }
        const { base, chunks } = await readEditSource(provider, ref.path, signal, { expected });
        const sessionId = planner.uuid();
        await host.call("editCreate", { sessionId, size: Number(base.size) }, hostId, signal);
        let offset = 0;
        const hash = createHash("sha256");
        for (const bytes of chunks) {
          await host.call("editWriteChunk", { sessionId, baseRevision: 0, offset, bytes: Buffer.from(bytes).toString("base64") }, hostId, signal);
          offset += bytes.length;
          hash.update(bytes);
        }
        if (chunks.length > 0) {
          await host.call("editCommitRevision", { sessionId, baseRevision: 0, sha256: hash.digest("hex"), initial: true }, hostId, signal);
        }
        const session: EditSession = {
          sessionId, ref, hostId, base, state: { revision: 0, conflict: null, upload: null },
          createdAt: planner.now().toISOString(), lastSavedAt: null,
        };
        const result = await present(session, signal);
        store.open(session, caseSensitive);
        return result;
      });
    },

    route({ sessionId }: Input<"edit_route">, signal: AbortSignal): Promise<Result<"edit_route">> {
      return serialize(signal, async (signal) => route(await activeSession(sessionId), signal));
    },

    get({ sessionId }: Input<"edit_get">, signal: AbortSignal): Promise<Result<"edit_get">> {
      return serialize(signal, async (signal) => {
        const { ref, base, hostId, state } = await activeSession(sessionId);
        return { sessionId, ref, base, hostId, revision: state.revision };
      });
    },

    read({ sessionId, revision, offset, length }: Input<"edit_read">, signal: AbortSignal): Promise<Result<"edit_read">> {
      return serialize(signal, async (signal) => {
        const { hostId, state } = await activeSession(sessionId);
        if (revision !== state.revision) throw new CommanderError("changed_since_plan", "Редакция изменилась — перечитайте копию");
        return host.call("editReadChunk", { sessionId, source: { revision }, offset, length }, hostId, signal);
      });
    },

    save(input: Input<"edit_save">, signal: AbortSignal): Promise<Result<"edit_save">> {
      return serialize(signal, async (signal) => {
        const { sessionId, baseRevision, offset, bytes, final, sha256 } = input;
        const session = await activeSession(sessionId);
        const { state, hostId } = session;
        await discardExpiredUpload(session, signal, final ? baseRevision : undefined);
        if (state.revision !== baseRevision) throw new CommanderError("changed_since_plan", "Редакция изменилась — перечитайте копию");
        // The host can durably accept the bytes even if its response is lost.
        state.upload = { baseRevision, lastChunkAt: planner.now().toISOString() };
        store.save(session);
        await host.call("editWriteChunk", { sessionId, baseRevision, offset, bytes }, hostId, signal);
        if (final) {
          const { revision } = await host.call("editCommitRevision", { sessionId, baseRevision, sha256: sha256! }, hostId, signal);
          state.revision = revision;
          state.upload = null;
          session.lastSavedAt = planner.now().toISOString();
          store.save(session);
          await host.call("editDelete", { sessionId, source: { revision: baseRevision } }, hostId, signal).catch(deps.failure);
        }
        return { revision: state.revision };
      });
    },

    writeBack(input: Input<"edit_writeback">, signal: AbortSignal): Promise<Result<"edit_writeback">> {
      return serialize(signal, async (signal) => {
        const replay = store.replay(input);
        if (replay) return { kind: "written", jobId: replay };
        const session = await activeSession(input.sessionId);
        const { ref, hostId, sessionId, state } = session;
        await discardExpiredUpload(session, signal);
        if (state.upload) throw new CommanderError("changed_since_plan", "Дождитесь сохранения");
        if (state.pendingJob) throw new CommanderError("changed_since_plan", "Предыдущая запись ещё выполняется");
        const current = await currentTarget(session, signal);
        const decision = decideWriteBack(session.base, state, input, current);
        if (decision.kind === "conflict") return assignConflict(session, current, signal);
        const target = decision.kind === "beside" ? await beside(ref, signal) : ref;
        const targetDir = { endpoint: target.endpoint, path: parent(target.path)! };
        const snapshotId = input.choice ? state.conflict!.snapshotId : planner.uuid();
        const proof = input.choice
          ? state.conflict!.proof
          : await host.call("editSnapshot", { sessionId, revision: state.revision, snapshotId }, hostId, signal);
        const source = snapshotRef(hostId, sessionId, snapshotId);
        const original = await buildPlan({
          kind: "copy", sources: [source], targetDir, newName: null, initiator: { kind: "owner" },
          conflictPolicy: decision.expectTarget === "absent" ? "ask" : "overwrite", verify: "sha256",
        }, planner, signal);
        const { digest: _digest, ...plan } = original;
        plan.items = [{ ...plan.items[0]!, target, expectTarget: decision.expectTarget, fingerprint: proof }];
        const guarded = OperationPlan.parse({ ...plan, digest: await planDigest(plan) });
        signal.throwIfAborted();
        const job = await deps.submit(guarded, input);
        return { kind: "written", jobId: job.id };
      });
    },

    compare({ sessionId, conflictId }: Input<"edit_compare">, signal: AbortSignal): Promise<Result<"edit_compare">> {
      return serialize(signal, async (signal) => {
        const session = await activeSession(sessionId);
        const { ref, state } = session;
        const shown = state.conflict;
        const current = await currentTarget(session, signal);
        if (shown?.id !== conflictId || shown.revision !== state.revision
            || shown.targetKind !== (current?.kind ?? null)
            || !matches(current?.fingerprint ?? null, shown.current)) {
          return assignConflict(session, current, signal);
        }
        if (current === null) return { kind: "text", text: "Оригинал удалён" };
        const provider = planner.provider(ref.endpoint);
        const { size, mtimeNs, sha256 } = current.fingerprint;
        const expect = { size, mtimeNs };
        try {
          if (sha256) {
            const verified = await verifiedPrefix(provider, ref, expect, signal);
            if (verified.sha256 !== sha256) {
              return assignConflict(session, { kind: "file", fingerprint: { ...expect, sha256: verified.sha256 } }, signal);
            }
            const validate = editTextValidator();
            validate(verified.prefix);
            if (!verified.truncated) validate();
            const text = new TextDecoder("utf-8").decode(verified.prefix, { stream: verified.truncated });
            return { kind: "text", text: text + (verified.truncated ? "\n…" : "") };
          }
          const view = replyFor(await readForView(provider, ref.path, { offset: 0n, length: 256 * 1024, expect }, signal), "text", "owner");
          if (view.view.kind !== "text") throw new CommanderError("unsupported", "Текущая версия недоступна для текстового просмотра");
          return { kind: "text", text: view.view.text + (view.view.truncated ? "\n…" : "") };
        } catch (error) {
          if (error instanceof CommanderError && ["changed_since_plan", "not_found"].includes(error.code)) {
            return assignConflict(session, await currentTarget(session, signal), signal);
          }
          throw error;
        }
      });
    },

    dismiss({ sessionId, conflictId }: Input<"edit_dismiss">, signal: AbortSignal): Promise<Result<"edit_dismiss">> {
      return serialize(signal, async (signal) => {
        const session = await activeSession(sessionId);
        const conflict = session.state.conflict;
        if (conflict?.id === conflictId) {
          session.state.conflict = null;
          store.save(session);
          await host.call("editDelete", { sessionId, source: { snapshotId: conflict.snapshotId } }, session.hostId, signal)
            .catch(deps.failure);
        }
        return {};
      });
    },

    close({ sessionId }: Input<"edit_close">, signal: AbortSignal): Promise<Result<"edit_close">> {
      return serialize(signal, async (signal) => {
        const session = store.get(sessionId);
        if (session) {
          store.close(sessionId);
          await host.call("editDelete", { sessionId, source: { revision: session.state.revision } }, session.hostId, signal);
          if (session.state.upload) {
            await host.call("editDelete", { sessionId, source: { upload: session.state.upload.baseRevision } }, session.hostId, signal);
          }
        }
        return {};
      });
    },

    sweep(signal: AbortSignal) {
      return serialize(signal, async (signal) => {
        const held = new Map<string, Map<string, Held>>();
        function keep(hostId: string, sessionId: string): Held {
          let hostHeld = held.get(hostId);
          if (!hostHeld) held.set(hostId, hostHeld = new Map());
          let session = hostHeld.get(sessionId);
          if (!session) hostHeld.set(sessionId, session = { sessionId, snapshots: [] });
          return session;
        }
        const primary = await host.primaryHost().catch(() => undefined);
        if (primary) knownHosts.add(primary);
        for (const session of store.list()) {
          const { hostId, sessionId, state } = session;
          knownHosts.add(hostId);
          if (expired(session)) {
            store.close(sessionId);
            continue;
          }
          await refreshBase(session);
          const record = keep(hostId, sessionId);
          record.revision = state.revision;
          if (state.upload && !uploadExpired(state, planner.now().getTime())) record.upload = state.upload.baseRevision;
          if (state.conflict) record.snapshots.push(state.conflict.snapshotId);
        }
        for (const job of await jobs.list({ limit: Number.MAX_SAFE_INTEGER })) {
          for (const { source } of job.plan.items) {
            if (source?.endpoint !== EDIT_SNAPSHOT_ENDPOINT) continue;
            const { sessionId, snapshotId, hostId } = snapshotIds(source.path);
            knownHosts.add(hostId);
            if (running.has(job.state)) keep(hostId, sessionId).snapshots.push(snapshotId);
          }
        }
        await Promise.all([...knownHosts].map((hostId) => host.call("editSweep", {
          held: [...(held.get(hostId)?.values() ?? [])],
        }, hostId, signal).catch(deps.failure)));
      });
    },

    async shutdown() {
      stopping.abort(new CommanderError("cancelled", "Commander is stopping"));
      await tail;
    },
  };
}
export type EditOperations = ReturnType<typeof createEditOperations>;
