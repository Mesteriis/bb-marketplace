// Makosh Zoom — BB frontend entry.
//
// Compiled by `bb plugin build` into dist/app.js. React and
// @get-bb/plugin-sdk/app are provided by the BB app at load time. This file
// is the BB adapter: it binds RPC, realtime and navigation into plain props
// for the host-agnostic page in src/ui, which never calls the host.
import { useCallback, useMemo, useState } from "react";
import { definePluginApp, useBbNavigate, useRealtime, useRpc, type PluginNavPanelProps } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { rpcContract } from "./server.ts";
import { useZoomApi } from "./src/adapters/bb/use-zoom-api.ts";
import { CALL_PAGE_PATH, CHANNEL_ACCOUNT_CHANGED } from "./src/core/contract.ts";
import type { Notify } from "./src/ui/api.ts";
import { ZoomPage } from "./src/ui/zoom-page.tsx";

function ZoomPanel(_props: PluginNavPanelProps) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const api = useZoomApi(rpc);
  const [refreshKey, setRefreshKey] = useState(0);

  useRealtime(CHANNEL_ACCOUNT_CHANGED, () => setRefreshKey((value) => value + 1));

  const notify: Notify = useMemo(
    () => (kind, message) => {
      if (kind === "error") toast.error(message);
      else if (kind === "success") toast.success(message);
      else toast.info(message);
    },
    [],
  );
  const openExternal = useCallback(
    (url: string) => {
      if (!navigate.openUrl(url)) toast.error("BB не смог открыть ссылку");
    },
    [navigate],
  );

  return (
    <ZoomPage api={api} origin={window.location.origin} callPageUrl={CALL_PAGE_PATH} openExternal={openExternal} refreshKey={refreshKey} notify={notify} />
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "zoom",
    title: "Zoom",
    icon: "Video",
    path: "zoom",
    component: ZoomPanel,
  });
});
