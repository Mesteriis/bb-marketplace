import { useTelegramLocale } from "./i18n/index.tsx";
import { Download, File } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { DownloadQueueAction, DownloadQueueCounts, DownloadQueueFilter, DownloadQueuePage, DownloadQueueProgress, TelegramPhoto } from "../core/contract.ts";
import { formatSize } from "./format-size.ts";
import { photoSource } from "./photo-preview.tsx";
import { useVisibleThumbnail } from "./visible-thumbnail.ts";

type QueueDownload = (id: string, messageId: string) => Promise<boolean>;
export const QueueDownloadAction = createContext<QueueDownload | undefined>(undefined);

export function QueueDownloadButton({ chatId, messageId }: { chatId: string; messageId: string }) {
  const { t: tr } = useTelegramLocale();
  const queue = useContext(QueueDownloadAction);
  const [status, setStatus] = useState<"pending" | "queued" | "failed">();
  if (!queue) return null;
  return <>
    <button type="button" className="mtg-action" data-queue-download disabled={status === "pending"}
      onClick={async () => {
        setStatus("pending");
        try { setStatus(await queue(chatId, messageId) ? "queued" : "failed"); }
        catch { setStatus("failed"); }
      }}><Download size={15} aria-hidden="true" />{status === "pending" ? tr("Adding to downloads…") : tr("Add to downloads")}</button>
    {status === "queued" && <span role="status">{tr("Added to downloads.")}</span>}
    {status === "failed" && <p role="alert">{tr("Could not add this file to Telegram downloads.")}</p>}
  </>;
}

export type DownloadQueueActions = {
  load: (filter: DownloadQueueFilter, offset: string, query: string) => Promise<DownloadQueuePage>;
  thumbnail?: (id: string, messageId: string, fileId: number) => Promise<TelegramPhoto | null>;
  change: (fileId: number, action: DownloadQueueAction) => Promise<boolean>;
  save: (id: string, messageId: string) => Promise<boolean>;
  pauseAll?: (paused: boolean) => Promise<boolean>;
  clearCompleted?: () => Promise<boolean>;
};

const labels = { waiting: "Waiting", downloading: "Downloading", paused: "Paused", completed: "Completed" };

function DownloadThumbnail({ file, load }: {
  file: DownloadQueuePage["entries"][number];
  load?: DownloadQueueActions["thumbnail"];
}) {
  const target = useRef<HTMLSpanElement>(null);
  const thumbnail = useCallback((id: string, messageId: string) => load?.(id, messageId, file.fileId) ?? Promise.resolve(null),
    [load, file.fileId]);
  const { photo, discard } = useVisibleThumbnail(target, file.reference.id, file.reference.messageId,
    file.thumbnail && load ? thumbnail : undefined);
  return <span ref={target} className="mtg-download-thumbnail" aria-hidden="true">
    {file.thumbnail && photo ? <img alt="" src={photoSource(photo)} onError={discard} /> : <File size={18} />}
  </span>;
}

