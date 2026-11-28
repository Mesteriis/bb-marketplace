/** How the catalog shows a local project: its category folder and what its last status said. */

/** The deepest category folder of the projects folder that holds `path`; "" for the projects folder itself. */
export function categoryOf(root: string, path: string, categories: readonly string[]): string {
  const base = root.replace(/\/+$/, "") + "/";
  if (!path.startsWith(base)) return "";
  const relative = path.slice(base.length);
  return categories.filter(category => category && relative.startsWith(category + "/"))
    .reduce((best, category) => category.length > best.length ? category : best, "");
}

type Status = {root?: string; branch?: string | null; upstream?: string | null; ahead?: number; behind?: number; files?: readonly unknown[]};
export type LocalState =
  | {kind: "unknown"}
  | {kind: "failed"; code: string}
  | {kind: "ok"; branch: string | null; files: number; ahead: number; behind: number; upstream: boolean};

/** One status answer as a row's state; no answer yet is unknown, a failure keeps its code. */
export function localState(result: {ok: boolean; code: string | null; value: Status | null} | undefined): LocalState {
  if (!result) return {kind: "unknown"};
  if (!result.ok || !result.value) return {kind: "failed", code: result.code ?? "FAILED"};
  const value = result.value;
  return {kind: "ok", branch: value.branch ?? null, files: value.files?.length ?? 0, ahead: value.ahead ?? 0, behind: value.behind ?? 0, upstream: Boolean(value.upstream)};
}
