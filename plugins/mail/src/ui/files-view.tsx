// Files (slice 3h, #85, `g f`): every attachment Mail has stored, newest
// first, with filters by type, sender, account and name. Only stored
// metadata: a file of mail outside the window shows once its message is
// loaded (older mail or server search). Each row can be viewed, downloaded,
// saved to a project or opened in its message.
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import type { Account, FileKind, FileRow } from "../core/index.ts";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { LoadingState } from "./empty-states.tsx";
import { accountLabel } from "./folder-list.tsx";
import { addressLabel, formatListDate } from "./thread-list.tsx";

export const FILE_KIND_FILTERS: readonly { kind: FileKind; label: string }[] = [
  { kind: "image", label: "Images" },
  { kind: "pdf", label: "PDF" },
  { kind: "document", label: "Documents" },
  { kind: "text", label: "Text" },
  { kind: "archive", label: "Archives" },
  { kind: "calendar", label: "Calendar" },
  { kind: "other", label: "Other" },
];

const KIND_TEXT: Record<FileKind, string> = {
  image: "Image",
  pdf: "PDF",
  document: "Document",
  text: "Text",
  archive: "Archive",
  calendar: "Calendar",
  other: "File",
};

/** A file size the owner reads: bytes, KB or MB. */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export interface FilesFilter {
  kind?: FileKind;
  sender?: string;
  accountId?: string;
  name?: string;
  includeJunk?: boolean;
}

export const FILES_PAGE = 50;

export interface FilesViewProps {
  accounts: readonly Account[];
  load: (filter: FilesFilter, cursor: string | null) => Promise<{ files: FileRow[]; nextCursor: string | null }>;
  /** The filter the view opens with (the sender card's Files). */
  initial?: FilesFilter;
  onView: (file: FileRow) => void;
  onDownload: (file: FileRow) => void;
  /** Save to project...; absent: not offered. */
  onSave?: (file: FileRow) => void;
  onOpenMessage: (file: FileRow) => void;
  /** Whether a row can be viewed (its kind and type). */
  viewable: (file: FileRow) => boolean;
}

