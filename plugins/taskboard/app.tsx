import { useTaskboardApi } from "./src/adapters/bb/use-taskboard-api.ts";
// Makosh Taskboard — BB frontend entry.
//
// Compiled by `bb plugin build` into dist/app.js. React and
// @get-bb/plugin-sdk/app are provided by the BB app at load time. This file
// is the BB adapter: it binds RPC into a plain TaskboardApi and hands it to
// the host-agnostic page in src/ui, which never calls the host.
import { useMemo } from "react";
import { definePluginApp, useBbNavigate, useRpc, type PluginNavPanelProps } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { rpcContract } from "./server.ts";
import type { Notify } from "./src/ui/api.ts";
import { TaskboardPage } from "./src/ui/taskboard-page.tsx";

function TaskboardPanel(_props: PluginNavPanelProps) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();

  const notify: Notify = useMemo(() => (kind, message) => {
    if (kind === "error") toast.error(message);
    else if (kind === "success") toast.success(message);
    else toast.info(message);
  }, []);

  const api = useTaskboardApi(rpc);

  return <TaskboardPage api={api} notify={notify} openThread={(threadId) => navigate.toThread(threadId)} />;
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "taskboard",
    title: "Taskboard",
    icon: "LayoutGrid",
    path: "taskboard",
    component: TaskboardPanel,
  });
});
