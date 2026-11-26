import { useMemo } from "react";
import { definePluginApp, useRpc, type PluginNavPanelProps } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { rpcContract } from "./server";
import { useCatalogApi } from "./src/adapters/bb/use-catalog-api";
import type { Notify } from "./src/ui/api";
import { CatalogPage } from "./src/ui/catalog-page";
import "./src/ui/catalog.css";

function CatalogPanel(_props: PluginNavPanelProps) {
  const rpc = useRpc<typeof rpcContract>();
  const api = useCatalogApi(rpc);
  const notify: Notify = useMemo(
    () => (kind, message) => {
      if (kind === "error") toast.error(message);
      else if (kind === "success") toast.success(message);
      else toast.info(message);
    },
    [],
  );
  return <CatalogPage api={api} notify={notify} openUrl={(url) => window.open(url, "_blank", "noopener,noreferrer")} />;
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "mcp-catalog",
    title: "MCP Каталог",
    icon: "Plug",
    path: "mcp-catalog",
    component: CatalogPanel,
  });
});