export function FilesView({ accounts, load, initial = {}, onView, onDownload, onSave, onOpenMessage, viewable }: FilesViewProps) {
  const [filter, setFilter] = useState<FilesFilter>(initial);
  const [sender, setSender] = useState(initial.sender ?? "");
  const [name, setName] = useState(initial.name ?? "");
  const [files, setFiles] = useState<FileRow[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const token = useRef(0);

  const reload = useCallback(async () => {
    const mine = ++token.current;
    setFiles(null);
    setProblem(null);
    try {
      const page = await load(filter, null);
      if (mine !== token.current) return;
      setFiles(page.files);
      setNext(page.nextCursor);
    } catch (error) {
      if (mine !== token.current) return;
      setFiles([]);
      setNext(null);
      setProblem(error instanceof Error && error.message !== "" ? error.message : "Files could not be loaded");
    }
  }, [filter, load]);
  useEffect(() => {
    void reload();
  }, [reload]);

  const more = async () => {
    if (next === null) return;
    const mine = token.current;
    setLoadingMore(true);
    try {
      const page = await load(filter, next);
      if (mine !== token.current) return;
      setFiles((prev) => [...(prev ?? []), ...page.files]);
      setNext(page.nextCursor);
    } catch (error) {
      if (mine !== token.current) return;
      setProblem(error instanceof Error && error.message !== "" ? error.message : "Files could not be loaded");
    } finally {
      if (mine === token.current) setLoadingMore(false);
    }
  };

  const applyText = (event: FormEvent) => {
    event.preventDefault();
    const nextSender = sender.trim();
    const nextName = name.trim();
    setFilter((prev) => {
      const out: FilesFilter = { ...prev };
      if (nextSender === "") delete out.sender;
      else out.sender = nextSender;
      if (nextName === "") delete out.name;
      else out.name = nextName;
      return out;
    });
  };

  const setKind = (kind: FileKind | undefined) =>
    setFilter((prev) => {
      const out: FilesFilter = { ...prev };
      if (kind === undefined) delete out.kind;
      else out.kind = kind;
      return out;
    });

  const accountName = (id: string) => {
    const account = accounts.find((a) => a.id === id);
    return account === undefined ? "" : accountLabel(account);
  };

  return (
    <section aria-label="Files" className="flex flex-col gap-3">
      <h2 className="text-lg font-semibold text-foreground">Files</h2>
      <div role="group" aria-label="Type" className="flex flex-wrap items-center gap-1">
        {[{ kind: undefined, label: "All" } as { kind: FileKind | undefined; label: string }, ...FILE_KIND_FILTERS].map(({ kind, label }) => {
          const on = filter.kind === kind;
          return (
            <Button
              key={label}
              variant={on ? "secondary" : "ghost"}
              size="sm"
              className={cn("h-6 px-2 text-xs", !on && "text-muted-foreground")}
              aria-pressed={on}
              onClick={() => setKind(kind)}
            >
              {label}
            </Button>
          );
        })}
        <label className="ml-1 flex items-center gap-1.5 text-xs text-muted-foreground">
          <Checkbox
            checked={filter.includeJunk === true}
            onCheckedChange={(checked) =>
              setFilter((prev) => {
                const out: FilesFilter = { ...prev };
                if (checked === true) out.includeJunk = true;
                else delete out.includeJunk;
                return out;
              })
            }
          />
          Include Spam and Trash
        </label>
      </div>
      <form onSubmit={applyText} className="flex flex-wrap items-center gap-2">
        <Input aria-label="Name" placeholder="Name" value={name} maxLength={200} onChange={(e) => setName(e.target.value)} className="h-8 w-40" />
        <Input aria-label="From" placeholder="From (address)" value={sender} maxLength={320} onChange={(e) => setSender(e.target.value)} className="h-8 w-48" />
        {accounts.length > 1 ? (
          <select
            aria-label="Account"
            value={filter.accountId ?? ""}
            onChange={(event) =>
              setFilter((prev) => {
                const out: FilesFilter = { ...prev };
                if (event.target.value === "") delete out.accountId;
                else out.accountId = event.target.value;
                return out;
              })
            }
            className="h-8 rounded-md border border-input bg-transparent px-2 text-sm"
          >
            <option value="">All accounts</option>
            {accounts.map((account) => (
              <option key={account.id} value={account.id}>
                {accountLabel(account)}
              </option>
            ))}
          </select>
        ) : null}
        <Button type="submit" variant="outline" size="sm" className="h-8">
          Filter
        </Button>
      </form>
      {problem !== null ? (
        <p role="alert" className="text-sm text-destructive">
          {problem}
        </p>
      ) : null}
      {files === null ? (
        <LoadingState label="Loading files\u2026" />
      ) : files.length === 0 ? (
        problem === null ? <p className="text-sm text-muted-foreground">No files here.</p> : null
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-xs text-muted-foreground">
              <tr>
                <th className="py-1 pr-2 font-medium">Name</th>
                <th className="py-1 pr-2 font-medium">Type</th>
                <th className="py-1 pr-2 font-medium">Size</th>
                <th className="py-1 pr-2 font-medium">From</th>
                <th className="py-1 pr-2 font-medium">Date</th>
                {accounts.length > 1 ? <th className="py-1 pr-2 font-medium">Account</th> : null}
                <th className="py-1 font-medium">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {files.map((file) => {
                const fileName = file.filename ?? "Unnamed attachment";
                return (
                  <tr key={`${file.messageId}:${file.partId}`} className="border-t border-border">
                    <td className="max-w-56 truncate py-1 pr-2 text-foreground" title={fileName}>
                      {fileName}
                    </td>
                    <td className="py-1 pr-2 text-muted-foreground">{KIND_TEXT[file.kind]}</td>
                    <td className="py-1 pr-2 tabular-nums text-muted-foreground">{formatFileSize(file.size)}</td>
                    <td className="max-w-40 truncate py-1 pr-2 text-muted-foreground">{addressLabel(file.from)}</td>
                    <td className="py-1 pr-2 text-muted-foreground">{formatListDate(file.date)}</td>
                    {accounts.length > 1 ? <td className="max-w-32 truncate py-1 pr-2 text-muted-foreground">{accountName(file.accountId)}</td> : null}
                    <td className="py-1">
                      <span className="flex items-center justify-end gap-0.5">
                        {viewable(file) ? (
                          <Button variant="ghost" size="icon" className="size-7" aria-label={`View ${fileName}`} onClick={() => onView(file)}>
                            <Icon name="Eye" fallback="Info" aria-hidden />
                          </Button>
                        ) : null}
                        <Button variant="ghost" size="icon" className="size-7" aria-label={`Download ${fileName}`} onClick={() => onDownload(file)}>
                          <Icon name="Download" fallback="Paperclip" aria-hidden />
                        </Button>
                        {onSave !== undefined ? (
                          <Button variant="ghost" size="icon" className="size-7" aria-label={`Save ${fileName} to project\u2026`} onClick={() => onSave(file)}>
                            <Icon name="FolderInput" fallback="Folder" aria-hidden />
                          </Button>
                        ) : null}
                        <Button variant="ghost" size="icon" className="size-7" aria-label={`Open the message of ${fileName}`} onClick={() => onOpenMessage(file)}>
                          <Icon name="Mail" aria-hidden />
                        </Button>
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {next !== null && files !== null ? (
        <div>
          <Button variant="outline" size="sm" disabled={loadingMore} onClick={() => void more()}>
            {loadingMore ? "Loading\u2026" : "Load more"}
          </Button>
        </div>
      ) : null}
    </section>
  );
}
