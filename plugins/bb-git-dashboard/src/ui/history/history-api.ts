import type { CommitDetails, HistoryPage } from "../../core/history/model.ts";

/** What the History tab asks of the host; the entry point implements it over RPC. */
export type HistoryApi = {
  page(copyId: string, offset: number): Promise<HistoryPage>;
  revision(copyId: string): Promise<string>;
  commit(copyId: string, hash: string): Promise<CommitDetails>;
  /** `hash` null reads the working tree's change against HEAD. */
  patch(copyId: string, hash: string | null, path: string): Promise<{text: string; truncated: boolean}>;
};
export const message = (error: unknown) => error instanceof Error ? error.message : "Request failed.";
