import { useEffect, useRef, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { SearchItem } from "../core/contract";
import { isNewerVersion } from "../core/inventory";
import { messageOf, type CatalogApi, type Notify, type Setup } from "./api";
import { Badge, Centered, Notice, Row } from "./parts";

const SOURCE_LABEL: Record<SearchItem["versions"][number]["sources"][number], string> = {
  npm: "npm",
  pypi: "PyPI",
  docker: "Docker",
  remote: "удалённый адрес",
};

type Results =
  | { kind: "idle" }
  | { kind: "loading"; items: SearchItem[] }
  | { kind: "error"; message: string; items: SearchItem[] }
  | { kind: "ready"; items: SearchItem[]; nextCursor: string | null; warning: string | null };

/** A name can straddle two registry pages: its versions are merged into one row. */
function mergeItems(previous: SearchItem[], next: SearchItem[]): SearchItem[] {
  const merged = previous.map((item) => ({ ...item }));
  for (const item of next) {
    const at = merged.findIndex((existing) => existing.name === item.name);
    const existing = merged[at];
    if (existing === undefined) {
      merged.push(item);
      continue;
    }
    const versions = [...existing.versions];
    for (const version of item.versions) if (!versions.some((known) => known.version === version.version)) versions.push(version);
    versions.sort((a, b) => (isNewerVersion(a.version, b.version) ? -1 : isNewerVersion(b.version, a.version) ? 1 : 0));
    merged[at] = {
      ...existing,
      versions,
      latestVersion: isNewerVersion(item.latestVersion, existing.latestVersion) ? item.latestVersion : existing.latestVersion,
      installed: existing.installed || item.installed,
      inCollection: existing.inCollection || item.inCollection,
      reviewing: existing.reviewing || item.reviewing,
    };
  }
  return merged;
}

interface Props {
  api: CatalogApi;
  notify: Notify;
  tick: number;
  onChanged: () => void;
  setup: Setup;
}

export function SearchTab({ api, notify, tick, onChanged, setup }: Props) {
  const [text, setText] = useState("");
  const [submitted, setSubmitted] = useState<string | null>(null);
  const [results, setResults] = useState<Results>({ kind: "idle" });
  const [chosen, setChosen] = useState<Record<string, string>>({});
  const [busyName, setBusyName] = useState<string | null>(null);
  const latest = useRef(0);

  const run = async (query: string, cursor?: string, keep: SearchItem[] = []) => {
    const id = ++latest.current;
    setResults({ kind: "loading", items: keep });
    try {
      const page = await api.search(query, cursor);
      if (id !== latest.current) return;
      setResults({ kind: "ready", items: mergeItems(keep, page.items), nextCursor: page.nextCursor, warning: page.warning });
    } catch (error) {
      if (id === latest.current) setResults({ kind: "error", message: messageOf(error), items: keep });
    }
  };

  // «Обновить» re-runs the last query.
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    if (submitted !== null) void run(submitted);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const query = text.trim();
    if (query === "") return;
    setSubmitted(query);
    setChosen({});
    void run(query);
  };

  const review = async (item: SearchItem, version: string) => {
    setBusyName(item.name);
    try {
      const started = await api.startReview({ name: item.name, version });
      if (started.state === "failed") notify("error", started.error ?? "Проверка не запустилась");
      else notify("success", "Проверка запущена: ход виден во вкладке «Коллекция»");
      onChanged();
    } catch (error) {
      notify("error", messageOf(error));
    } finally {
      setBusyName(null);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <form role="search" className="flex gap-2 px-4 pt-3" onSubmit={submit}>
        <Input aria-label="Запрос в реестр" placeholder="Поиск в реестре MCP" value={text} onChange={(event) => setText(event.target.value)} className="h-8" />
        <Button type="submit" size="sm" disabled={text.trim() === "" || results.kind === "loading"}>
          Найти
        </Button>
      </form>
      {results.kind === "idle" && <Centered>Введите запрос: имя или тема сервера.</Centered>}
      {results.kind === "loading" && results.items.length === 0 && <Centered>Загрузка…</Centered>}
      {results.kind === "error" && (
        <Centered>
          <p className="text-destructive">{results.message}</p>
          {submitted !== null && (
            <Button variant="outline" size="sm" onClick={() => void run(submitted)}>
              Повторить
            </Button>
          )}
        </Centered>
      )}
      {results.kind === "ready" && results.warning !== null && (
        <div className="px-4">
          <Notice>{results.warning}</Notice>
        </div>
      )}
      {results.kind === "ready" && results.items.length === 0 && <Centered>Ничего не найдено</Centered>}
      {results.kind !== "idle" && results.items.length > 0 && (
        <ul>
          {results.items.map((item) => {
            const selected = chosen[item.name] ?? item.latestVersion;
            const version = item.versions.find((candidate) => candidate.version === selected) ?? item.versions[0];
            if (version === undefined) return null;
            return (
              <Row key={item.name}>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="min-w-0 truncate text-sm font-medium">{item.name}</span>
                  <select
                    aria-label={`Версия ${item.name}`}
                    className="h-7 rounded-md border border-input bg-transparent px-1.5 text-xs"
                    value={version.version}
                    onChange={(event) => setChosen((current) => ({ ...current, [item.name]: event.target.value }))}
                  >
                    {item.versions.map((candidate) => (
                      <option key={candidate.version} value={candidate.version}>
                        {candidate.version}
                      </option>
                    ))}
                  </select>
                  {version.sources.map((source) => (
                    <Badge key={source}>{SOURCE_LABEL[source]}</Badge>
                  ))}
                  {version.publishedAt !== null && <span className="text-xs text-muted-foreground">{version.publishedAt.slice(0, 10)}</span>}
                  {item.installed && <Badge>уже стоит</Badge>}
                  {item.inCollection && <Badge>в коллекции</Badge>}
                  {item.reviewing && <Badge>проверяется</Badge>}
                  <Button
                    className="ml-auto"
                    size="sm"
                    variant="outline"
                    disabled={busyName !== null || item.reviewing || !setup.repo || !setup.project}
                    onClick={() => void review(item, version.version)}
                  >
                    Проверить
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">{version.description}</p>
              </Row>
            );
          })}
        </ul>
      )}
      {results.kind === "ready" && results.nextCursor !== null && submitted !== null && (
        <div className="flex justify-center pb-3">
          <Button variant="outline" size="sm" onClick={() => void run(submitted, results.nextCursor ?? undefined, results.items)}>
            Ещё
          </Button>
        </div>
      )}
    </div>
  );
}
