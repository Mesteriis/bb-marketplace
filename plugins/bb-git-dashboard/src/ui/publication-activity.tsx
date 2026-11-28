import { useState } from "react";
import type { MessageKey } from "../core/i18n/dictionary.ts";
import { ago } from "../core/i18n/time.ts";
import type { RemoteOutcome } from "../core/publication.ts";
import { useLanguage, useT } from "./i18n/use-t.tsx";

const tone: Record<RemoteOutcome["status"], string> = {completed: "good", accepted: "good", pending: "line", failed: "bad", unknown: "warn"};

/** The writes done through the accounts (clones, fetches, pushes, pull requests), read when asked for, newest first. */
export function PublicationActivity({load}: {load(): Promise<RemoteOutcome[]>}) {
  const t = useT();
  const {language} = useLanguage();
  const [rows, setRows] = useState<RemoteOutcome[] | null>(null);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const read = async () => {
    setPending(true);
    setError("");
    try { setRows(await load()); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setPending(false); }
  };
  return <section className="git-connection-hosts" aria-labelledby="git-connection-activity">
    <div className="git-connection-group-row">
      <h2 id="git-connection-activity" className="git-connection-group">{t("cn.activity")}</h2>
      <button type="button" className="g-btn sm" disabled={pending} onClick={() => void read()}>{rows ? t("pg.refresh") : t("cn.activity-show")}</button>
    </div>
    <p className="g-muted">{t("cn.activity-hint")}</p>
    {error && <div className="g-banner bad" role="alert">{error}</div>}
    {rows && !rows.length && <p className="g-state-page">{t("cn.activity-none")}</p>}
    {rows && rows.length > 0 && <div className="g-scroll"><table className="g-table" aria-labelledby="git-connection-activity">
      <thead><tr><th>{t("cn.act.when")}</th><th>{t("cn.act.what")}</th><th>{t("cn.act.where")}</th><th>{t("cn.act.result")}</th></tr></thead>
      <tbody>{rows.map(row => <tr key={row.id}>
        <td title={row.at}>{ago(language, Date.now(), row.at)}</td>
        <td>{t(("cn.act.kind." + row.kind) as MessageKey)}{row.pullNumber ? " #" + row.pullNumber : ""}</td>
        <td className="g-mono">{row.summary[1] ?? ""}</td>
        <td><span className={"g-chip " + tone[row.status]}>{t(("cn.act.status." + row.status) as MessageKey)}</span>{row.code ? <span className="g-muted g-mono"> {row.code}</span> : null}</td>
      </tr>)}</tbody>
    </table></div>}
  </section>;
}
