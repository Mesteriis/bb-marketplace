import type { CodeReviewApi } from "./code-review/review-api.ts";
import { useEffect, useState, type FormEvent } from "react";
import type { Account, Repo } from "../core/providers.ts";
import type { FeatureList, RepositorySection } from "../core/repository-features.ts";
import type { RemoteApi } from "./remotes.tsx";
import { ForgeStatusLine, type ForgeStatus } from "./forge-status.tsx";
import { limitation } from "../core/forge/capabilities.ts";
import { CiPanel, type CiView } from "./ci/ci-panel.tsx";
import { Icon } from "./system/icon.tsx";
import { useT } from "./i18n/use-t.tsx";
import type { MessageKey } from "../core/i18n/dictionary.ts";
import type { CiApi } from "./ci/ci-api.ts";
import type { HistoryApi } from "./history/history-api.ts";

type Link = {accountId:string;repoId:string};
export type RepositoryApi = Pick<RemoteApi,"accounts"|"repositories"|"status"> & {
  link(copyId:string):Promise<Link|null>;
  forgeStatus(copyId:string,recheck:boolean):Promise<ForgeStatus>;
  forgeConnect(copyId:string,accountId:string):Promise<void>;
  setLink(copyId:string,target:Link|null):Promise<void>;
  features(copyId:string,section:RepositorySection):Promise<{repo:Repo;features:FeatureList}>;
  ci:CiApi;
  history:HistoryApi;
  review:CodeReviewApi;
};

const labels = {
  actions:{title:"section.ci", idle:"section.ci", detail:"section.ci", loading:"section.ci"},
  issues:{title:"rp.issues-title", idle:"rp.issues-idle", detail:"rp.col.labels", loading:"rp.loading-issues"},
  variables:{title:"rp.variables-title", idle:"rp.variables-idle", detail:"rp.col.value", loading:"rp.loading-variables"},
} as const satisfies Record<RepositorySection, Record<string, MessageKey>>;
/** What the server says of a row or a list, in the interface language when it is one of its known words. */
const statusWords: Record<string, MessageKey> = {open:"rp.s.open", opened:"rp.s.open", closed:"rp.s.closed", Variable:"rp.s.variable", Secret:"rp.s.secret", File:"rp.s.file"};
const noticeWords: Record<string, MessageKey> = {
  "Variable names and values are unavailable from this account.":"rp.n.variables-denied", "Secret names are unavailable from this account.":"rp.n.secrets-denied",
  "CI/CD variables need the Maintainer role in this project.":"rp.n.maintainer", "Values are not shown.":"rp.n.values",
  "Azure Boards are scoped to the Azure DevOps project.":"rp.n.azure-issues", "Azure variable groups are scoped to the Azure DevOps project.":"rp.n.azure-variables",
};
/** GitLab's variable flags ("protected, masked, environment production") word by word. */
function flagWords(detail: string, t: (key: MessageKey, values?: Record<string, string | number>) => string) {
  return detail.split(", ").map(flag => flag === "protected" ? t("rp.f.protected") : flag === "masked" ? t("rp.f.masked")
    : flag.startsWith("environment ") ? t("rp.f.environment", {name: flag.slice(12)}) : flag).join(", ");
}
const forgeNames = {github:"GitHub", gitlab:"GitLab", gitea:"Gitea", azure:"Azure DevOps"} as const;
const message = (error:unknown) => error instanceof Error ? error.message : "Request failed.";

