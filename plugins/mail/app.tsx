// Makosh Mail — BB frontend entry.
//
// Compiled by `bb plugin build` into dist/app.js + dist/app.css. React and
// @get-bb/plugin-sdk/app are provided by the BB app at load time (never
// bundled), so this file must be loaded by BB, not imported directly.
//
// This file is the BB adapter: it fetches data over BB RPC and hands it to
// the host-agnostic components in src/ui.
import { useEffect, useState } from "react";
import { definePluginApp, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server.ts";
import type { MailOverview } from "./src/core/index.ts";
import { MailHome } from "./src/ui/mail-home.tsx";

function MailPage() {
  const rpc = useRpc<typeof rpcContract>();
  const [overview, setOverview] = useState<MailOverview | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    rpc.call("overview_get").then(
      (result) => {
        if (cancelled) return;
        setOverview(result);
        setError(null);
      },
      (cause: unknown) => {
        if (cancelled) return;
        setError(cause instanceof Error ? cause.message : String(cause));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [rpc]);

  return <MailHome overview={overview} error={error} />;
}

// The default export must be definePluginApp(...); BB interprets it after
// loading the bundle. navPanel adds a page to the left sidebar, routed at
// /plugins/makosh-mail/mail.
export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "mail",
    title: "Mail",
    icon: "Mail",
    path: "mail",
    component: MailPage,
  });
});
