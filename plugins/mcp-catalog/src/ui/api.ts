import type {
  CatalogId,
  CollectionResult,
  ConfigResult,
  InstallResult,
  InventoryResult,
  ReviewItem,
  ReviewsResult,
  SearchResult,
  SecretsStateResult,
} from "../core/contract";

/** What the page needs from its host; the host entry point binds it to RPC. */
export interface CatalogApi {
  inventory(): Promise<InventoryResult>;
  setEnabled(input: { pluginId: string; serverId: string; enabled: boolean }): Promise<void>;
  approve(input: { pluginId: string; serverId: string }): Promise<void>;
  auth(input: { pluginId: string; serverId: string }): Promise<{ url: string | null }>;
  setSecrets(input: { pluginId: string; values: Record<string, string>; clear: string[] }): Promise<void>;
  remove(input: { pluginId: string }): Promise<void>;
  update(input: { pluginId: string }): Promise<void>;
  collection(): Promise<CollectionResult>;
  search(query: string, cursor?: string, catalogs?: CatalogId[]): Promise<SearchResult>;
  startReview(input: { name: string; version: string; recheck?: boolean }): Promise<ReviewItem>;
  reviews(): Promise<ReviewsResult>;
  accept(input: { name: string; version?: string }): Promise<void>;
  reject(input: { name: string; version?: string }): Promise<void>;
  install(input: { name: string; values: Record<string, string> }): Promise<InstallResult>;
  secretsState(input: { name: string } | { pluginId: string }): Promise<SecretsStateResult>;
  config(): Promise<ConfigResult>;
}

/** Which settings are filled in; an action that needs an empty one is disabled. */
export interface Setup {
  repo: boolean;
  project: boolean;
}

export type Notify = (kind: "error" | "success" | "info", message: string) => void;

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "Запрос не выполнен";
}
