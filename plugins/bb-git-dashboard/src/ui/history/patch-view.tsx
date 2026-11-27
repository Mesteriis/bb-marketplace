/** A unified diff with added and removed lines marked. */
export function PatchView({text, label}: {text: string; label: string}) {
  if (!text.trim()) return <p className="git-muted">No textual change.</p>;
  return <pre className="git-code git-history-patch" aria-label={label}>{text.replace(/\n$/, "").split("\n").map((line, index) =>
    <span key={index} className={line.startsWith("+") && !line.startsWith("+++") ? "git-added" : line.startsWith("-") && !line.startsWith("---") ? "git-removed"
      : line.startsWith("@@") ? "git-muted" : undefined}>{line + "\n"}</span>)}</pre>;
}
