import type { OverviewData } from "../overview/overview-api.ts";

/** One copy's answer to a fetch or pull of the selection: `code` names why it did not go through; `behind` is how far it still is behind. */
export type BulkAnswer = {root: string; ok: boolean; code: string | null; behind?: number | null};
/** What the Projects page reads and does: the overview's read of the copies, fetch or pull of chosen copies, where a row leads. */
export type ProjectsApi = {
  load(refresh: boolean): Promise<OverviewData>;
  /** Fetches or pulls copies of one machine, one after another (at most 50). */
  bulk(hostId: string, roots: string[], action: "fetch" | "pull"): Promise<BulkAnswer[]>;
  openCopy(copyId: string): void;
  openPr(target: {accountId: string; repo: string; number: number}): void;
};
