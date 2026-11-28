import type { GitResult } from "../core/git.ts";
import type { Account, CatalogPage, Repo } from "../core/providers.ts";
import type { Preview, RemoteAction, RemoteOutcome } from "../core/publication.ts";

/** The accounts and the previewed writes through them, as the copy's page, its repository panel and Connections use them. */
export interface RemoteApi {
  accounts(): Promise<Account[]>;
  repositories(accountId: string, page: number, refresh: boolean): Promise<CatalogPage>;
  status(copyId: string): Promise<GitResult>;
  prepare(target: {accountId: string; repoId: string}, action: RemoteAction): Promise<Preview>;
  publish(previewId: string): Promise<RemoteOutcome>;
  activity(): Promise<RemoteOutcome[]>;
}
