import type { ReactNode } from "react";

/** The head of a section page: its title, a short line of what is shown, and the page's actions on the right. */
export function PageHead({title, sub, actions}: {title: string; sub?: ReactNode; actions?: ReactNode}) {
  return <header className="g-head">
    <h1>{title}</h1>
    {sub ? <span className="g-sub">{sub}</span> : null}
    {actions ? <div className="g-actions">{actions}</div> : null}
  </header>;
}
