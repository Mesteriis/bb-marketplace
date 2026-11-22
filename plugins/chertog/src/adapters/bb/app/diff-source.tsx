import { experimental_Diff as Diff, type PluginBrowserBbSdk } from "@get-bb/plugin-sdk/app";
import { z } from "zod";
import { unifiedPatch } from "../../../core/diff/unified-patch.ts";
import { entryCards, fileTarget } from "../../../core/panels/entry-card.ts";
import type { PanelRef } from "../../../core/panels/ref.ts";
import { Listeners, type ContentSource } from "./content-sources.ts";
import type { WorkspaceFileCatalog } from "./file-preview-source.tsx";

const provider = "bb-diff";
const sha = z.string().regex(/^[a-f0-9]{40}$/i);
const schema = entryCards["bb-editor"].paramsSchema.omit({ kind: true }).extend({ fromSha: sha, toSha: sha });

const statusSchema = z.object({
  outcome: z.literal("available"),
  workspace: z.object({
    checkout: z.object({ headSha: sha.nullish() }),
    mergeBase: z.object({ baseRef: z.string().nullish(), commits: z.array(z.object({ sha })) }).nullish(),
  }),
});

/** The bundled Git plugin reports the checkout and commits relative to the merge base. */
export function workspaceRevisions(plugins: Pick<PluginBrowserBbSdk["plugins"], "callRpc">) {
  return async (environmentId: string, mergeBaseBranch?: string) => {
    const { workspace } = await plugins.callRpc({
      pluginId: "bb--git", method: "workspaceStatus", input: { environmentId, ...(mergeBaseBranch ? { mergeBaseBranch } : {}) }, outputSchema: statusSchema,
    });
    const revisions = workspace.mergeBase?.commits.map(commit => commit.sha) ?? [];
    if (workspace.checkout.headSha) revisions.unshift(workspace.checkout.headSha);
    const base = sha.safeParse(workspace.mergeBase?.baseRef);
    if (base.success) revisions.push(base.data);
    return [...new Set(revisions)];
  };
}

interface FileReader {
  read(input: { hostId: string; rootPath: string; path: string; ref: string; signal: AbortSignal }): Promise<{
    content: string; contentEncoding: string;
  }>;
}

interface DiffSource extends ContentSource {
  loadRevisions(): Promise<readonly string[]>;
  selectRevisions(fromSha: string, toSha: string): void;
}

