import { useEffect, useState } from "react";
import type { CommitDetails, FileChange } from "../../core/history/model.ts";
import { ago } from "../../core/i18n/time.ts";
import { useLanguage, useT } from "../i18n/use-t.tsx";
import { Icon } from "../system/icon.tsx";
import { message, type HistoryApi } from "./history-api.ts";
import { PatchView } from "./patch-view.tsx";

const letters: Record<FileChange["status"], string> = {added: "A", conflicted: "U", copied: "C", deleted: "D", modified: "M", renamed: "R", "type-changed": "T", unknown: "?"};
const total = (files: FileChange[], key: "additions" | "deletions") => files.reduce((sum, file) => sum + (file[key] ?? 0), 0);

/**
 * A commit (or the working tree when `hash` is null): its subject and facts — the hash to copy, the author and when,
 * the parents, how much it changes — its files with their counts, and the chosen file's numbered diff.
 */
export function ChangeView({api, copyId, hash, uncommitted}: {api: HistoryApi; copyId: string; hash: string | null; uncommitted: FileChange[]}) {
  const t = useT();
  const {language} = useLanguage();
  const [details, setDetails] = useState<CommitDetails>();
  const [path, setPath] = useState<string | null>(null);
  const [patch, setPatch] = useState<{text: string; truncated: boolean}>();
  const [error, setError] = useState("");
  const [wrap, setWrap] = useState(false);
  const [copied, setCopied] = useState("");
  useEffect(() => {
    let active = true;
    setDetails(undefined); setPath(null); setError(""); setCopied("");
    if (hash) api.commit(copyId, hash).then(value => { if (active) setDetails(value); }, cause => { if (active) setError(message(cause)); });
    return () => { active = false; };
  }, [api, copyId, hash]);
  const files = hash ? details?.files : uncommitted;
  useEffect(() => {
    if (!files?.length) return;
    setPath(current => current && files.some(file => file.path === current) ? current : files[0]!.path);
  }, [files]);
  useEffect(() => {
    if (!path) return;
    let active = true;
    setPatch(undefined);
    setError("");
    api.patch(copyId, hash, path).then(text => { if (active) setPatch(text); }, cause => { if (active) setError(message(cause)); });
    return () => { active = false; };
  }, [api, copyId, hash, path]);
  const when = (at: string) => { const text = ago(language, Date.now(), at); return text === t("time.now") ? text : t("ci.ago", {when: text}); };
  const name = (file: string) => file.split("/").pop() ?? file;
  return <section className="git-history-change" aria-label={hash ? t("hs.commit") : t("hs.uncommitted")}>
    <header className="git-history-facts">
      <h2>{hash ? details?.subject ?? "" : t("hs.uncommitted")}</h2>
      {hash && details && <dl>
        <dt>{t("hs.f.commit")}</dt><dd><code>{details.hash.slice(0, 7)}</code>
          {api.copy && <button type="button" className="g-btn ghost sm" aria-label={t("hs.copy-hash")} title={t("hs.copy-hash")}
            onClick={() => void api.copy!(details.hash).then(done => setCopied(t(done ? "hs.copied" : "ci.copy-refused")), () => setCopied(t("ci.copy-refused")))}><Icon name="Copy" small/></button>}
          {copied && <span className="g-muted" role="status">{copied}</span>}</dd>
        <dt>{t("hs.f.author")}</dt><dd>{details.authorName} · <time dateTime={details.authorDate} title={details.authorDate.replace("T", " ").slice(0, 16)}>{when(details.authorDate)}</time></dd>
        <dt>{t("hs.f.parent", {n: details.parents.length})}</dt><dd>{details.parents.length ? details.parents.map(parent => <code key={parent}>{parent.slice(0, 7)}</code>) : "—"}</dd>
        <dt>{t("hs.f.changes")}</dt><dd>{t("hs.files", {n: details.files.length})} · <span className="g-good">+{total(details.files, "additions")}</span> <span className="g-bad">−{total(details.files, "deletions")}</span></dd>
      </dl>}
      {hash && details?.body && <pre className="git-history-body">{details.body}</pre>}
      {!hash && <p className="g-muted">{t("hs.files", {n: uncommitted.length})} · <span className="g-good">+{total(uncommitted, "additions")}</span> <span className="g-bad">−{total(uncommitted, "deletions")}</span></p>}
    </header>
    {hash && !details && !error && <p className="g-state-page" role="status">{t("hs.loading-commit")}</p>}
    {files && !files.length && <p className="g-state-page">{t(hash ? "hs.no-files" : "hs.clean")}</p>}
    {files && files.length > 0 && <ul className="git-history-files" aria-label={t("hs.changed-files")}>{files.map(file => {
      const slash = file.path.lastIndexOf("/");
      return <li key={file.path}><button type="button" aria-current={file.path === path ? "true" : undefined} onClick={() => setPath(file.path)}>
        <span className="git-history-status" data-status={file.status} title={file.status}>{letters[file.status]}</span>
        <span className="git-history-path"><span className="g-muted">{file.path.slice(0, slash + 1)}</span>{file.path.slice(slash + 1)}</span>
        {file.additions === null ? <span className="g-muted">{t("hs.binary")}</span> : <span className="g-num">
          {file.additions > 0 && <span className="g-good">+{file.additions}</span>} {file.deletions! > 0 && <span className="g-bad">−{file.deletions}</span>}</span>}
      </button></li>;
    })}</ul>}
    {error && <div className="g-banner bad" role="alert">{error}</div>}
    {path && <div className="git-history-file">
      <div className="git-history-file-head"><Icon name="FileDiff" small/><strong title={path}>{name(path)}</strong>
        <button type="button" className="g-btn ghost sm" aria-pressed={wrap} onClick={() => setWrap(value => !value)}><Icon name="TextWrap" small/>{t("pr.wrap")}</button></div>
      {patch === undefined ? !error && <p className="g-state-page" role="status">{t("hs.loading-patch")}</p>
        : <PatchView text={patch.text} path={path} wrap={wrap} truncated={patch.truncated} label={t("hs.patch-of", {path})}/>}
    </div>}
  </section>;
}
