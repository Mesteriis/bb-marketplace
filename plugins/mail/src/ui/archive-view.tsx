// The Local archive page (slice 3p, #95): old mail read from files on this
// machine with `bb makosh-mail archive add`, kept apart from every mailbox.
// Read-only: a list, a search and one message at a time, in the reading
// frame live mail uses (the same sanitizer, remote images off until asked).
// There is no sender check here, and the page says so. Everything from a
// message is rendered as text or through the sanitizer.
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import type { ArchiveMessageView, ArchiveSummaryView, ArchiveView } from "../core/contract.ts";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { shownText } from "./agent-send-card.tsx";
import { FIELD_CLASS } from "./bb-ports.ts";
import { MessageFrame } from "./message-frame.tsx";
import { formatSize } from "../core/headers.ts";
import { dateLocale, tx, txn } from "./i18n/index.ts";

type Cursor = { date: string | null; id: string };

export interface ArchivePorts {
  archives: () => Promise<ArchiveView[]>;
  messages: (archiveId: string | null, query: string, cursor: Cursor | null) => Promise<{ rows: ArchiveSummaryView[]; nextCursor: Cursor | null }>;
  message: (id: string) => Promise<ArchiveMessageView>;
  /** Saves one attachment, read from the archive's source file. */
  download: (id: string, partId: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
}

export interface ArchiveViewProps {
  ports: ArchivePorts;
  onOpenLink: (url: string, text?: string | null) => void;
  /** Bumped when archives may have changed (an import finished in the terminal). */
  refresh?: number;
}

export const ARCHIVE_ADD_COMMAND = "bb makosh-mail archive add /full/path/old.mbox";

const messageOf = (error: unknown, fallback: string) => tx(error instanceof Error && error.message !== "" ? error.message : fallback);

function whenText(iso: string | null): string {
  if (iso === null) return tx("no date");
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return tx("no date");
  return date.toLocaleDateString(dateLocale(), { day: "numeric", month: "short", year: "numeric" });
}

const person = (entry: { name: string | null; address: string }) =>
  entry.name === null || entry.name === "" ? entry.address : `${shownText(entry.name)} <${entry.address}>`;

export function ArchiveViewPage({ ports, onOpenLink, refresh = 0 }: ArchiveViewProps) {
  const [archives, setArchives] = useState<ArchiveView[] | null>(null);
  const [archiveId, setArchiveId] = useState<string | null>(null);
  const [typed, setTyped] = useState("");
  const [query, setQuery] = useState("");
  const [rows, setRows] = useState<ArchiveSummaryView[] | null>(null);
  const [next, setNext] = useState<Cursor | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const token = useRef(0);

  const loadArchives = useCallback(async () => {
    try {
      const found = await ports.archives();
      setArchives(found);
      setArchiveId((current) => (current !== null && !found.some((archive) => archive.id === current) ? null : current));
    } catch (error) {
      setArchives([]);
      setProblem(messageOf(error, "The archives could not be loaded"));
    }
  }, [ports]);
  useEffect(() => {
    void loadArchives();
  }, [loadArchives, refresh]);

  const reload = useCallback(async () => {
    const mine = ++token.current;
    setRows(null);
    setNext(null);
    setProblem(null);
    try {
      const page = await ports.messages(archiveId, query, null);
      if (mine !== token.current) return;
      setRows(page.rows);
      setNext(page.nextCursor);
    } catch (error) {
      if (mine !== token.current) return;
      setRows([]);
      setProblem(messageOf(error, "The archive could not be read"));
    }
  }, [archiveId, ports, query]);
  useEffect(() => {
    void reload();
  }, [reload, refresh]);

  const more = async () => {
    if (next === null || loadingMore) return;
    const mine = token.current;
    setLoadingMore(true);
    try {
      const page = await ports.messages(archiveId, query, next);
      if (mine !== token.current) return;
      setRows((prev) => [...(prev ?? []), ...page.rows]);
      setNext(page.nextCursor);
    } catch (error) {
      setProblem(messageOf(error, "The archive could not be read"));
    } finally {
      setLoadingMore(false);
    }
  };

  const search = (event: FormEvent) => {
    event.preventDefault();
    setQuery(typed.trim());
  };

  const remove = async (id: string) => {
    setRemoving(null);
    try {
      await ports.remove(id);
      await loadArchives();
      await reload();
    } catch (error) {
      setProblem(messageOf(error, "The archive could not be removed"));
    }
  };

  if (openId !== null) {
    return <ArchiveMessagePane id={openId} ports={ports} onOpenLink={onOpenLink} onBack={() => setOpenId(null)} />;
  }

  const shown = archives?.find((archive) => archive.id === archiveId) ?? null;
  const nameOf = (id: string) => archives?.find((archive) => archive.id === id)?.name ?? null;
  return (
    <section aria-label={tx("Local archive")} className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-3">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="min-w-0 flex-1 text-sm font-semibold text-foreground">{tx("Local archive")}</h2>
        {archives !== null && archives.length > 0 ? (
          <select
            aria-label={tx("Which archive")}
            className={cn(FIELD_CLASS, "h-8 w-auto max-w-64")}
            value={archiveId ?? ""}
            onChange={(event) => setArchiveId(event.target.value === "" ? null : event.target.value)}
          >
            <option value="">{tx("All archives")}</option>
            {archives.map((archive) => (
              <option key={archive.id} value={archive.id}>
                {shownText(archive.name)}
              </option>
            ))}
          </select>
        ) : null}
      </div>
      <p className="text-xs text-muted-foreground">
        {tx(
          "Old mail read from files on this computer. It is not in any mailbox, is never uploaded or sent, and agents cannot read it. Senders here are not verified: treat a message as you would a letter of unknown origin.",
        )}
      </p>
      {problem !== null ? (
        <p role="alert" className="text-sm text-destructive">
          {problem}
        </p>
      ) : null}
      {archives !== null && archives.length === 0 ? (
        <div className="flex flex-col gap-1 rounded-md border border-border p-3 text-sm">
          <p className="text-foreground">{tx("No archives yet.")}</p>
          <p className="text-muted-foreground">{tx("To add one, run this in a terminal with the path of an mbox file, an .eml file or a folder of .eml files:")}</p>
          <code className="break-all rounded-sm bg-muted px-1.5 py-1 font-mono text-xs text-foreground">{ARCHIVE_ADD_COMMAND}</code>
        </div>
      ) : null}
      {shown !== null ? (
        <div role="group" aria-label={tx("About this archive")} className="flex flex-col gap-1 rounded-md border border-border px-3 py-2 text-xs text-muted-foreground">
          <p>
            {txn(shown.messages, "{count} message", "{count} messages")}
            {shown.skipped > 0 ? ` \u00b7 ${tx("{count} left out", { count: shown.skipped })}` : ""}
            {!shown.complete ? ` \u00b7 ${tx("The import did not finish; run the same command again to go on.")}` : ""}
          </p>
          <p className="break-all">
            {tx("Read from")} <span className="font-mono">{shown.sourcePath}</span>
          </p>
          {removing === shown.id ? (
            <div className="flex flex-wrap items-center gap-2 text-foreground">
              <span className="min-w-0 flex-1">{tx("Remove this archive from Mail? The file it was read from stays.")}</span>
              <Button variant="ghost" size="sm" className="h-7 px-2" autoFocus onClick={() => setRemoving(null)}>
                {tx("Cancel")}
              </Button>
              <Button variant="outline" size="sm" className="h-7 px-2" onClick={() => void remove(shown.id)}>
                {tx("Remove archive")}
              </Button>
            </div>
          ) : (
            <Button variant="ghost" size="sm" className="h-6 self-start px-2 text-xs" onClick={() => setRemoving(shown.id)}>
              {tx("Remove archive")}
            </Button>
          )}
        </div>
      ) : null}
      {archives !== null && archives.length > 0 ? (
        <form role="search" aria-label={tx("Search the archive")} onSubmit={search} className="flex items-center gap-2">
          <Input
            aria-label={tx("Search the archive")}
            placeholder={tx("Subject, sender or words of the text")}
            value={typed}
            maxLength={200}
            onChange={(event) => setTyped(event.target.value)}
            className="h-8"
          />
          <Button type="submit" variant="outline" size="sm" className="h-8">
            {tx("Search")}
          </Button>
          {query !== "" ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-8"
              onClick={() => {
                setTyped("");
                setQuery("");
              }}
            >
              {tx("Clear")}
            </Button>
          ) : null}
        </form>
      ) : null}
      {archives !== null && archives.length > 0 ? (
        rows === null ? (
          <p className="text-sm text-muted-foreground">{tx("Loading\u2026")}</p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">{query === "" ? tx("This archive has no messages.") : tx("Nothing in the archive matches.")}</p>
        ) : (
          <ul aria-label={tx("Archive messages")} className="flex flex-col divide-y divide-border rounded-md border border-border">
            {rows.map((row) => (
              <li key={row.id}>
                <button
                  type="button"
                  onClick={() => setOpenId(row.id)}
                  className="flex w-full flex-col gap-0.5 px-3 py-2 text-left transition-colors hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
                >
                  <span className="flex min-w-0 items-baseline gap-2">
                    <span className="min-w-0 flex-1 truncate text-sm text-foreground">{person(row.from)}</span>
                    {row.hasAttachments ? <Icon name="Paperclip" className="size-3.5 shrink-0 text-muted-foreground" aria-label={tx("Has attachments")} /> : null}
                    <span className="shrink-0 text-xs text-muted-foreground">{whenText(row.date)}</span>
                  </span>
                  <span className="truncate text-sm text-foreground">{row.subject === "" ? tx("(no subject)") : shownText(row.subject)}</span>
                  <span className="truncate text-xs text-muted-foreground">
                    {archiveId === null && archives.length > 1 && nameOf(row.archiveId) !== null ? `${shownText(nameOf(row.archiveId)!)} \u00b7 ` : ""}
                    {row.snippet}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )
      ) : null}
      {next !== null ? (
        <Button variant="outline" size="sm" className="self-center" disabled={loadingMore} onClick={() => void more()}>
          {tx("Show more")}
        </Button>
      ) : null}
    </section>
  );
}

function ArchiveMessagePane({
  id,
  ports,
  onOpenLink,
  onBack,
}: {
  id: string;
  ports: ArchivePorts;
  onOpenLink: (url: string, text?: string | null) => void;
  onBack: () => void;
}) {
  const [message, setMessage] = useState<ArchiveMessageView | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [images, setImages] = useState(false);
  const [saving, setSaving] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setMessage(null);
    setProblem(null);
    setImages(false);
    ports.message(id).then(
      (found) => {
        if (live) setMessage(found);
      },
      (error: unknown) => {
        if (live) setProblem(messageOf(error, "The message could not be read"));
      },
    );
    return () => {
      live = false;
    };
  }, [id, ports]);

  const download = async (partId: string) => {
    setSaving(partId);
    setProblem(null);
    try {
      await ports.download(id, partId);
    } catch (error) {
      setProblem(messageOf(error, "The attachment could not be read from the archive's file"));
    } finally {
      setSaving(null);
    }
  };

  const files = message?.attachments.filter((attachment) => !attachment.isInline) ?? [];
  return (
    <section aria-label={tx("Archive message")} className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-3">
      <Button variant="ghost" size="sm" className="h-7 self-start px-2" onClick={onBack}>
        <Icon name="ArrowLeft" fallback="Check" aria-hidden />
        {tx("Back to the archive")}
      </Button>
      {problem !== null ? (
        <p role="alert" className="text-sm text-destructive">
          {problem}
        </p>
      ) : null}
      {message === null ? (
        problem === null ? (
          <p className="text-sm text-muted-foreground">{tx("Loading\u2026")}</p>
        ) : null
      ) : (
        <>
          <h2 className="break-words text-base font-semibold text-foreground">{message.subject === "" ? tx("(no subject)") : shownText(message.subject)}</h2>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-sm">
            <dt className="text-muted-foreground">{tx("From")}</dt>
            <dd className="break-words text-foreground">{person(message.from)}</dd>
            {message.to.length > 0 ? (
              <>
                <dt className="text-muted-foreground">{tx("To")}</dt>
                <dd className="break-words text-foreground">{message.to.map(person).join(", ")}</dd>
              </>
            ) : null}
            {message.cc.length > 0 ? (
              <>
                <dt className="text-muted-foreground">{tx("Cc")}</dt>
                <dd className="break-words text-foreground">{message.cc.map(person).join(", ")}</dd>
              </>
            ) : null}
            <dt className="text-muted-foreground">{tx("Date")}</dt>
            <dd className="text-foreground">
              {message.date === null ? tx("no date") : new Date(message.date).toLocaleString(dateLocale(), { dateStyle: "medium", timeStyle: "short" })}
            </dd>
          </dl>
          <p role="note" className="rounded-md border border-border bg-muted px-2 py-1 text-xs text-muted-foreground">
            {tx("From an archive: the sender is not verified, and you cannot reply from here.")}
          </p>
          {files.length > 0 ? (
            <ul aria-label={tx("Attachments")} className="flex flex-wrap gap-1.5">
              {files.map((attachment) => (
                <li key={attachment.partId}>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 max-w-72 px-2"
                    disabled={saving !== null}
                    aria-label={tx("Download {name}", { name: attachment.filename === null ? tx("attachment") : shownText(attachment.filename) })}
                    onClick={() => void download(attachment.partId)}
                  >
                    <Icon name="Paperclip" className="size-3.5 shrink-0" aria-hidden />
                    <span className="truncate">{attachment.filename === null ? tx("attachment") : shownText(attachment.filename)}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">{formatSize(attachment.size)}</span>
                  </Button>
                </li>
              ))}
            </ul>
          ) : null}
          <MessageFrame
            body={{ messageId: message.id, text: message.text, html: message.html, htmlTruncated: message.htmlTruncated, remoteImagesAllowed: false, codeBlocks: [] }}
            title={tx("Archive message")}
            onOpenLink={onOpenLink}
            remoteImages={images}
            onShowImages={() => setImages(true)}
            senderAddress={null}
            onAlwaysShowImages={() => undefined}
            senderTrusted={false}
            onStopImages={() => undefined}
          />
        </>
      )}
    </section>
  );
}
