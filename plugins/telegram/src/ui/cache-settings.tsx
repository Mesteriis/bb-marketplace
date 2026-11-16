import { Settings } from "lucide-react";
import { useRef, useState, type FormEvent, type ReactNode } from "react";
import { cacheLimitMiB, type CacheInfo } from "../core/contract.ts";

const numberFormat = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });

function formatSize(bytes: number) {
  if (bytes < 1024) return `${numberFormat.format(bytes)} B`;
  if (bytes < 1024 ** 2) return `${numberFormat.format(bytes / 1024)} KiB`;
  if (bytes < 1024 ** 3) return `${numberFormat.format(bytes / 1024 ** 2)} MiB`;
  return `${numberFormat.format(bytes / 1024 ** 3)} GiB`;
}

export function CacheSettings({ read, setLimit, clear, devices, privacy, profile, notifications }: {
  devices?: ReactNode;
  notifications?: ReactNode;
  profile?: ReactNode;
  privacy?: ReactNode | ((close: () => void) => ReactNode);
  read: () => Promise<CacheInfo>;
  setLimit: (limitMiB: number) => Promise<CacheInfo>;
  clear: () => Promise<CacheInfo>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [info, setInfo] = useState<CacheInfo>();
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const parsed = cacheLimitMiB.safeParse(Number(draft));

  async function run(work: () => Promise<CacheInfo>, failure: string, success = "") {
    if (busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await work();
      setInfo(result);
      setDraft(String(result.limitMiB));
      setNotice(success);
    } catch { setError(failure); }
    finally { setBusy(false); }
  }

  function load() { void run(read, "Could not read the Telegram media cache."); }

  function save(event: FormEvent) {
    event.preventDefault();
    if (parsed.success) void run(() => setLimit(parsed.data), "Could not save the cache limit.", "Cache limit saved.");
  }

  return <>
    <button type="button" aria-haspopup="dialog" aria-label="Telegram settings" onClick={() => {
      dialog.current?.showModal();
      load();
    }}><Settings size={20} aria-hidden="true" /><span>Settings</span></button>
    <dialog ref={dialog} className="mtg-agent-settings mtg-chat-details" aria-label="Telegram settings">
      <h2>Media cache</h2>
      {info && <>
        <p>On disk: <strong>{formatSize(info.bytes)}</strong></p>
        <form className="mtg-cache-limit" onSubmit={save}>
          <label>Cache limit (MiB) <input type="number" min={64} max={32768} step={1} required
            value={draft} disabled={busy} onChange={(event) => setDraft(event.target.value)} /></label>
          <button type="submit" className="mtg-action" disabled={busy || !parsed.success || parsed.data === info.limitMiB}>Save limit</button>
        </form>
        <p>BB removes older cached media first when usage exceeds the limit. Previews load as you scroll.</p>
        <button type="button" className="mtg-action" disabled={busy || info.bytes === 0}
          onClick={() => void run(clear, "Could not clear the cache.", "Media cache cleanup finished.")}>Clear cache</button>
        <p>Clearing media keeps your Telegram session and message history.</p>
      </>}
      {busy && <p role="status">Updating cache information…</p>}
      {notice && <p role="status">{notice}</p>}
      {error && <p role="alert">{error}</p>}
      {profile}
      {devices}
      {notifications}
      {typeof privacy === "function" ? privacy(() => dialog.current?.close()) : privacy}
      <div className="mtg-agent-settings-actions">
        <button type="button" className="mtg-action" disabled={busy} onClick={load}>Refresh size</button>
        <button type="button" className="mtg-action" onClick={() => dialog.current?.close()}>Done</button>
      </div>
    </dialog>
  </>;
}
