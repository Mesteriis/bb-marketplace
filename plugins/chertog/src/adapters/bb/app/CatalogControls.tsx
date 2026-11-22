import { useRef, useState } from "react";
import { classes } from "../../../ui/chrome/primitives.tsx";
import type { WorkspaceFileCatalog } from "./file-preview-source.tsx";
import type { createDiffSource } from "./diff-source.tsx";

type Revisions = Pick<ReturnType<typeof createDiffSource>, "loadRevisions" | "selectRevisions">;

export function CatalogControls({ catalog, diff }: { catalog: WorkspaceFileCatalog; diff?: Revisions }) {
  const [environments, setEnvironments] = useState<Awaited<ReturnType<typeof catalog.listEnvironments>>>([]);
  const [query, setQuery] = useState("");
  const [env, setEnv] = useState("");
  const [revisions, setRevisions] = useState<readonly string[]>([]);
  const [pair, setPair] = useState(["", ""]);
  const [message, setMessage] = useState("");
  const generation = useRef(0);
  async function list() {
    const turn = ++generation.current;
    setMessage("Загрузка сред…");
    try {
      const rows = await catalog.listEnvironments();
      if (turn !== generation.current) return;
      setEnvironments(rows);
      setMessage(rows.length ? "" : "Нет доступных рабочих сред.");
    } catch {
      if (turn === generation.current) setMessage("BB отказал в доступе к списку сред.");
    }
  }
  async function select(id: string) {
    const turn = ++generation.current;
    setEnv(id);
    setPair(["", ""]);
    setRevisions([]);
    setMessage("");
    await catalog.select(id, query);
    if (turn !== generation.current || !diff || catalog.selected !== id) return;
    const values = await diff.loadRevisions();
    if (turn !== generation.current) return;
    setRevisions(values);
    if (values.length < 2) setMessage("Для сравнения нужны две доступные ревизии.");
  }
  return <div className="flex flex-wrap items-center gap-1">
    <button type="button" className={classes.button} onClick={() => void list()}>Выбрать среду</button>
    {environments.length > 0 && <>
      <select className={classes.input} aria-label="Рабочая среда" value={env} onChange={event => void select(event.target.value)}>
        <option value="" disabled>Рабочая среда</option>
        {environments.map(row => <option key={row.id} value={row.id}>{row.name ?? row.path ?? row.id}</option>)}
      </select>
      <form className="flex min-w-0 items-center gap-1" onSubmit={event => { event.preventDefault(); if (env) void select(env); }}>
        <input className={classes.input} aria-label="Путь к файлу" placeholder="Путь к файлу" value={query} onChange={event => setQuery(event.target.value)} />
        <button type="submit" className={classes.button} disabled={!env}>Найти</button>
      </form>
    </>}
    {diff && revisions.length > 1 && ["Исходная ревизия", "Конечная ревизия"].map((label, index) =>
      <select key={label} aria-label={label} className={classes.input} value={pair[index]} onChange={event => {
        const next = [...pair];
        next[index] = event.target.value;
        setPair(next);
        diff.selectRevisions(next[0], next[1]);
      }}>
        <option value="" disabled>{label}</option>
        {revisions.map(sha => <option key={sha} value={sha}>{sha.slice(0, 12)}</option>)}
      </select>)}
    {message && <span role="status" className={classes.muted}>{message}</span>}
  </div>;
}
