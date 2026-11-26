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

/** Review records in the plugin's key-value storage, one per registry server name. */
export class KvReviewStore implements ReviewStore {
  constructor(private readonly kv: Kv) {}

  async list(): Promise<ReviewRecord[]> {
    const records: ReviewRecord[] = [];
    for (const key of await this.kv.list(PREFIX)) {
      const parsed = Record_.safeParse(await this.kv.get(key));
      if (parsed.success) records.push(parsed.data);
    }
    return records;
  }

  async put(record: ReviewRecord): Promise<void> {
    await this.kv.set(`${PREFIX}${record.name}`, Record_.parse(record));
  }
}
