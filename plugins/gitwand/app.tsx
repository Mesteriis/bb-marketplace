// Makosh GitWand — BB frontend entry.
//
// The BB adapter for the host-agnostic UI in src/ui: a GitWand tab in each
// thread (opened from the thread's header, the command palette, or the panel
// menu), a GitWand page in the sidebar, and a settings section. Data comes
// from the plugin server over BB RPC; the UI components never call the host.
import { useCallback, useEffect, useState } from "react";
import {
  definePluginApp,
  useRpc,
  type ExperimentalTabReference,
  type ExperimentalThreadActionTabProps,
  type PluginNavPanelProps,
} from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { rpcContract } from "./server.ts";
import type { GitWandStatus } from "./src/core/contract.ts";
import { frameUrlFor } from "./src/core/frame-url.ts";
import { GitWandHost, Notice } from "./src/ui/gitwand-host.tsx";
import { SettingsPanel } from "./src/ui/settings-panel.tsx";

const GITWAND_TAB = { id: "gitwand", context: { kind: "thread" }, availability: "action" } as const satisfies ExperimentalTabReference;

const NO_RUNTIME = "Рантайм GitWand не установлен. Установите его в настройках плагина GitWand.";
const notify = (title: string, body: string) => toast.info(title, { description: body });
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

function ThreadTab({ threadId }: ExperimentalThreadActionTabProps) {
  const rpc = useRpc<typeof rpcContract>();
  const [repo, setRepo] = useState<{ path: string | null; problem: string | null } | null>(null);
  useEffect(() => {
    let live = true;
    setRepo(null);
    Promise.all([rpc.call("repo_for_thread", { threadId }), rpc.call("status", null)]).then(
      ([r, s]) => live && setRepo(s.runtime === null ? { path: null, problem: NO_RUNTIME } : r),
      (e) => live && setRepo({ path: null, problem: message(e) }),
    );
    return () => {
      live = false;
    };
    // The RPC wrapper may change identity between renders; the thread decides.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId]);
  if (repo === null) return <Notice icon="LoaderCircle" text="Открываю GitWand…" />;
  const url = repo.path === null ? null : frameUrlFor(window.location.origin, repo.path);
  return <GitWandHost url={url} problem={repo.problem} onNotify={notify} />;
}

function GitWandPage(_props: PluginNavPanelProps) {
  return <GitWandHost url={frameUrlFor(window.location.origin, null)} onNotify={notify} />;
}

function Settings() {
  const rpc = useRpc<typeof rpcContract>();
  const [status, setStatus] = useState<GitWandStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = useCallback(
    (call: () => Promise<GitWandStatus>) => {
      setBusy(true);
      setError(null);
      call()
        .then(setStatus, (e) => setError(message(e)))
        .finally(() => setBusy(false));
    },
    [rpc],
  );
  useEffect(() => run(() => rpc.call("status", null)), []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <SettingsPanel
      status={status}
      error={error}
      busy={busy}
      onRestart={() => run(() => rpc.call("restart", null))}
      onRollback={() => run(() => rpc.call("rollback", null))}
      onCheckUpdates={() => run(() => rpc.call("check_updates", null))}
      onInstall={(version) => run(() => rpc.call("install_update", { version }))}
    />
  );
}

export default definePluginApp((app) => {
  app.slots.experimental_tab({
    ...GITWAND_TAB,
    title: "GitWand",
    icon: "GitBranch",
    tooltip: "Открыть рабочий каталог треда в GitWand",
    layout: "flush",
    component: ThreadTab,
  });
  app.slots.experimental_threadAction({
    id: "open-gitwand",
    title: "GitWand",
    icon: "GitBranch",
    group: "gitwand",
    placement: "header",
    item: ({ experimental_panel }) => ({
      label: "GitWand",
      detail: "Открыть в GitWand",
      icon: "GitBranch",
      run: () => {
        experimental_panel.openTab({ tab: GITWAND_TAB });
      },
    }),
  });
  app.commands.register({
    id: "open",
    title: "GitWand: открыть рабочий каталог треда",
    isAvailable: (context) => context.threadId !== null,
    run: (context) => {
      context.experimental_panel.openTab({ tab: GITWAND_TAB });
    },
  });
  app.slots.navPanel({ id: "gitwand", title: "GitWand", icon: "GitBranch", path: "gitwand", component: GitWandPage });
  app.slots.settingsSection({ id: "gitwand", title: "GitWand", description: "Рантайм GitWand, его бэкенд и обновления", component: Settings });
});
