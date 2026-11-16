import { experimental_Diff as Diff } from "@get-bb/plugin-sdk/app";
import { splitPatch, type PatchFile } from "./model";

export type DiffKind = "upstream" | "local";

/** What a diff fetch can be: still running, failed, or a set of file patches. */
export type DiffState =
  | { phase: "loading" }
  | { phase: "error"; message: string }
  | { phase: "ready"; files: PatchFile[] };

/**
 * One labelled patch. The parent owns fetching and caching (a diff is loaded
 * once, on first expand, and kept for the life of the panel), so this component
 * only decides how a loading, failed, empty, or multi-file patch looks.
 */
export function SkillDiff({
  label,
  state,
  onRetry,
}: {
  label: string;
  state: DiffState | undefined;
  onRetry: () => void;
}) {
  return (
    <section className="mt-3">
      <h4 className="text-xs font-medium text-muted-foreground">{label}</h4>
      {state === undefined || state.phase === "loading" ? (
        <p className="mt-1 text-xs text-muted-foreground">Loading diff…</p>
      ) : state.phase === "error" ? (
        <p role="alert" className="mt-1 text-xs text-destructive">
          {state.message}{" "}
          <button
            type="button"
            onClick={onRetry}
            className="underline underline-offset-2"
          >
            Retry
          </button>
        </p>
      ) : state.files.length === 0 ? (
        <p className="mt-1 text-xs text-muted-foreground">No changes.</p>
      ) : (
        <div className="mt-1 space-y-2">
          {state.files.map((file) => (
            <div
              key={file.path}
              className="overflow-hidden rounded-md border border-border"
            >
              <p className="border-b border-border bg-muted/40 px-2 py-1 font-mono text-[11px] text-muted-foreground">
                {file.path}
              </p>
              <Diff patch={file.patch} path={file.path} />
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

/** Cache key for one skill's diff of one kind. */
export function diffKey(name: string, kind: DiffKind): string {
  return `${kind}:${name}`;
}

export { splitPatch };
export type { PatchFile };