export function DownloadQueue({ actions, openSource, expanded, changed }: {
  expanded?: boolean;
  changed?: number;
  actions: DownloadQueueActions;
  openSource?: (reference: DownloadQueuePage["entries"][number]["reference"]) => Promise<boolean>;
}) {
  const { t: tr } = useTelegramLocale();
  const [open, setOpen] = useState(false);
  const visible = open || expanded === true;
  const [filter, setFilter] = useState<DownloadQueueFilter>("all");
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [offsets, setOffsets] = useState([""]);
  const [page, setPage] = useState<DownloadQueuePage>();
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busyFile, setBusyFile] = useState<number | "all">();
  const [revision, setRevision] = useState(0);
  const refreshButton = useRef<HTMLButtonElement>(null);
  const offset = offsets.at(-1) ?? "";

  useEffect(() => {
    if (!visible) {
      setPage(undefined);
      setError("");
    }
  }, [visible]);

  useEffect(() => {
    if (!visible) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function refresh() {
      try {
        const result = await actions.load(filter, offset, query);
        if (!active) return;
        setPage(result);
        setError("");
        if (result.entries.some(({ state }) => state === "downloading" || state === "waiting")
          || result.counts && result.counts.active > result.counts.paused) timer = setTimeout(refresh, 1500);
      } catch {
        if (active) setError("Telegram downloads are unavailable.");
      }
    }
    void refresh();
    return () => { active = false; clearTimeout(timer); };
  }, [actions, changed, filter, offset, visible, query, revision]);

  const totals = page?.counts;
  const showBulk = !query && filter !== "completed" && !!actions.pauseAll && totals && totals.active > 0;

  async function changeAll(paused: boolean) {
    if (!actions.pauseAll || busyFile !== undefined) return;
    setBusyFile("all");
    setNotice("");
    try {
      if (await actions.pauseAll(paused)) {
        setRevision((value) => value + 1);
        setNotice(paused ? "All downloads paused." : "All downloads resumed.");
      } else setNotice("Telegram did not update all downloads.");
    } catch {
      setNotice("Could not update all downloads.");
    } finally {
      setBusyFile(undefined);
    }
  }

  async function clearCompleted() {
    if (!actions.clearCompleted || busyFile !== undefined) return;
    setBusyFile("all");
    setNotice("");
    try {
      if (await actions.clearCompleted()) {
        setOffsets([""]);
        setPage(undefined);
        setRevision((value) => value + 1);
        setNotice("Completed downloads removed from the list.");
        refreshButton.current?.focus();
      } else setNotice("Telegram did not clear completed downloads.");
    } catch {
      setNotice("Could not clear completed downloads.");
    } finally {
      setBusyFile(undefined);
    }
  }

  async function perform(file: DownloadQueuePage["entries"][number], action: DownloadQueueAction | "save" | "open") {
    if (busyFile !== undefined) return;
    setBusyFile(file.fileId);
    setNotice("");
    try {
      const ok = action === "save" ? await actions.save(file.reference.id, file.reference.messageId)
        : action === "open" ? await openSource?.(file.reference)
        : await actions.change(file.fileId, action);
      if (!ok) setNotice(action === "save" ? "No file was saved."
        : action === "open" ? "The original message is unavailable." : "Telegram did not update the download.");
      else if (action === "save") setNotice("Save started.");
      else if (action !== "open") setRevision((value) => value + 1);
    } catch {
      setNotice("Could not update the download.");
    } finally {
      setBusyFile(undefined);
    }
  }

  const content = visible && <div className="mtg-download-queue">
      <form onSubmit={(event) => {
        event.preventDefault();
        if (busyFile !== undefined) return;
        setQuery(search.trim());
        setOffsets([""]);
        setPage(undefined);
        setRevision((value) => value + 1);
      }}>
        <label>{tr("Find downloads ")}<input type="search" maxLength={128} value={search} disabled={busyFile !== undefined}
          onChange={(event) => setSearch(event.currentTarget.value)} /></label>
        <button type="submit" className="mtg-action" disabled={busyFile !== undefined}>{tr("Search downloads")}</button>
      </form>
      <label>{tr("Show downloads ")}<select value={filter} disabled={busyFile !== undefined} onChange={(event) => {
        setFilter(event.currentTarget.value as DownloadQueueFilter);
        setOffsets([""]);
        setPage(undefined);
      }}>
        <option value="all">{tr("All")}</option><option value="active">{tr("Active")}</option><option value="completed">{tr("Completed")}</option>
      </select></label>
      <button ref={refreshButton} type="button" className="mtg-action" onClick={() => setRevision((value) => value + 1)}>{tr("Refresh downloads")}</button>
      {totals && <p>{totals.active - Math.min(totals.active, totals.paused)}{tr(" active · ")}{totals.paused}{tr(" paused · ")}{totals.completed}{tr(" completed")}</p>}
      {showBulk && <>
        {totals.active > totals.paused && <button type="button" className="mtg-action" disabled={busyFile !== undefined}
          onClick={() => void changeAll(true)}>{tr("Pause all downloads")}</button>}
        {totals.paused > 0 && <button type="button" className="mtg-action" disabled={busyFile !== undefined}
          onClick={() => void changeAll(false)}>{tr("Resume all downloads")}</button>}
      </>}
      {!query && filter !== "active" && actions.clearCompleted && !!totals?.completed &&
        <button type="button" className="mtg-action" disabled={busyFile !== undefined}
          onClick={() => void clearCompleted()}>{tr("Clear completed downloads")}</button>}
      {!page && !error && <p role="status">{tr("Loading downloads…")}</p>}
      {error && <p role="alert">{tr(error)}</p>}
      {page?.entries.length === 0 && <p>{tr("No downloads on this page.")}</p>}
      {!!page?.entries.length && <ul aria-label={tr("Telegram downloads")}>
        {page.entries.map((file) => <li key={file.fileId}>
          <div className="mtg-download-entry">
            <DownloadThumbnail key={`${file.reference.id}:${file.reference.messageId}:${file.thumbnail === true}`}
              file={file} load={actions.thumbnail} />
            <div>
              <bdi>{file.name}</bdi>
              <p>{tr(labels[file.state])}{file.total > 0 ? ` · ${formatSize(file.downloaded)} / ${formatSize(file.total)}`
                : file.downloaded ? ` · ${formatSize(file.downloaded)}` : ""}</p>
            </div>
          </div>
          {file.state !== "completed" && <progress aria-label={tr("Progress for {0}", [file.name])}
            max={file.total || undefined} value={file.total ? file.downloaded : undefined} />}
          {file.state === "completed" ? <button type="button" className="mtg-action" disabled={busyFile !== undefined}
            onClick={() => void perform(file, "save")}>{tr("Save file")}</button>
            : <button type="button" className="mtg-action" disabled={busyFile !== undefined}
              onClick={() => void perform(file, file.state === "paused" ? "resume" : "pause")}>
              {file.state === "paused" ? tr("Resume") : tr("Pause")}
            </button>}
          <button type="button" className="mtg-action" disabled={busyFile !== undefined}
            onClick={() => void perform(file, "remove")}>{tr("Remove from downloads")}</button>
          {openSource && <button type="button" className="mtg-action" disabled={busyFile !== undefined}
            onClick={() => void perform(file, "open")}>{tr("Go to message")}</button>}
        </li>)}
      </ul>}
      {offsets.length > 1 && <button type="button" className="mtg-action" onClick={() => {
        setOffsets((previous) => previous.slice(0, -1)); setPage(undefined);
      }}>{tr("Previous downloads")}</button>}
      {page?.next && !offsets.includes(page.next) && <button type="button" className="mtg-action" onClick={() => {
        setOffsets((previous) => [...previous, page.next!]); setPage(undefined);
      }}>{tr("Next downloads")}</button>}
      {notice && <p role="status">{tr(notice)}</p>}
    </div>;
  return expanded ? content : <details onToggle={(event) => {
    if (event.target === event.currentTarget) setOpen(event.currentTarget.open);
  }}>
    <summary>{tr("Downloads")}</summary>
    {content}
  </details>;
}

