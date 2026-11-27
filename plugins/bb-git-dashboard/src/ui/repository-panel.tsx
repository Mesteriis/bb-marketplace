import { useEffect, useState, type FormEvent } from "react";
import type { Account, Repo } from "../core/providers.ts";
import type { FeatureList, RepositorySection } from "../core/repository-features.ts";
import type { RemoteApi } from "./remotes.tsx";
import { ForgeStatusLine, type ForgeStatus } from "./forge-status.tsx";
import { CiPanel } from "./ci/ci-panel.tsx";
import type { CiApi } from "./ci/ci-api.ts";

type Link = {accountId:string;repoId:string};
export type RepositoryApi = Pick<RemoteApi,"accounts"|"repositories"|"status"> & {
  link(copyId:string):Promise<Link|null>;
  forgeStatus(copyId:string,recheck:boolean):Promise<ForgeStatus>;
  forgeConnect(copyId:string,accountId:string):Promise<void>;
  setLink(copyId:string,target:Link|null):Promise<void>;
  features(copyId:string,section:RepositorySection):Promise<{repo:Repo;features:FeatureList}>;
  ci:CiApi;
};

const labels = {
  actions:{title:"CI/CD", idle:"No workflow runs found.", detail:"Branch"},
  issues:{title:"Issues", idle:"No issues found.", detail:"Labels"},
  variables:{title:"Variables and secrets", idle:"No repository variables or secrets found.", detail:"Value"},
};
const message = (error:unknown) => error instanceof Error ? error.message : "Request failed.";

export function RepositoryPanel({copyId,name,accounts,api,section,onAddConnection}: {
  copyId:string;name:string;accounts:Account[];api:RepositoryApi;section:RepositorySection;onAddConnection():void;
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
  return <section className="git-project-code git-repository-panel">
    <div className="git-project-title"><div><h2>{label.title}</h2>
      <p className="git-muted">{data?.repo.path ?? name}{provider ? " · " + provider.label : ""}</p></div>
      {target && section !== "actions" && <div className="git-row">
        {section === "issues" && <select aria-label="Issue state" value={filter} onChange={event => setFilter(event.target.value)}>
          <option value="all">All states</option><option value="open">Open</option><option value="closed">Closed</option>
        </select>}
        <button disabled={pending} type="button" onClick={() => setRevision(value => value + 1)}>Refresh</button>
        <button type="button" aria-expanded={changing} onClick={() => setChanging(value => !value)}>Connection</button>
      </div>}
    </div>
    {forge && <ForgeStatusLine key={copyId + ":" + forge.candidates.map(row => row.id).join(",")} status={forge} busy={pending} onChoose={choose}
      onRecheck={() => { setRecheck(true); setRevision(value => value + 1); }}/>}
    {target === null && <p className="git-muted">Or connect an account repository matching this working copy’s origin by hand.</p>}
    {(target === null || changing) && (accounts.length > 0
      ? <ConnectionPicker accounts={accounts} target={target} api={api} onChange={change}/>
      : <div className="git-row"><button type="button" onClick={onAddConnection}>Add connection</button></div>)}
    {target && section === "actions" && <div className="git-row"><button type="button" aria-expanded={changing} onClick={() => setChanging(value => !value)}>Connection</button></div>}
    {notice && <p className="git-error" role="alert">{notice}</p>}
    {target && section === "actions" && <CiPanel api={api.ci} copyId={copyId}/>}
    {pending && <p role="status" className="git-muted">Loading {label.title.toLowerCase()}…</p>}
    {error && <p role="alert" className="git-error">{error}</p>}
    {data?.features.notice && <p className="git-muted" role="status">{data.features.notice}</p>}
    {data && !rows.length && !data.features.notice && <p className="git-muted">{filter === "all" ? label.idle : "No matching issues on this page."}</p>}
    {rows.length > 0 && <div className="git-workspace-table"><table>
      <thead><tr><th scope="col">Name</th><th scope="col">{section === "variables" ? "Type" : "Status"}</th>
        <th scope="col">{label.detail}</th><th scope="col">Updated</th></tr></thead>
      <tbody>{rows.map(row => <tr key={row.id}><th scope="row">{row.url
        ? <a href={row.url} target="_blank" rel="noreferrer">{row.name}</a> : row.name}</th>
        <td><span className="git-state" data-state={row.status}>{row.status || "—"}</span></td>
        <td>{row.detail ?? (row.status === "Secret" ? "••••••" : "—")}</td>
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
      <select aria-label="Provider account" value={account} onChange={selectAccount}>
        <option value="">Choose an account</option>{accounts.map(account => <option key={account.id} value={account.id}>{account.label}</option>)}
      </select>
      <select aria-label="Provider repository" value={repoId} disabled={!account || loading} onChange={event => setRepoId(event.target.value)}>
        <option value="">{loading ? "Loading repositories…" : "Choose a repository"}</option>
        {items.map(repo => <option key={repo.id} value={repo.id}>{repo.path}</option>)}
      </select>
      {more && <button type="button" disabled={loading} onClick={() => setPage(value => value + 1)}>More repositories</button>}
      <button className="git-primary" type="submit" disabled={loading || pending || !account || !items.some(repo => repo.id === repoId)}>Connect repository</button>
      {target && <button type="button" disabled={pending} onClick={() => void submit(null)}>Disconnect</button>}
    </div>
    {error && <p role="alert" className="git-error">{error}</p>}
  </form>;
}