export function RepositoryPanel({copyId,name,accounts,api,section,onAddConnection,onOpenIssue,ci}: {
  copyId:string;name:string;accounts:Account[];api:RepositoryApi;section:RepositorySection;onAddConnection():void;
  /** CI/CD: where in the section the address points (runs, a run, the templates), and the way back to the CI/CD section. */
  ci?:{view:CiView;onView(view:CiView):void;onSection():void};
  /** Opens an issue, or the new-issue form, inside Makosh Git. */
  onOpenIssue?(accountId:string,repo:string,number:number|"new"):void;
}) {
  const [target,setTarget] = useState<Link|null>();
  const [data,setData] = useState<Awaited<ReturnType<RepositoryApi["features"]>>>();
  const [error,setError] = useState("");
  const [notice,setNotice] = useState("");
  const [pending,setPending] = useState(false);
  const [revision,setRevision] = useState(0);
  const [changing,setChanging] = useState(false);
  const [filter,setFilter] = useState("all");
  const [forge,setForge] = useState<ForgeStatus>();
  const [recheck,setRecheck] = useState(false);
  const label = labels[section];
  const t = useT();
  useEffect(() => {
    let active = true;
    setPending(true);
    setError("");
    setData(undefined);
    api.forgeStatus(copyId,recheck).then(async status => {
      if (!active) return;
      setForge(status);
      const link = status.linked;
      setTarget(link);
      if (link && section !== "actions") {
        const response = await api.features(copyId,section);
        if (active) setData(response);
      }
    }).catch(error => {if(active) setError(message(error));}).finally(() => {if(active) {setPending(false); setRecheck(false);}});
    return () => {active = false;};
  }, [api,copyId,revision,section]);

  const change = async (next:Link|null) => {
    try {
      await api.setLink(copyId,next);
      setChanging(false);
      setNotice("");
      setRevision(value => value + 1);
    } catch (error) { setNotice(message(error)); }
  };
  const choose = async (accountId:string) => {
    try {
      await api.forgeConnect(copyId,accountId);
      setNotice("");
      setRevision(value => value + 1);
    } catch (error) { setNotice(message(error)); }
  };
  const rows = data?.features.items.filter(row => filter === "all" || row.status === filter) ?? [];
  const provider = data?.repo && accounts.find(account => account.id === data.repo.accountId);
  const picker = (target === null || changing) && (accounts.length > 0
    ? <ConnectionPicker accounts={accounts} target={target} api={api} onChange={change}/>
    : <div className="git-row"><button type="button" onClick={onAddConnection}>{t("ci.add-connection")}</button></div>);
  if (section === "actions") {
    const account = forge?.candidates.find(row => row.id === forge.chosen) ?? accounts.find(item => item.id === target?.accountId);
    const kind = forge?.detection?.kind;
    const where = forge?.remote && forge.detection ? forge.detection.host + (forge.remote.path ? "/" + forge.remote.path : "") : "";
    // The full status line stays whenever there is something to say or do: an unknown or silent server, a choice, a fault, a limit.
    const explain = !!forge && (!target || !kind || forge.detection?.status === "unreachable" || forge.reason === "ambiguous" || !!forge.error
      || !!(kind && limitation(kind, "repositories")));
    const line = target && <button type="button" className="g-btn ghost sm git-ci-forge" aria-expanded={changing} title={t("ci.connection") + (where ? " · " + where : "")}
      onClick={() => setChanging(value => !value)}>
      {kind && !forge?.error && <Icon name="CircleCheck" small/>}{kind ? forgeNames[kind] : where}{account ? " · " + account.label + ("username" in account && account.username ? " (" + account.username + ")" : "") : ""}
    </button>;
    return <section className="git-repository-panel git-ci-section">
      {explain && forge && <div className="git-ci-status"><ForgeStatusLine key={copyId + ":" + forge.candidates.map(row => row.id).join(",")}
        status={forge} busy={pending} onChoose={choose} onRecheck={() => { setRecheck(true); setRevision(value => value + 1); }}/></div>}
      {target === null && <p className="git-ci-status g-muted">{t("ci.connect-by-hand")}</p>}
      {picker && <div className="git-ci-status">{picker}</div>}
      {notice && <div className="g-banner bad" role="alert">{notice}</div>}
      {pending && !target && <p role="status" className="g-state-page">{t("ci.loading")}</p>}
      {error && <div role="alert" className="g-banner bad">{error}</div>}
      {target && <CiPanel api={api.ci} copyId={copyId} repository={name} forge={line} view={ci?.view} onView={ci?.onView} onSection={ci?.onSection}/>}
    </section>;
  }
  return <section className="git-project-code git-repository-panel">
    <div className="git-project-title"><div><h2>{t(label.title)}</h2>
      <p className="git-muted">{data?.repo.path ?? name}{provider ? " · " + provider.label : ""}</p></div>
      {target && <div className="git-row">
        {section === "issues" && <select className="g-inp" aria-label={t("rp.state")} value={filter} onChange={event => setFilter(event.target.value)}>
          <option value="all">{t("rp.all-states")}</option><option value="open">{t("rp.s.open")}</option><option value="closed">{t("rp.s.closed")}</option>
        </select>}
        {section === "issues" && data?.repo && onOpenIssue && provider && provider.kind !== "azure" &&
          <button type="button" className="g-btn" onClick={() => onOpenIssue(data.repo.accountId,data.repo.path,"new")}>{t("rp.new-issue")}</button>}
        <button disabled={pending} type="button" className="g-btn" onClick={() => setRevision(value => value + 1)}>{t("ov.refresh")}</button>
        <button type="button" className="g-btn" aria-expanded={changing} onClick={() => setChanging(value => !value)}>{t("cp.change")}</button>
      </div>}
    </div>
    {forge && <ForgeStatusLine key={copyId + ":" + forge.candidates.map(row => row.id).join(",")} status={forge} busy={pending} onChoose={choose}
      onRecheck={() => { setRecheck(true); setRevision(value => value + 1); }}/>}
    {target === null && <p className="git-muted">{t("cp.by-hand")}</p>}
    {picker}
    {notice && <p className="git-error" role="alert">{notice}</p>}
    {pending && <p role="status" className="git-muted">{t(label.loading)}</p>}
    {error && <p role="alert" className="git-error">{error}</p>}
    {data?.features.notice && <p className="git-muted" role="status">{noticeWords[data.features.notice] ? t(noticeWords[data.features.notice]!) : data.features.notice}</p>}
    {data && !rows.length && !data.features.notice && <p className="git-muted">{t(filter === "all" ? label.idle : "rp.no-match")}</p>}
    {rows.length > 0 && <div className="git-workspace-table"><table>
      <thead><tr><th scope="col">{t("rp.col.name")}</th><th scope="col">{t(section === "variables" ? "rp.col.type" : "rp.col.status")}</th>
        <th scope="col">{t(section === "variables" && forge?.detection?.kind === "gitlab" ? "rp.col.settings" : label.detail)}</th><th scope="col">{t("rp.col.updated")}</th></tr></thead>
      <tbody>{rows.map(row => <tr key={row.id}><th scope="row">{section === "issues" && onOpenIssue && data?.repo && /^\d+$/.test(row.id)
        ? <button type="button" className="git-link" onClick={() => onOpenIssue(data.repo.accountId,data.repo.path,Number(row.id))}>{row.name}</button>
        : row.url ? <a href={row.url} target="_blank" rel="noreferrer">{row.name}</a> : row.name}</th>
        <td><span className="git-state" data-state={row.status}>{statusWords[row.status] ? t(statusWords[row.status]!) : row.status || "—"}</span></td>
        <td>{row.detail ? (section === "variables" && forge?.detection?.kind === "gitlab" ? flagWords(row.detail, t) : row.detail) : (row.status === "Secret" ? "••••••" : "—")}</td>
        <td>{row.updated ? <time dateTime={row.updated}>{row.updated.slice(0,10)}</time> : "—"}</td>
      </tr>)}</tbody>
    </table></div>}
  </section>;
}

