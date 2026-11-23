import { useEffect, useState } from "react";
import { useSdk, type PluginBrowserBbSdk } from "@get-bb/plugin-sdk/app";

type Event = Awaited<ReturnType<PluginBrowserBbSdk["threads"]["events"]["list"]>>[number];
const pageSize = 30;

function content(event: Event) {
  if (event.type === "item/completed") {
    const item = event.data.item;
    if (item.type === "reasoning") return "";
    if (item.type === "agentMessage") return item.text;
    if (item.type === "planSteps") return item.steps.map(step => step.step + " · " + (step.status ?? "—")).join("\n");
    if (item.type === "commandExecution") return [
      item.command, item.exitCode !== undefined ? "Код выхода " + item.exitCode : item.status,
      item.aggregatedOutput,
    ].filter(Boolean).join("\n");
    if (item.type === "fileChange") return item.changes.map(change =>
      [change.path, change.diff ?? "Diff отсутствует в событии"].join("\n")).join("\n\n");
  }
  if (event.type === "turn/diff/updated") return event.data.diff ?? "";
  if (event.type === "turn/plan/updated") return event.data.explanation ?? "";
  if (event.type === "turn/completed") return event.data.error?.message ?? event.data.status;
  return "";
}

export function Evidence({ threadId, seq, onClose }: { threadId: string; seq: number; onClose(): void }) {
  const sdk = useSdk();
  const [row, setRow] = useState<Event | null>();
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    void sdk.threads.events.list({
      threadId, afterSeq: String(seq - 1), limit: "1", order: "asc", signal,
    }).then(([event]) => {
      if (!signal.aborted) setRow(event?.seq === seq ? event : null);
    }, () => { if (!signal.aborted) setFailed(true); });
    return () => controller.abort();
  }, [sdk, seq, threadId]);

  const detail = row ? content(row) : "";
  return (
    <section className="tc-evidence" aria-label={"Источник " + seq}>
      <div className="tc-heading">
        <h3>Событие #{seq}</h3>
        <button onClick={onClose}>Закрыть источник</button>
      </div>
      {failed || row === null ? <p role="status">Источник недоступен.</p> :
        row === undefined ? <p role="status">Открываю источник…</p> :
          <>
            <p className="tc-muted">{row.type} · {new Date(row.createdAt).toLocaleString()}</p>
            {detail && <pre>{detail.slice(0, 32_000)}{detail.length > 32_000 && "\n… Показано начало"}</pre>}
          </>}
    </section>
  );
}

export function Journal({ threadId, openSource }: { threadId: string; openSource(seq: number): void }) {
  const sdk = useSdk();
  const [cursors, setCursors] = useState<number[]>([]);
  const [page, setPage] = useState<Event[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [revision, setRevision] = useState(0);
  const before = cursors.at(-1);

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    setLoading(true);
    setFailed(false);
    void sdk.threads.events.list({
      threadId, limit: String(pageSize), order: "desc", signal,
      ...(before === undefined ? {} : { beforeSeq: String(before) }),
    }).then(result => {
      if (!signal.aborted) {
        setPage(result);
        setLoading(false);
      }
    }, () => {
      if (!signal.aborted) {
        setFailed(true);
        setLoading(false);
      }
    });
    return () => controller.abort();
  }, [before, revision, sdk, threadId]);

  return (
    <section aria-label="Технический журнал">
      <div className="tc-heading">
        <button disabled={loading || !cursors.length} onClick={() => setCursors(path => path.slice(0, -1))}>Новее</button>
        <button disabled={loading} onClick={() => { setCursors([]); setRevision(value => value + 1); }}>Последние</button>
        <button disabled={loading || failed || page.length < pageSize} onClick={() => setCursors(path => [...path, page.at(-1)!.seq])}>Старее</button>
      </div>
      {loading ? <p role="status">Загружаю страницу…</p> : failed ? <p role="status">Журнал недоступен.</p> :
        <ol className="tc-list">
          {page.filter(row => !row.type.startsWith("item/reasoning/") &&
            !((row.type === "item/started" || row.type === "item/completed") && row.data.item.type === "reasoning"))
            .map(row => <li key={row.seq}>
              <button onClick={() => openSource(row.seq)}>#{row.seq} · {row.type}</button>
            </li>)}
        </ol>}
    </section>
  );
}
