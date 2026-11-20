import { useTelegramLocale } from "./i18n/index.tsx";
import { useLayoutEffect, useRef, useState } from "react";

type DownloadStatus = "cancelled" | "downloading";
type SaveFilePicker = (options: { suggestedName: string }) => Promise<{
  createWritable: () => Promise<WritableStream<Uint8Array>>;
}>;

export function MiniAppDownloadReview({ download, hidden, started, finish }: {
  download: { url: string; fileName: string; bot: string };
  hidden: boolean;
  started: () => void;
  finish: (status?: DownloadStatus, message?: string) => void;
}) {
  const { t: tr } = useTelegramLocale();
  const picker = (window as Window & { showSaveFilePicker?: SaveFilePicker }).showSaveFilePicker;
  const transfer = useRef<{ controller: AbortController; started: boolean } | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  useLayoutEffect(() => () => transfer.current?.controller.abort(), []);

  async function save() {
    if (!picker || transfer.current) return;
    const controller = new AbortController();
    const { signal } = controller;
    const current = { controller, started: false };
    transfer.current = current;
    setFailed(false);
    setSaving(true);
    try {
      const file = await picker.call(window, { suggestedName: download.fileName });
      if (signal.aborted) return;
      const response = await fetch(download.url, {
        signal, mode: "cors", credentials: "omit", redirect: "error", referrerPolicy: "no-referrer", cache: "no-store",
      });
      if (!response.ok || !response.body) throw new Error("Download response is unavailable.");
      if (signal.aborted) return;
      const writable = await file.createWritable();
      if (signal.aborted) {
        await writable.abort();
        return;
      }
      current.started = true;
      started();
      await response.body.pipeTo(writable, { signal });
      if (!signal.aborted) finish(undefined, "Mini App file saved.");
    } catch (error) {
      if (signal.aborted) return;
      if (current.started) finish(undefined, "Could not finish saving the Mini App file.");
      else if (error instanceof DOMException && error.name === "AbortError") finish("cancelled");
      else setFailed(true);
    } finally {
      const cancelled = signal.aborted;
      controller.abort();
      if (transfer.current === current) transfer.current = undefined;
      if (!cancelled) setSaving(false);
    }
  }

  return <section aria-label={tr("Mini App file download")} hidden={hidden}>
    <p><bdi>{download.bot}</bdi>{tr(" wants to download ")}<bdi>{download.fileName}</bdi>{tr(" from ")}<bdi>{new URL(download.url).host}</bdi>.</p>
    {saving ? <p role="status">{tr("Saving Mini App file…")}</p> : <>
      {picker && <button type="button" className="mtg-action" onClick={() => void save()}>{tr("Save file as…")}</button>}
      <a className="mtg-action" href={download.url} download={download.fileName} target="_blank"
        rel="noopener noreferrer" onClick={() => finish("downloading")}>{tr("Download file")}</a>
    </>}
    {failed && <p role="alert">{tr("Direct saving failed. Use Download file to continue in the browser.")}</p>}
    <button type="button" className="mtg-action" onClick={() => {
      const current = transfer.current;
      current?.controller.abort();
      finish(current?.started ? undefined : "cancelled");
    }}>{tr("Cancel download")}</button>
  </section>;
}
