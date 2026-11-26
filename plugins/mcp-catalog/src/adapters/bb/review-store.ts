import { z } from "zod";
import type { ReviewRecord } from "../../core/review";
import type { ReviewStore } from "../../core/service";

const PREFIX = "review:";

const Record_ = z.object({
  name: z.string(),
  version: z.string(),
  threadId: z.string(),
  worktree: z.string().optional(),
  branch: z.string().optional(),
  acceptCommit: z.string().optional(),
  acceptedAt: z.number().optional(),
  lastRecheck: z.object({ state: z.enum(["failed", "rejected"]), error: z.string().optional(), threadId: z.string(), at: z.number() }).optional(),
  previousAccept: z.object({ acceptCommit: z.string(), acceptedAt: z.number().optional() }).optional(),
  state: z.enum(["reviewing", "ready", "failed", "accepted", "rejected"]),
  startedAt: z.number().optional(),
  error: z.string().optional(),
});

/** The subset of `bb.storage.kv` the store needs. */
export interface Kv {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  list(prefix?: string): Promise<string[]>;
}

/**
 * Review records in the plugin's key-value storage, one per registry server name and version
 * (`review:<name>@<version>`). Records an earlier build stored under the bare name (`review:<name>`) are
 * still read; when both exist for the same name and version the new key wins.
 */
export class KvReviewStore implements ReviewStore {
  constructor(private readonly kv: Kv) {}

  async list(): Promise<ReviewRecord[]> {
    const byIdentity = new Map<string, { record: ReviewRecord; legacy: boolean }>();
    for (const key of await this.kv.list(PREFIX)) {
      const parsed = Record_.safeParse(await this.kv.get(key));
      if (!parsed.success) continue;
      const record = parsed.data;
      const legacy = key === `${PREFIX}${record.name}`;
      const identity = JSON.stringify([record.name, record.version]);
      const known = byIdentity.get(identity);
      if (known === undefined || (known.legacy && !legacy)) byIdentity.set(identity, { record, legacy });
    }
    return [...byIdentity.values()].map((item) => item.record);
  }

  async put(record: ReviewRecord): Promise<void> {
    await this.kv.set(`${PREFIX}${record.name}@${record.version}`, Record_.parse(record));
  }
}
