import { RefreshCw } from "lucide-react";
import { useTelegramLocale } from "./i18n/index.tsx";
import { useState } from "react";
import type { NetworkUsage } from "../core/contract.ts";
import { formatSize } from "./format-size.ts";

export function NetworkUsageSettings({ read, reset }: { read: () => Promise<NetworkUsage>; reset: () => Promise<boolean> }) {
  const { locale: uiLocale, t: tr } = useTelegramLocale();
  const [stats, setStats] = useState<NetworkUsage>();
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  async function load(clear = false) {
    if (busy) return;
    setBusy(true);
    setConfirm(false);
    setError("");
    setNotice("");
    try {
      if (clear) {
        if (!await reset()) throw new Error("Telegram did not confirm the reset.");
        setStats(undefined);
        setNotice("Network statistics reset.");
      }
    } catch {
      setError("Could not reset network statistics.");
      setBusy(false);
      return;
    }
    try { setStats(await read()); }
    catch { setError("Could not load network usage."); }
    finally { setBusy(false); }
  }

  const since = stats?.since ? new Date(stats.since * 1000) : undefined;
  return <details onToggle={(event) => {
    if (event.currentTarget.open) void load();
    else setConfirm(false);
  }}>
    <summary>{tr("Network usage")}</summary>
    {since && <p>{tr("Data collected since ")}<time dateTime={since.toISOString()}>{since.toLocaleString(uiLocale)}</time>.</p>}
    {stats && <table>
      <caption>{tr("Telegram data usage in BB")}</caption>
      <thead><tr><th scope="col">{tr("Data")}</th><th scope="col">{tr("Connection")}</th><th scope="col">{tr("Sent")}</th><th scope="col">{tr("Received")}</th></tr></thead>
      <tbody>
        {stats.entries.map(({ category, connection, sent, received }, index) => <tr key={index}>
          <th scope="row">{category}</th><td>{connection}</td><td>{formatSize(sent)}</td><td>{formatSize(received)}</td>
        </tr>)}
      </tbody>
      <tfoot><tr><th scope="row" colSpan={2}>{tr("Total")}</th>
        <td>{formatSize(stats.entries.reduce((sum, row) => sum + row.sent, 0))}</td>
        <td>{formatSize(stats.entries.reduce((sum, row) => sum + row.received, 0))}</td>
      </tr></tfoot>
    </table>}
    {busy && <p role="status">{tr("Updating network usage…")}</p>}
    {notice && <p role="status">{tr(notice)}</p>}
    {error && <p role="alert">{tr(error)}</p>}
    <button type="button" className="mtg-action" disabled={busy || confirm} onClick={() => void load()}><RefreshCw size={16} aria-hidden="true" />{tr("Refresh network usage")}</button>
    {stats && !confirm && <button type="button" className="mtg-action" disabled={busy} onClick={() => setConfirm(true)}>{tr("Reset network statistics")}</button>}
    {confirm && <div role="group" aria-label={tr("Confirm network statistics reset")}>
      <p>{tr("Reset the sent and received data counters?")}</p>
      <button type="button" className="mtg-action" onClick={() => setConfirm(false)}>{tr("Cancel")}</button>
      <button type="button" className="mtg-action" onClick={() => void load(true)}>{tr("Confirm reset")}</button>
    </div>}
  </details>;
}
