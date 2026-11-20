import { useTelegramLocale } from "./i18n/index.tsx";
import { Shield } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { AgentAccess, RuntimeInfo } from "../core/contract.ts";

export function AgentAccessPanel({ read, readRuntime, change, disconnect, signOut, inline = false }: {
  inline?: boolean;
  read: () => Promise<AgentAccess>;
  readRuntime?: () => Promise<RuntimeInfo>;
  disconnect: () => Promise<void>;
  signOut?: () => Promise<void>;
  change: (capability: Exclude<keyof AgentAccess, "history">, enabled: boolean) => Promise<AgentAccess>;
}) {
  const { t: tr } = useTelegramLocale();
  const dialog = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(inline);
  const [runtime, setRuntime] = useState<RuntimeInfo | null>();
  const [config, setConfig] = useState<AgentAccess>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [confirmSignOut, setConfirmSignOut] = useState(false);
  const [signOutFailed, setSignOutFailed] = useState(false);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setConfig(undefined);
    setConfirmSignOut(false);
    setSignOutFailed(false);
    setError(false);
    void read().then(
      (value) => { if (alive) setConfig(value); },
      () => { if (alive) setError(true); },
    );
    return () => { alive = false; };
  }, [open, read]);

  useEffect(() => {
    if (!open || !readRuntime) return;
    let alive = true;
    setRuntime(undefined);
    void readRuntime().then(
      (value) => { if (alive) setRuntime(value); },
      () => { if (alive) setRuntime(null); },
    );
    return () => { alive = false; };
  }, [open, readRuntime]);

  async function update(capability: Exclude<keyof AgentAccess, "history">, enabled: boolean) {
    if (busy) return;
    setBusy(true);
    setError(false);
    try { setConfig(await change(capability, enabled)); }
    catch { setError(true); }
    finally { setBusy(false); }
  }

  async function stopConnection() {
    setBusy(true);
    setError(false);
    try { await disconnect(); }
    catch { setError(true); }
    finally { setBusy(false); }
  }

  async function endSession() {
    if (busy || !signOut) return;
    setBusy(true);
    setSignOutFailed(false);
    try { await signOut(); }
    catch {
      setSignOutFailed(true);
      void read().then(setConfig).catch(() => setError(true));
    } finally { setBusy(false); }
  }

  const content = <>
      {inline ? <h3>{tr("Telegram agent access")}</h3> : <strong>{tr("Telegram agent access")}</strong>}
      {config ? <>
        <p>{tr("In Chat details, allow agents to search and read that conversation without a confirmation dialog.")}</p>
        <label><input type="checkbox" checked={config.send} disabled={busy}
          onChange={(event) => void update("send", event.target.checked)} />{tr(" Propose messages and replies")}</label>
      </> : !error && <p role="status">{tr("Loading settings…")}</p>}
      {error && <p role="alert">{tr("Could not load or save agent access.")}</p>}
      {runtime && <div>
        <p>TDLib <bdi>{runtime.tdlibVersion}</bdi></p>
        {runtime.tdlibVersion === "1.8.0"
          ? <p>{tr("Update TDLib to use forum topics, uploads larger than 2000 MiB, chat boosts, emoji status options and rich message translation.")}</p>
          : runtime.premium !== undefined && <p>{runtime.premium ? tr("Telegram Premium upload limit is 4 GB per file.")
            : tr("Telegram upload limit is 2 GB per file.")}</p>}
      </div>}
      {runtime === null && <p role="status">{tr("TDLib version unavailable.")}</p>}
      {confirmSignOut && <p>{tr("Signing out ends this Telegram session, clears its local cache and requires a new QR sign-in.")}</p>}
      {signOutFailed && <p role="alert">{tr("Telegram did not confirm sign-out.")}</p>}
      <div className="mtg-agent-settings-actions">
        {signOut && (confirmSignOut
          ? <button type="button" className="mtg-action" disabled={busy} onClick={() => void endSession()}>{tr("Confirm sign-out")}</button>
          : <button type="button" className="mtg-action" disabled={busy} onClick={() => setConfirmSignOut(true)}>{tr("Sign out of Telegram")}</button>)}
        <button type="button" className="mtg-action" disabled={busy} onClick={() => void stopConnection()}>{tr("Disconnect Telegram")}</button>
        {!inline && <button type="button" className="mtg-action" onClick={() => dialog.current?.close()}>{tr("Done")}</button>}
      </div>
  </>;
  if (inline) return content;
  return <>
    <button type="button" onClick={() => { dialog.current?.showModal(); setOpen(true); }}>
      <Shield size={20} aria-hidden="true" />{tr("Agents")}</button>
    <dialog ref={dialog} className="mtg-agent-settings" aria-label={tr("Telegram agent access")} onClose={() => setOpen(false)}>
      {content}
    </dialog>
  </>;
}
