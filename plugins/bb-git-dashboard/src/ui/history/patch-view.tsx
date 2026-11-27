import { useState } from "react";
import { patchStats } from "../../core/history/view.ts";

/** A unified diff with added and removed lines marked, its counts, a wrap switch and a note when it was cut. */
export function PatchView({text, label, truncated = false}: {text: string; label: string; truncated?: boolean}) {
  const [wrap, setWrap] = useState(false);
  if (!text.trim()) return <p className="git-muted">No textual change.</p>;
  const {added, removed} = patchStats(text);
  return <div className="git-stack">
    <div className="git-row git-history-patch-head">
      <span><span className="git-added">+{added}</span> <span className="git-removed">−{removed}</span></span>
      <label className="git-row"><input type="checkbox" checked={wrap} onChange={event => setWrap(event.target.checked)}/> Wrap long lines</label>
    </div>
    <pre className="git-code git-history-patch" aria-label={label} data-wrap={wrap || undefined}>{text.replace(/\n$/, "").split("\n").map((line, index) =>
      <span key={index} className={line.startsWith("+") && !line.startsWith("+++") ? "git-added" : line.startsWith("-") && !line.startsWith("---") ? "git-removed"
        : line.startsWith("@@") ? "git-muted" : undefined}>{line + "\n"}</span>)}</pre>
    <p className="git-muted">{added + removed} changed line{added + removed === 1 ? "" : "s"}{truncated ? " shown · the patch was cut at 1.5 MB" : ""}</p>
  </div>;
}
