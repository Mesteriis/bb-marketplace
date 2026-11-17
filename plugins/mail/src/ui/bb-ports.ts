// What the page's BB integration (slice 3g) needs from the host: one typed
// RPC call, the host's code renderers, and the fixed refusal texts. The page
// never builds a prompt, a path or a title: the server does, and the page
// shows what it answers as plain text.
import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { ProjectListItem, RpcIn, RpcMethod, RpcOut } from "../core/contract.ts";
import { msg } from "./i18n/index.ts";

/** One owner RPC, as app.tsx's useRpc().call. */
export type BbCall = <M extends RpcMethod>(method: M, input: RpcIn<M>) => Promise<RpcOut<M>>;

/** BB's highlighter and diff viewer, injected by app.tsx (src/ui never imports them). */
export interface CodeRenderers {
  renderCode?: (content: string, path: string) => ReactNode;
  renderDiff?: (patch: string, path: string) => ReactNode;
  /** BB's clipboard; absent: the browser's. */
  copy?: (text: string) => void;
}

/**
 * The refusal texts the page compares or shows before asking (core contract
 * BB_REFUSAL_TEXT). Repeated here because a value import of the contract
 * would bundle zod; a test checks the two agree.
 */
export const BB_TEXT = {
  out_of_scope: msg("Outside AI access (Mail settings)"),
  no_tree: msg("This project has no single local checkout"),
  confirm_needed: msg("This file name looks like it holds a secret; confirm to attach it"),
} as const;

/** An error's message for the owner, or the fallback. */
export function errorText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message !== "" ? error.message : fallback;
}

/** The permission line of a thread dialog (spec resolution 15). */
export function permissionText(mode: "accept-edits" | "auto" | "full" | null): string[] {
  if (mode === null) return ["Runs with the project's default permissions"];
  if (mode === "full") return ["Runs with full permissions", "The agent can run commands without asking"];
  return [`Runs with ${mode} permissions`];
}

/** Classes of a native select or a textarea that look like the page's Input. */
export const FIELD_CLASS =
  "w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50";

export type ProjectsState = { projects: ProjectListItem[] | null; error: string | null };

/** The BB projects, read when the component mounts (projects_list). */
export function useProjects(call: BbCall): ProjectsState & { reload: () => void } {
  const [state, setState] = useState<ProjectsState>({ projects: null, error: null });
  const [serial, setSerial] = useState(0);
  useEffect(() => {
    let live = true;
    call("projects_list", {}).then(
      ({ projects }) => {
        if (live) setState({ projects, error: null });
      },
      (error: unknown) => {
        if (live) setState({ projects: [], error: errorText(error, "BB did not list its projects") });
      },
    );
    return () => {
      live = false;
    };
  }, [call, serial]);
  const reload = useCallback(() => setSerial((n) => n + 1), []);
  return { ...state, reload };
}

/** A project's name, or its id while the list is unknown. */
export function projectName(projects: readonly ProjectListItem[] | null, projectId: string): string {
  return projects?.find((p) => p.id === projectId)?.name ?? projectId;
}