function ConnectionPicker({accounts,target,api,onChange}: {
  accounts:Account[];target:Link|null|undefined;api:RepositoryApi;onChange(value:Link|null):Promise<void>;
}) {
  const [account,setAccount] = useState(target?.accountId ?? "");
  const [repoId,setRepoId] = useState(target?.repoId ?? "");
  const [items,setItems] = useState<Repo[]>([]);
  const [page,setPage] = useState(1);
  const [more,setMore] = useState(false);
  const [loading,setLoading] = useState(false);
  const [pending,setPending] = useState(false);
  const [error,setError] = useState("");
  const t = useT();
  useEffect(() => {
    if (!account) return;
    let active = true;
    setLoading(true);
    setError("");
    api.repositories(account,page,true).then(result => {
      if (!active) return;
      setItems(previous => page === 1 ? result.items : [...previous,...result.items.filter(repo => !previous.some(item => item.id === repo.id))]);
      setMore(result.more);
    }).catch(error => {if(active) setError(message(error));}).finally(() => {if(active) setLoading(false);});
    return () => {active = false;};
  },[account,api,page]);
  const submit = async (target:Link|null) => {
    setPending(true);
    try { await onChange(target); }
    finally { setPending(false); }
  };
  const selectAccount = (event:FormEvent<HTMLSelectElement>) => {
    setAccount(event.currentTarget.value);
    setRepoId("");
    setPage(1);
    setMore(false);
    setItems([]);
    setError("");
  };
  return <form className="git-add-copy git-stack" onSubmit={event => {
    event.preventDefault();
    if (account && items.some(repo => repo.id === repoId)) void submit({accountId:account,repoId});
  }}>
    <div className="git-row">
      <select aria-label={t("cp.account")} value={account} onChange={selectAccount}>
        <option value="">{t("cp.choose-account")}</option>{accounts.map(account => <option key={account.id} value={account.id}>{account.label}</option>)}
      </select>
      <select aria-label={t("cp.repository")} value={repoId} disabled={!account || loading} onChange={event => setRepoId(event.target.value)}>
        <option value="">{t(loading ? "cp.loading" : "cp.choose-repository")}</option>
        {items.map(repo => <option key={repo.id} value={repo.id}>{repo.path}</option>)}
      </select>
      {more && <button type="button" className="g-btn" disabled={loading} onClick={() => setPage(value => value + 1)}>{t("cp.more")}</button>}
      <button className="g-btn pri" type="submit" disabled={loading || pending || !account || !items.some(repo => repo.id === repoId)}>{t("cp.connect")}</button>
      {target && <button type="button" disabled={pending} className="g-btn" onClick={() => void submit(null)}>{t("cp.disconnect")}</button>}
    </div>
    {error && <p role="alert" className="git-error">{error}</p>}
  </form>;
}
