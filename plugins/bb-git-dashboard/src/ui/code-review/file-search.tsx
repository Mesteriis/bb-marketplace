import { useEffect, useState } from "react";
import { message } from "./review-api.ts";

/** The Any file view's search: type part of a path, pick a file to show it. */
export function FileSearch({search, onPick}: {search(query: string): Promise<{paths: string[]; more: boolean}>; onPick(path: string): Promise<void>}) {
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<{paths: string[]; more: boolean} | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    const timer = setTimeout(() => {
      search(query).then(result => { if (active) { setFound(result); setError(""); } }, cause => { if (active) setError(message(cause)); });
    }, 250);
    return () => { active = false; clearTimeout(timer); };
  }, [query, search]);
  const pick = (path: string) => { onPick(path).catch(cause => setError(message(cause))); };
  return <div className="git-stack git-code-review-file-search" role="search" aria-label="Find a file">
    <input aria-label="File to show" placeholder="Part of a file's path" value={query} onChange={event => setQuery(event.target.value)}/>
    {found && <ul className="git-stack">
      {found.paths.map(path => <li key={path}><button type="button" className="git-link git-path" onClick={() => pick(path)}>{path}</button></li>)}
      {!found.paths.length && <li className="git-muted">No file matches.</li>}
      {found.more && <li className="git-muted">More files match; type more of the path.</li>}
    </ul>}
    {error && <p className="git-error" role="alert">{error}</p>}
  </div>;
}
