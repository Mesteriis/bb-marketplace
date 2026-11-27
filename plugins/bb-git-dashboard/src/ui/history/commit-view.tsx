import { useEffect, useState } from "react";
import type { CommitDetails, FileChange } from "../../core/history/model.ts";
import { message, type HistoryApi } from "./history-api.ts";
import { PatchView } from "./patch-view.tsx";

const counts = (file: FileChange) => file.additions === null ? "binary" : "+" + file.additions + " −" + file.deletions;

/** Files of a commit, or of the working tree when `hash` is null, and the selected file's patch. */
export function ChangeView({api, copyId, hash, uncommitted}: {api: HistoryApi; copyId: string; hash: string | null; uncommitted: FileChange[]}) {
  const [details, setDetails] = useState<CommitDetails>();
  const [path, setPath] = useState<string | null>(null);
  const [patch, setPatch] = useState<{text: string; truncated: boolean}>();
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    setDetails(undefined); setPath(null); setError("");
    if (hash) api.commit(copyId, hash).then(value => { if (active) setDetails(value); }, cause => { if (active) setError(message(cause)); });
    return () => { active = false; };
  }, [api, copyId, hash]);
  const files = hash ? details?.files : uncommitted;
  useEffect(() => {
    if (!files?.length) return;
    setPath(current => current && files.some(file => file.path === current) ? current : files[0].path);
  }, [files]);
  useEffect(() => {
    if (!path) return;
    let active = true;
    setPatch(undefined);
    setError("");
    api.patch(copyId, hash, path).then(text => { if (active) setPatch(text); }, cause => { if (active) setError(message(cause)); });
    return () => { active = false; };
  }, [api, copyId, hash, path]);
  return <section className="git-stack git-history-change" aria-label={hash ? "Commit" : "Uncommitted changes"}>
    {hash && details && <header className="git-stack">
      <h3>{details.subject}</h3>
      <p className="git-muted"><code>{details.hash.slice(0, 12)}</code> · {details.authorName} · <time dateTime={details.authorDate}>{details.authorDate.replace("T", " ").slice(0, 16)}</time>
        {details.parents.length > 1 && " · merge of " + details.parents.length + " parents"}</p>
      {details.body && <pre className="git-history-body">{details.body}</pre>}
    </header>}
    {!hash && <h3>Uncommitted changes</h3>}
    {hash && !details && !error && <p className="git-muted" role="status">Loading commit…</p>}
    {files && !files.length && <p className="git-muted">{hash ? "This commit changes no files against its first parent." : "The working tree is clean."}</p>}
    {files && files.length > 0 && <ul className="git-history-files" aria-label="Changed files">{files.map(file => <li key={file.path}>
      <button type="button" aria-current={file.path === path ? "true" : undefined} onClick={() => setPath(file.path)}>
        <span className="git-history-status" data-status={file.status}>{file.status}</span> <span className="git-path">{file.path}</span>
        <span className="git-muted"> {counts(file)}</span></button></li>)}</ul>}
    {error && <p className="git-error" role="alert">{error}</p>}
    {path && (patch === undefined ? !error && <p className="git-muted" role="status">Loading patch…</p> : <PatchView text={patch.text} truncated={patch.truncated} label={"Patch of " + path}/>)}
  </section>;
}
