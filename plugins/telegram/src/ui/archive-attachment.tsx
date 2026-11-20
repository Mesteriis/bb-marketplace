import { useTelegramLocale } from "./i18n/index.tsx";
import { useImperativeHandle, useLayoutEffect, useRef, useState, type Ref } from "react";
import { FileArchive } from "lucide-react";
import { ComposerActionEntry } from "./composer-actions.tsx";
import { maxTelegramUploadBytes } from "../core/contract.ts";

type Source = readonly (File | FileSystemEntry)[];
type ArchiveEntry = { path: string; file?: File };

function pathPart(name: string) {
  if (!name || /[. ]$/.test(name) || /[/\\:\p{Cc}]/u.test(name)) {
    throw new Error("A file or folder name cannot be included safely in a ZIP.");
  }
  return name;
}

function archiveDrop(data: DataTransfer) {
  const items = Array.from(data.items ?? []).filter((item) => item.kind === "file");
  if (!items.length) return { source: Array.from(data.files), folder: false };
  const entries = items.map((item) => item.webkitGetAsEntry?.() ?? item.getAsFile());
  const folder = entries.some((entry) => entry && !(entry instanceof File) && entry.isDirectory);
  return { source: entries.some((entry) => entry === null) ? [] : entries.filter((entry) => entry !== null), folder };
}

export function droppedFolderArchive(data: DataTransfer): Source | undefined {
  const drop = archiveDrop(data);
  if (drop.folder) return drop.source;
}

async function* archiveEntries(source: Source, signal: AbortSignal): AsyncGenerator<ArchiveEntry> {
  async function* walk(entry: File | FileSystemEntry, parent: string): AsyncGenerator<ArchiveEntry> {
    signal.throwIfAborted();
    if (entry instanceof File) {
      const relativePath = entry.webkitRelativePath || entry.name;
      yield { path: relativePath.split("/").map(pathPart).join("/"), file: entry };
      return;
    }
    const path = parent + pathPart(entry.name);
    if (entry.isFile) {
      const file = await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject));
      yield { path, file };
    } else if (entry.isDirectory) {
      yield { path: path + "/" };
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      while (!signal.aborted) {
        const entries = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
        if (!entries.length) break;
        for (const child of entries) yield* walk(child, path + "/");
      }
    } else throw new Error("Could not read a dropped file or folder.");
  }
  for (const entry of source) yield* walk(entry, "");
}

export async function prepareAttachmentArchive(source: Source, signal: AbortSignal) {
  const { BlobReader, BlobWriter, ZipWriter } = await import("@zip.js/zip.js");
  signal.throwIfAborted();
  const output = new BlobWriter("application/zip");
  const archive = new ZipWriter(output, { useWebWorkers: false });
  const paths = new Set<string>();
  const encoder = new TextEncoder();
  let bytes = 0;
  try {
    for await (const { path, file } of archiveEntries(source, signal)) {
      signal.throwIfAborted();
      const key = path.normalize("NFC").toLowerCase().replace(/\/$/, "");
      if (paths.has(key)) throw new Error("Two ZIP entries have the same name.");
      if (encoder.encode(path).length > 65535) throw new Error("A ZIP entry path is too long.");
      paths.add(key);
      bytes += file?.size ?? 0;
      if (bytes > maxTelegramUploadBytes) throw new Error("Choose files totaling up to 4000 MiB.");
      await archive.add(path, file ? new BlobReader(file) : undefined, {
        directory: !file, signal, ...(file?.lastModified && { lastModDate: new Date(file.lastModified) }),
      });
    }
    signal.throwIfAborted();
    if (!paths.size) throw new Error("Choose a folder or files to put in the ZIP.");
  } catch (error) {
    await archive.close().catch(() => {});
    throw error;
  }
  await archive.close();
  signal.throwIfAborted();
  const blob = await output.getData();
  if (blob.size > maxTelegramUploadBytes) throw new Error("The ZIP exceeds Telegram's 4000 MiB upload limit.");
  const first = source[0];
  const root = first instanceof File ? first.webkitRelativePath?.split("/")[0] : first?.isDirectory ? first.name : undefined;
  const sameRoot = root && source.every((entry) => entry instanceof File
    ? entry.webkitRelativePath?.startsWith(root + "/") : source.length === 1);
  return new File([blob], sameRoot ? `${Array.from(root).slice(0, 140).join("")}.zip` : "Archive.zip", { type: "application/zip" });
}

