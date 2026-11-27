import { useBbNavigate, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import { useCallback, useEffect, useState } from "react";
import type { rpc } from "../adapters/bb/rpc.ts";
import { alertBadge, alertPath, type AlertSummary } from "../ui/pulls/inbox-api.ts";
import { InboxToasts } from "../ui/pulls/inbox-page.tsx";

/** Realtime channel of the My PRs alerts (inbox-rpc.ts publishes it when the list changes). */
const channel = "inbox-alerts";

/** The My PRs alerts, read once and again whenever the server says they changed. */
function useAlertSummary(): AlertSummary | null {
  const client = useRpc<typeof rpc>();
  const [summary, setSummary] = useState<AlertSummary | null>(null);
  const read = useCallback(() => {
    client.call("inboxAlerts", {}).then(result => { if (result.ok) { const {ok: _ok, ...value} = result; setSummary(value); } }, () => {});
  }, [client]);
  useEffect(read, [read]);
  useRealtime(channel, read);
  return summary;
}

/** The count on Makosh Git's navigation entry, while "show the unread count" is on. */
export function useInboxBadge() {
  return alertBadge(useAlertSummary());
}

/** Toasts for new alerts anywhere in BB, while "show alerts as toasts" is on; Open goes to the pull request here. */
export function AlertToastsOverlay() {
  const summary = useAlertSummary();
  const navigate = useBbNavigate();
  return <div className="git-ws git-ws-overlay"><InboxToasts alerts={summary} onOpen={alert => navigate.toPluginPanel("git", {subPath: alertPath(alert)})}/></div>;
}
