import { useTelegramLocale } from "./i18n/index.tsx";
import { useEffect, useRef, useState } from "react";
import type { DeletionScope } from "../core/contract.ts";

export type BatchDeletionActions = {
  options: (id: string, ids: string[]) => Promise<DeletionScope[]>;
  remove: (id: string, ids: string[], scope: DeletionScope) => Promise<"deleted" | "refused" | "unknown">;
};

export function BatchMessageDeletion({ chatId, ids, actions, close }: {
  chatId: string; ids: string[]; actions: BatchDeletionActions; close: (deleted?: boolean) => void;
}) {
  const { t: tr } = useTelegramLocale();
  const started = useRef(false);
  const [scopes, setScopes] = useState<DeletionScope[]>([]);
  const [status, setStatus] = useState<"checking" | "ready" | "failed" | "deleting" | "refused" | "unknown" | "deleted">("checking");

  useEffect(() => {
    let mounted = true;
    void actions.options(chatId, ids).then(
      (result) => { if (mounted) { setScopes(result); setStatus("ready"); } },
      () => { if (mounted) setStatus("failed"); },
    );
    return () => { mounted = false; };
  }, [actions, chatId, ids]);

  async function remove(scope: DeletionScope) {
    if (status !== "ready" || started.current) return;
    started.current = true;
    setStatus("deleting");
    const result = await actions.remove(chatId, ids, scope).catch(() => "unknown" as const);
    setStatus(result);
    if (result === "deleted") close(true);
  }

  const text = status === "checking" ? "Checking deletion permissions…"
    : status === "ready" ? scopes.length ? `Delete ${ids.length} selected messages?` : "No deletion option applies to all selected messages."
    : status === "deleting" ? "Deleting selected messages…"
    : status === "failed" ? "Could not check deletion permissions."
    : status === "refused" ? "Telegram refused the deletion."
    : status === "unknown" ? "Telegram did not confirm the deletion. Check the conversation before trying again."
    : "Selected messages deleted.";
  return <section className="mtg-edit" role="group" aria-label={tr("Selected message deletion")}>
    <p role="status">{text}</p>
    {status === "ready" && scopes.map((scope) => <button key={scope} type="button" className="mtg-action"
      onClick={() => void remove(scope)}>{scope === "self" ? tr("Delete selected for me") : tr("Delete selected for everyone")}</button>)}
    <button type="button" className="mtg-action" disabled={status === "deleting"}
      onClick={() => close()}>{status === "checking" || status === "ready" && scopes.length ? tr("Cancel selection review") : tr("Close selection review")}</button>
  </section>;
}
