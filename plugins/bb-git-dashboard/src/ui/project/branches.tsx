import { useMemo, useState } from "react";
import type { GitAction, GitResult } from "../../core/git.ts";
import { branchRows } from "../../core/merge/branches.ts";
import { useT } from "../i18n/use-t.tsx";
import { BranchList, type Sequence } from "../merge/merge-actions.tsx";
import { Dialog } from "../system/dialog.tsx";
import { Icon } from "../system/icon.tsx";

type RunGit = (action: GitAction) => Promise<GitResult>;

/** Branches: search, local or remote, the comparison of two branches, the table, and Create branch in a dialog. */
export function Branches({text, state, sequence, run, pending, act, onChanged, onError, creating, onCreating}: {text: string; state: GitResult;
  sequence: Sequence | null; run: RunGit; pending: boolean; act(action: GitAction): Promise<boolean>; onChanged(result: GitResult): void;
  onError(cause: unknown): void; creating: boolean; onCreating(open: boolean): void}) {
  const t = useT();
  const rows = useMemo(() => branchRows(text), [text]);
  const [remote, setRemote] = useState(false);
  const [query, setQuery] = useState("");
  const names = rows.map(row => row.name);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [compared, setCompared] = useState<{base: string; head: string; text: string} | null>(null);
  const base = from || (rows.find(row => !row.remote && row.name === state.branch)?.upstream ?? names.find(name => name === "main") ?? names[0] ?? "");
  const head = to || state.branch || names[0] || "";
  const shown = rows.filter(row => row.remote === remote && row.name.toLowerCase().includes(query.trim().toLowerCase()));
  const local = rows.filter(row => !row.remote).length;
  const compare = () => {
    const target = (name: string) => rows.find(row => row.name === name)?.target ?? name;
    run({kind: "compare", base: target(base), head: target(head)}).then(value => setCompared({base, head, text: value.text ?? ""}), onError);
  };
  return <div className="git-branches">
    <div className="git-branches-bar">
      <input className="g-inp" type="search" aria-label={t("br.search")} placeholder={t("br.search")} value={query} onChange={event => setQuery(event.target.value)}/>
      <div className="g-seg" role="group" aria-label={t("br.kind")}>
        <button type="button" aria-pressed={!remote} onClick={() => setRemote(false)}>{t("br.local")} <span className="g-num">{local}</span></button>
        <button type="button" aria-pressed={remote} onClick={() => setRemote(true)}>{t("br.remote")} <span className="g-num">{rows.length - local}</span></button>
      </div>
      <span className="git-branches-compare">
        <select className="g-inp" aria-label={t("br.compare-base")} value={base} onChange={event => setFrom(event.target.value)}>
          {names.map(name => <option key={name} value={name}>{name}</option>)}</select>
        <Icon name="ArrowRight" small/>
        <select className="g-inp" aria-label={t("br.compare-head")} value={head} onChange={event => setTo(event.target.value)}>
          {names.map(name => <option key={name} value={name}>{name}</option>)}</select>
        <button type="button" className="g-btn" disabled={!base || !head || base === head} onClick={compare}>{t("br.compare")}</button>
      </span>
    </div>
    {compared && <section className="git-branches-compared" aria-label={t("br.compared", compared)}>
      <header><strong className="g-mono">{t("br.compared", compared)}</strong>
        <button type="button" className="g-btn ghost sm" onClick={() => setCompared(null)}>{t("br.close")}</button></header>
      <pre className="git-changes-plain">{compared.text || t("pg.no-diff")}</pre>
    </section>}
    {shown.length ? <BranchList rows={shown} state={state} sequence={sequence} run={run} now={Date.now()} pending={pending} onChanged={onChanged} onError={onError}
      onSwitch={branch => void act({kind: "switch", branch})}/> : <p className="g-muted git-branches-note">{t("br.none")}</p>}
    {creating && <CreateBranch rows={rows} current={state.branch ?? null} head={state.head ?? null} act={act} onClose={() => onCreating(false)}/>}
  </div>;
}

function CreateBranch({rows, current, head, act, onClose}: {rows: ReturnType<typeof branchRows>; current: string | null; head: string | null;
  act(action: GitAction): Promise<boolean>; onClose(): void}) {
  const t = useT();
  const [name, setName] = useState("");
  const [from, setFrom] = useState(current ?? "");
  const [switchTo, setSwitchTo] = useState(true);
  const [busy, setBusy] = useState(false);
  const base = rows.find(row => row.name === from)?.target ?? head ?? "";
  const create = async () => {
    setBusy(true);
    const made = await act({kind: "branch", branch: name.trim(), base});
    if (made && switchTo) await act({kind: "switch", branch: name.trim()});
    setBusy(false);
    if (made) onClose();
  };
  return <Dialog title={t("br.create-title")} busy={busy} onClose={onClose} actions={<>
    <button type="button" className="g-btn" disabled={busy} onClick={onClose}>{t("common.cancel")}</button>
    <button type="button" className="g-btn pri" disabled={busy || !name.trim() || !base} onClick={() => void create()}>{t("br.create")}</button>
  </>}>
    <label>{t("br.name")}<input className="g-inp" value={name} autoFocus onChange={event => setName(event.target.value)}/></label>
    <label>{t("br.base")}<select className="g-inp" value={from} onChange={event => setFrom(event.target.value)}>
      {!current && <option value="">HEAD</option>}{rows.map(row => <option key={row.ref} value={row.name}>{row.name}</option>)}</select></label>
    <label className="git-dialog-check"><input type="checkbox" checked={switchTo} onChange={event => setSwitchTo(event.target.checked)}/>{t("br.switch-after")}</label>
  </Dialog>;
}
