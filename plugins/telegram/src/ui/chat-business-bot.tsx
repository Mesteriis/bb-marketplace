import { useTelegramLocale } from "./i18n/index.tsx";
import { useState } from "react";
import type { z } from "zod";
import type { schemas } from "../core/contract.ts";

type View = z.infer<typeof schemas.chatBusinessBot.output>;
type Change = z.input<typeof schemas.changeChatBusinessBot.input>;
export type ChatBusinessBotActions = {
  read: (id: string) => Promise<View>;
  change: (input: Change) => Promise<z.infer<typeof schemas.changeChatBusinessBot.output>>;
};

export function ChatBusinessBot({ id, actions }: { id: string; actions: ChatBusinessBotActions }) {
  const { t: tr } = useTelegramLocale();
  const [view, setView] = useState<View>();
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [stale, setStale] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  async function refresh() {
    setView(await actions.read(id));
    setStale(false);
  }

  async function run(operation: () => Promise<void>, failure: string) {
    if (busy) return;
    setBusy(true);
    setNotice("");
    setError("");
    try { await operation(); }
    catch { setError(failure); }
    finally { setBusy(false); }
  }

  function change(action: Change["action"]) {
    if (!view || busy || stale || (action === "remove" && !confirm)) return;
    setConfirm(false);
    void run(async () => {
      const result = await actions.change({ id, action, revision: view.revision });
      if (result === "changed") {
        setStale(true);
        setError("Bot access changed in Telegram. Reload before editing.");
        return;
      }
      if (result !== "saved") {
        setError("Telegram could not change bot access.");
        return;
      }
      setNotice(action === "remove" ? "Bot access removed." : action === "pause" ? "Bot paused." : "Bot resumed.");
      setStale(true);
      await refresh();
    }, "Could not confirm the bot access update. Reload to check the current state.");
  }

  return <section aria-label={tr("Business bot access")}>
    <button type="button" className="mtg-action" disabled={busy || confirm}
      onClick={() => void run(refresh, "Could not load bot access.")}>{view === undefined ? tr("Business bot access") : tr("Reload bot access")}</button>
    {view === null && <p>{tr("No Business bot has access to this chat.")}</p>}
    {view && <>
      <p><bdi>{view.identity?.name ?? tr("Bot {0}", [view.botId])}</bdi>
        {view.identity?.username ? <> <bdi>@{view.identity.username}</bdi></> : null} · {view.paused ? tr("Paused") : tr("Active")}</p>
      <p>{view.canReply ? tr("Can reply in this chat.") : tr("Cannot reply in this chat.")}</p>
      {confirm ? <div role="group" aria-label={tr("Confirm removing bot access")}>
        <p>{tr("Remove the Business bot from this chat?")}</p>
        <button type="button" className="mtg-action" onClick={() => change("remove")}>{tr("Confirm remove bot")}</button>
        <button type="button" className="mtg-action" onClick={() => setConfirm(false)}>{tr("Cancel")}</button>
      </div> : <>
        <button type="button" className="mtg-action" disabled={busy || stale}
          onClick={() => change(view.paused ? "resume" : "pause")}>{view.paused ? tr("Resume bot") : tr("Pause bot")}</button>
        <button type="button" className="mtg-action" disabled={busy || stale} onClick={() => setConfirm(true)}>{tr("Remove bot access")}</button>
      </>}
    </>}
    {busy && <p role="status">{tr("Updating bot access…")}</p>}
    {notice && <p role="status">{tr(notice)}</p>}
    {error && <p role="alert">{tr(error)}</p>}
  </section>;
}