export function createDiffSource(catalog: WorkspaceFileCatalog, files: FileReader,
  listRevisions: (environmentId: string, mergeBaseBranch?: string) => Promise<readonly string[]>): DiffSource {
  const changes = new Listeners();
  const title = "BB diff";
  let revisionEnv: string | null = null;
  let generation = 0;
  let revisions: readonly string[] = [];
  let selection: { fromSha: string; toSha: string } | null = null;
  let revisionState: "ready" | "denied" | "loading" = "ready";
  type View = { controller: AbortController; patch?: string; reason?: string; ref: PanelRef };
  const views = new Map<string, View>();

  const revisionItemId = (fileId: string) => JSON.stringify([selection?.fromSha, selection?.toSha, fileId]);
  function refOf(itemId: string): PanelRef | null {
    if (!selection || catalog.selected !== revisionEnv) return null;
    const file = catalog.snapshot.items.find(item => revisionItemId(item.id) === itemId);
    const params = file && catalog.params(file.id);
    return params ? { provider, params: { environmentId: params.environmentId, path: params.path, ...selection } } : null;
  }
  return {
    async loadRevisions() {
      const current = ++generation;
      const env = catalog.selected;
      revisionEnv = env;
      revisions = [];
      selection = null;
      revisionState = env ? "loading" : "ready";
      changes.notify();
      if (!env) return [];
      try {
        const result = await listRevisions(env, catalog.comparisonBranch);
        if (current !== generation || catalog.selected !== env) return [];
        revisions = [...new Set(result.filter(value => sha.safeParse(value).success))];
        revisionState = "ready";
      } catch {
        if (current !== generation || catalog.selected !== env) return [];
        revisionState = "denied";
      }
      changes.notify();
      return revisions;
    },
    selectRevisions(fromSha, toSha) {
      selection = revisionEnv === catalog.selected && revisions.includes(fromSha) && revisions.includes(toSha) ? { fromSha, toSha } : null;
      changes.notify();
    },
    provider: {
      type: provider, paramsSchema: schema, multipleViews: false,
      capabilities: { showNativeRoute: "no", embedInstance: "yes", keepLiveInDocument: "unverified",
        rebindToSession: "no", transferBetweenWindows: "no", restoreAfterRestart: "partial" },
      async open({ ref, instanceId }) {
        const parsed = schema.safeParse(ref.params);
        if (ref.provider !== provider || !parsed.success) return { status: "access-denied" };
        const { environmentId, path, fromSha, toSha } = parsed.data;
        const target = fileTarget({ kind: "workspace", environmentId, path });
        views.get(instanceId)?.controller.abort();
        const view: View = { controller: new AbortController(), ref };
        views.set(instanceId, view);
        const signal = view.controller.signal;
        try {
          const env = await catalog.getEnvironment(environmentId, signal);
          if (env.id !== environmentId || !env.path || env.status !== "ready" || signal.aborted) return { status: "lost" };
          const rootPath = env.path;
          const separator = /^(?:[a-z]:\\|\\\\)/i.test(rootPath) ? "\\" : "/";
          const absolute = rootPath.replace(/[\\/]$/, "") + separator + target.path.split("/").join(separator);
          const read = (ref: string) => files.read({ hostId: env.hostId, rootPath, path: absolute, ref, signal });
          const [old, next] = await Promise.all([read(fromSha), read(toSha)]);
          if (signal.aborted) return { status: "lost" };
          if ([old, next].some(file => file.contentEncoding !== "utf8" || file.content.includes("\0"))) {
            view.reason = "Для сравнения нужны две текстовые версии файла.";
            return { status: "lost" };
          }
          view.patch = unifiedPatch(old.content, next.content);
          return { status: "live", addressee: null };
        } catch {
          view.controller.abort();
          view.reason = "BB не смог прочитать файл в одной из выбранных ревизий.";
          return { status: "lost" };
        }
      },
      release(instanceId) { views.get(instanceId)?.controller.abort(); views.delete(instanceId); },
      endsSessionOnLastClose: () => false, endSession: async () => "unknown",
    },
    sectionTitle: title, neutralLabel: title, canEndSession: false, offered: () => true,
    subscribe(listener) {
      const stopFiles = catalog.subscribe(listener), stopRevisions = changes.subscribe(listener);
      return () => { stopFiles(); stopRevisions(); };
    },
    section() {
      const snap = catalog.snapshot;
      if (snap.state !== "ready") return snap;
      if (revisionEnv !== catalog.selected || !selection) return { state: revisionEnv === catalog.selected ? revisionState : "ready", items: [] };
      return { ...snap, items: snap.items.map(item => ({ ...item, id: revisionItemId(item.id) })) };
    },
    refOf, stableRefOf: refOf,
    label(ref) {
      const parsed = schema.safeParse(ref.params);
      return parsed.success && ref.provider === provider ? { title: decodeURIComponent(parsed.data.path),
        context: parsed.data.fromSha.slice(0, 8) + " → " + parsed.data.toSha.slice(0, 8) } : null;
    },
    render(ref, instanceId) {
      const view = views.get(instanceId);
      if (view?.patch === undefined) return null;
      return view.patch ? <Diff path={decodeURIComponent(schema.parse(ref.params).path)} patch={view.patch} />
        : <p role="status">В этих ревизиях файл одинаков.</p>;
    },
    stateText(state, ref) {
      if (state !== "lost" && state !== "access-denied") return null;
      const reason = [...views.values()].find(view => view.ref.params.environmentId === ref.params.environmentId &&
        view.ref.params.path === ref.params.path && view.ref.params.fromSha === ref.params.fromSha &&
        view.ref.params.toSha === ref.params.toSha)?.reason;
      return { title: "Сравнение недоступно", description: (reason ?? "Проверьте доступ к среде и обеим ревизиям файла.") + " Ссылка сохранена." };
    },
  };
}
