// The content of one live instance inside its stable host: the provider's
// view while the panel is live, and the panel state otherwise. The provider's
// view is built once per instance and reference, so a new title or status
// re-renders nothing inside it.
import { useMemo, useSyncExternalStore } from "react";
import { panelRefKey } from "../../../core/panels/index.ts";
import { PanelStateView } from "../../../ui/live-hosts/index.ts";
import type { WorkspaceSession } from "./workspace-session.ts";

export function PanelContent({ session, instanceId }: { session: WorkspaceSession; instanceId: string }) {
  useSyncExternalStore(session.subscribe, session.getVersion);
  const view = session.viewOf(instanceId);
  const source = view?.source;
  const live = view !== null && view.instance.state === "live" && source !== undefined;
  const refKey = view === null ? null : panelRefKey(view.ref);
  const content = useMemo(
    () => (live && view !== null && source !== undefined ? source.render(view.ref, instanceId) : null),
    // The reference is compared by its key: the document hands out a new object for the same reference.
    [live, refKey, source, instanceId],
  );
  if (view === null) return null;
  if (live) {
    return (
      <div data-chertog-panel={instanceId} className="flex h-full min-h-0 w-full flex-col bg-background text-foreground">
        {content}
      </div>
    );
  }
  const state = view.instance.state === "live" ? "provider-missing" : view.instance.state;
  // A panel without its provider has nobody to ask again.
  const retry = state === "loading" || state === "provider-missing" ? undefined : () => session.retry(instanceId);
  return (
    <PanelStateView
      state={state}
      panelTitle={view.title}
      {...(view.stateText === null ? {} : view.stateText)}
      {...(retry === undefined ? {} : { onRetry: retry })}
    />
  );
}