export type ArchiveAttachmentController = { offer: (source: Source) => void; isPreparing: () => boolean };

export function ArchiveAttachment({ controller, attach, preparing, setPreparing }: {
  controller: Ref<ArchiveAttachmentController>;
  attach: (file: File) => void;
  preparing: boolean;
  setPreparing: (preparing: boolean) => void;
}) {
  const { t: tr } = useTelegramLocale();
  const [open, setOpen] = useState(false);
  const [source, setSource] = useState<Source>([]);
  const [error, setError] = useState("");
  const request = useRef<AbortController | undefined>(undefined);
  useLayoutEffect(() => () => {
    if (!request.current) return;
    request.current.abort();
    request.current = undefined;
    setPreparing(false);
  }, [setPreparing]);

  function choose(items: Source) {
    request.current?.abort();
    request.current = undefined;
    setPreparing(false);
    setSource(items);
    setError(items.length ? "" : "Could not read the dropped files.");
  }
  useImperativeHandle(controller, () => ({
    isPreparing: () => request.current !== undefined,
    offer(items) {
      choose(items);
      setOpen(true);
    },
  }));

  async function prepare() {
    if (request.current || !source.length) return;
    const operation = new AbortController();
    request.current = operation;
    setPreparing(true);
    setError("");
    try {
      const file = await prepareAttachmentArchive(source, operation.signal);
      if (operation.signal.aborted) return;
      setSource([]);
      setOpen(false);
      attach(file);
    } catch (failure) {
      if (!operation.signal.aborted) setError(failure instanceof Error ? failure.message : "Could not prepare the ZIP.");
    } finally {
      if (request.current === operation && !operation.signal.aborted) {
        request.current = undefined;
        setPreparing(false);
      }
    }
  }

  return <div className="mtg-archive-attachment">
    <ComposerActionEntry inline={open}><button type="button" className="mtg-action" aria-expanded={open} onClick={() => {
      if (open) {
        choose([]);
        setError("");
      }
      setOpen(!open);
    }}><FileArchive size={16} aria-hidden="true" /> {open ? tr("Cancel ZIP attachment") : tr("Attach ZIP archive")}</button></ComposerActionEntry>
    {open && <div role="group" aria-label={tr("ZIP archive")} onDragOver={(event) => {
      if (!event.dataTransfer.types.includes("Files")) return;
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = "copy";
    }} onDrop={(event) => {
      if (!event.dataTransfer.types.includes("Files")) return;
      event.preventDefault();
      event.stopPropagation();
      choose(archiveDrop(event.dataTransfer).source);
    }}>
      <p>{tr("Drop files or folders here, or choose them below.")}</p>
      <label>{tr("Files for ZIP ")}<input type="file" multiple onChange={(event) => {
        choose(Array.from(event.currentTarget.files ?? []));
        event.currentTarget.value = "";
      }} /></label>
      <label>{tr("Folder for ZIP ")}<input type="file" multiple ref={(input) => { input?.setAttribute("webkitdirectory", ""); }}
        onChange={(event) => {
          choose(Array.from(event.currentTarget.files ?? []));
          event.currentTarget.value = "";
        }} /></label>
      {!!source.length && <p>{source.length}{tr(" selected ")}{source.length === 1 ? tr("item") : tr("items")}</p>}
      <button type="button" className="mtg-action" disabled={preparing || !source.length} onClick={() => void prepare()}>{tr("Prepare ZIP")}</button>
      {preparing && <p role="status">{tr("Preparing ZIP…")}</p>}
      {error && <p role="alert">{tr(error)}</p>}
    </div>}
  </div>;
}