export type SubscribeToDownloadProgress = (listener: (progress: DownloadQueueProgress) => void) => () => void;

function RailDownloadProgress({ subscribe, enabled }: { subscribe: SubscribeToDownloadProgress; enabled: boolean }) {
  const { t: tr } = useTelegramLocale();
  const [progress, setProgress] = useState<DownloadQueueProgress>();
  useEffect(() => subscribe(setProgress), [subscribe]);
  if (!enabled || !progress || progress.totalBytes <= progress.downloadedBytes) return null;
  return <progress className="mtg-downloads-progress" aria-label={tr("Download progress")}
    aria-valuetext={`${formatSize(progress.downloadedBytes)} of ${formatSize(progress.totalBytes)}`}
    max={progress.totalBytes} value={progress.downloadedBytes} />;
}

export function DownloadQueueDialog({ actions, counts, changed, openSource, subscribeToProgress }: {
  actions: DownloadQueueActions;
  counts?: DownloadQueueCounts;
  changed?: number;
  subscribeToProgress?: SubscribeToDownloadProgress;
  openSource?: (reference: DownloadQueuePage["entries"][number]["reference"], close: () => boolean) => Promise<boolean>;
}) {
  const { t: tr } = useTelegramLocale();
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const returningToSource = useRef(false);
  const [open, setOpen] = useState(false);
  const badge = counts?.active || counts?.completed;
  const description = counts
    ? tr("{0} unfinished, {1} paused, {2} completed", [counts.active, counts.paused, counts.completed]) : undefined;
  function closeForSource() {
    if (!dialog.current?.open) return false;
    returningToSource.current = true;
    dialog.current.close();
    return true;
  }

  return <>
    <div className="mtg-downloads-control">
    <button ref={trigger} type="button" className="mtg-downloads-trigger" aria-label={tr("Downloads")}
      aria-description={description} aria-haspopup="dialog"
      onClick={() => {
        if (!dialog.current || dialog.current.open) return;
        returningToSource.current = false;
        dialog.current.showModal();
        setOpen(true);
      }}>
      <Download size={20} aria-hidden="true" />{tr("Downloads")}{!!badge && <span className="mtg-downloads-count" data-completed={!counts?.active || undefined} aria-hidden="true">{badge}</span>}
    </button>
    {subscribeToProgress && <RailDownloadProgress subscribe={subscribeToProgress} enabled={!counts || counts.active > counts.paused} />}
    </div>
    <dialog ref={dialog} className="mtg-agent-settings mtg-downloads-dialog" aria-label={tr("Telegram downloads")} onClose={() => {
      setOpen(false);
      if (!returningToSource.current) trigger.current?.focus();
    }}>
      <h2>{tr("Downloads")}</h2>
      {open && <DownloadQueue expanded actions={actions} changed={changed}
        openSource={openSource && ((ref) => openSource(ref, closeForSource))} />}
      <button type="button" className="mtg-action" onClick={() => dialog.current?.close()}>{tr("Close downloads")}</button>
    </dialog>
  </>;
}
