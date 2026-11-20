import { useTelegramLocale } from "./i18n/index.tsx";
import { useState } from "react";
import { chatExportOptions, type ChatExportOptions } from "../core/contract.ts";

export type ExportChat = (chatId: string, options: ChatExportOptions) => Promise<boolean>;

export function ChatExport({ title = "Export chat history", save, account }: {
  title?: string; save: (options: ChatExportOptions) => Promise<boolean>; account?: boolean;
}) {
  const { t: tr } = useTelegramLocale();
  const [format, setFormat] = useState<ChatExportOptions["format"]>("html");
  const [media, setMedia] = useState(false);
  const [profileMusic, setProfileMusic] = useState(false);
  const [from, setFrom] = useState("");
  const [through, setThrough] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<"started" | "failed">();
  const end = through ? new Date(`${through}T00:00:00`) : undefined;
  if (end) end.setDate(end.getDate() + 1);
  const range = from || end ? { from: from ? new Date(`${from}T00:00:00`).getTime() / 1000 : undefined,
    until: end ? end.getTime() / 1000 : undefined } : undefined;
  const options = chatExportOptions.safeParse({ format, media, ...(range && { range }), ...(account && profileMusic && { profileMusic: true }) });
  return <details>
    <summary>{title}</summary>
    <form onSubmit={async (event) => {
      event.preventDefault();
      if (busy || !options.success) return;
      setBusy(true);
      setStatus(undefined);
      try { setStatus(await save(options.data) ? "started" : undefined); }
      catch { setStatus("failed"); }
      finally { setBusy(false); }
    }}>
      <label>{tr("Export format ")}<select value={format} disabled={busy} onChange={(event) =>
        setFormat(event.currentTarget.value === "json" ? "json" : "html")}>
        <option value="html">HTML</option><option value="json">JSON</option>
      </select></label>
      <label><input type="checkbox" disabled={busy} checked={media} onChange={(event) => setMedia(event.currentTarget.checked)} />{tr("Include downloadable attachments (TAR archive)")}</label>
      {account && <label><input type="checkbox" disabled={busy} checked={profileMusic} onChange={(event) => setProfileMusic(event.currentTarget.checked)} />{tr("Include profile music")}</label>}
      <label>{tr("From date ")}<input type="date" value={from} disabled={busy} max={through || undefined}
        onChange={(event) => setFrom(event.currentTarget.value)} /></label>
      <label>{tr("Through date ")}<input type="date" value={through} disabled={busy} min={from || undefined}
        onChange={(event) => setThrough(event.currentTarget.value)} /></label>
      {!options.success && <p role="alert">{tr("Choose a valid date range.")}</p>}
      <button className="mtg-action" type="submit" disabled={busy || !options.success}>{tr("Save export")}</button>
    </form>
    {status === "started" && <p role="status">{tr("Download started.")}</p>}
    {status === "failed" && <p role="alert">{tr("Could not start the Telegram export.")}</p>}
  </details>;
}
