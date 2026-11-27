import type { z } from "zod";
import type { catalogContract } from "../../core/catalog/contract.ts";
import type { ScaffoldRequest, ScaffoldsView } from "../../core/scaffolds/contract.ts";

type Ok<T extends {output: z.ZodType}> = Omit<Extract<z.infer<T["output"]>, {ok: true}>, "ok">;
export type CatalogView = Ok<typeof catalogContract.catalogView>;
export type BulkResult = Ok<typeof catalogContract.catalogBulk>["results"][number];
export type PullsResult = Ok<typeof catalogContract.catalogPulls>["results"][number];
export type RemoteRow = CatalogView["remote"][number];
export type LocalRow = CatalogView["local"][number];

export type CatalogApi = {
  catalog(hostId: string, refresh: boolean): Promise<CatalogView>;
  bulk(hostId: string, roots: string[], action: "status" | "fetch" | "pull"): Promise<BulkResult[]>;
  pulls(repos: {accountId: string; repoId: string}[]): Promise<PullsResult[]>;
  /** The preview of a clone of `repo` to `destination` on a machine: what will happen, before it does. */
  prepareClone(repo: RemoteRow["repo"], hostId: string, destination: string): Promise<{id: string; lines: string[]}>;
  /** Clones as previewed; the new working copy's id when it is attached. */
  clone(previewId: string): Promise<{copyId: string | null}>;
  /** Attaches a local project as a working copy (if it is not yet) and opens it. */
  open(hostId: string, path: string): Promise<void>;
  openPull(accountId: string, repo: string, number: number): void;
  /** The scaffolds for a new project on a machine. */
  scaffolds(hostId: string): Promise<ScaffoldsView>;
  /** The server's render of a scaffold and the preview of the project it makes. */
  prepareScaffold(request: ScaffoldRequest): Promise<{id: string; lines: string[]; files: {path: string; bytes: number}[]}>;
  /** Makes the prepared project; it is attached as a working copy. */
  createScaffold(previewId: string): Promise<{copyId: string; root: string; repository: {path: string; pushed: boolean} | null; notes: string[]}>;
};
