import { useMemo } from "react";
import { parsePatch } from "../../core/pulls/diff.ts";
import { CodeText, useHighlight } from "../highlight/use-highlight.tsx";
import { useT } from "../i18n/use-t.tsx";
import "../review/review.css";

/** The patch from its first hunk: git's own header lines (diff --git, ---, +++) are no rows of the diff. */
const fromFirstHunk = (text: string) => text.startsWith("@@") ? text : text.includes("\n@@") ? text.slice(text.indexOf("\n@@") + 1) : "";

/**
 * One file's patch as numbered rows — the old and new line, the sign and the code, painted like the language — and
 * a note when it was cut. `wrap` folds long lines.
 */
export function PatchView({text, path, label, wrap, truncated = false}: {text: string; path: string; label: string; wrap: boolean; truncated?: boolean}) {
  const t = useT();
  const rows = useMemo(() => parsePatch(fromFirstHunk(text)), [text]);
  const tokensOf = useHighlight(path, rows, rows.length <= 4000);
  // No hunk (a binary file, a rename or a mode change): git's own lines say what changed.
  if (!rows.length) return <>
    {text.trim() ? <pre className="git-history-raw" aria-label={label}>{text.replace(/\n$/, "")}</pre> : <p className="g-state-page">{t("hs.no-text")}</p>}
    {truncated && <p className="git-history-note g-muted">{t("hs.cut")}</p>}
  </>;
  return <>
    <div className="git-review-diff git-history-diff" role="group" aria-label={label} data-wrap={wrap || undefined}>
      {rows.map((row, index) => <div key={index} className="git-review-row" data-kind={row.kind}>
        {row.kind === "hunk" ? <span className="git-review-hunk">{row.text}</span> : <>
          <span className="git-review-number">{row.oldLine ?? ""}</span><span className="git-review-number">{row.newLine ?? ""}</span>
          <code className="git-review-code">{row.kind === "add" ? "+ " : row.kind === "del" ? "− " : "  "}<CodeText text={row.text} tokens={tokensOf(index)}/></code>
        </>}
      </div>)}
    </div>
    {truncated && <p className="git-history-note g-muted">{t("hs.cut")}</p>}
  </>;
}
