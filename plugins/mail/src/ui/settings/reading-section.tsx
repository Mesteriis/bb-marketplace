import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { tx } from "../i18n/index.ts";
import { type AttachmentTextStatus, type SettingsSearchPorts, attachmentTextLine, messageOf } from "./shared.ts";

export function SearchSection({ search, hint }: { search: SettingsSearchPorts; hint: string }) {
  const [status, setStatus] = useState<AttachmentTextStatus | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const reload = useCallback(async () => {
    try {
      setStatus(await search.loadStatus());
      setProblem(null);
    } catch (error) {
      setProblem(messageOf(error, "The status could not be loaded"));
    }
  }, [search]);
  useEffect(() => {
    void reload();
  }, [reload]);
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    try {
      await action();
    } catch (error) {
      setProblem(messageOf(error, "That did not work"));
    } finally {
      setBusy(false);
      void reload();
    }
  };
  const v = search.values;
  return (
    <div className="flex flex-col gap-4 text-sm">
      <section className="flex flex-col gap-1">
        <h3 className="font-medium text-foreground">{tx("Search and older mail")}</h3>
        <p className="text-muted-foreground">{tx("Load more days loads {historyStepDays} days at a time. Unopened server search results are kept {serverSearchKeepDays} days.", { historyStepDays: v.historyStepDays, serverSearchKeepDays: v.serverSearchKeepDays })}</p>
        <p className="text-muted-foreground">
          {v.indexAttachmentText
            ? tx("Search inside attachments is on: text and PDF attachments are read on this computer, and only your own search uses them.")
            : tx("Search inside attachments is off.")}
        </p>
        {v.indexAttachmentText && status !== null ? (
          <>
            <p className="text-muted-foreground">{attachmentTextLine(status)}</p>
            {status.full ? <p className="text-destructive">{tx("Attachment text index is full")}</p> : null}
          </>
        ) : null}
        {problem !== null ? (
          <p role="alert" className="text-destructive">
            {problem}
          </p>
        ) : null}
        <div className="flex flex-wrap gap-1">
          {v.indexAttachmentText && status !== null && status.failed > 0 ? (
            <Button variant="outline" size="sm" disabled={busy} onClick={() => void run(search.retry)}>
              {tx("Retry failed")}
            </Button>
          ) : null}
          {status !== null && status.indexed + status.skipped + status.failed + status.pending > 0 ? (
            <Button variant="outline" size="sm" disabled={busy} onClick={() => void run(search.clear)}>
              {tx("Remove attachment text")}
            </Button>
          ) : null}
        </div>
      </section>
      <section className="flex flex-col gap-1">
        <h3 className="font-medium text-foreground">{tx("Reading")}</h3>
        <p className="text-muted-foreground">{tx("Show mail as: {p1}", { p1: v.mailView === "plain" ? "Plain text" : "Original" })}</p>
        <p className="text-muted-foreground">{tx("Mail in dark mode: {p1}", { p1: v.darkMail === "adapt" ? "Adapt colors" : "Original colors" })}</p>
        <p className="text-muted-foreground">{tx("Hide quoted text in replies: {p1}", { p1: v.hideQuotes ? "On" : "Off" })}</p>
        <p className="text-muted-foreground">{tx("Remove tracking from links I open: {p1}", { p1: v.cleanLinks !== false ? "On" : "Off" })}</p>
      </section>
      <p className="text-xs text-muted-foreground">{hint}</p>
    </div>
  );
}
