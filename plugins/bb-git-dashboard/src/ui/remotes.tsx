import { useEffect, useState } from "react";
import type { Account, CatalogPage, Pull, PullDetails, PullMutation, Repo } from "../core/providers.ts";
import type { Preview, RemoteAction, RemoteOutcome } from "../core/publication.ts";
import type { Copy } from "../core/workspace.ts";
import type { GitResult } from "../core/git.ts";

type Host = {id:string;name:string};
export interface RemoteApi {
  accounts():Promise<Account[]>;
  repositories(accountId:string,page:number,refresh:boolean):Promise<CatalogPage>;
  pulls(repo:Repo,page:number):Promise<{items:Pull[];more:boolean}>;
  pull(repo:Repo,number:number):Promise<PullDetails>;
  status(copyId:string):Promise<GitResult>;
  compare(copyId:string,base:string,head:string):Promise<GitResult>;
  prepare(repo:Repo,action:RemoteAction):Promise<Preview>;
  publish(id:string):Promise<RemoteOutcome>;
  activity():Promise<RemoteOutcome[]>;
}
type Pages = {items:Repo[]; page:number; more:boolean; observedAt:string; error?:string};
const repoKey = (repo:Repo) => repo.accountId + ":" + repo.id;
const message = (error:unknown) => error instanceof Error ? error.message : "Request failed.";

export function Remotes({api,copies,hosts,onOpen,onPin}: {
  api:RemoteApi; copies:Copy[]; hosts:Host[]; onOpen(copyId:string):void; onPin(repo:Repo,number:number):void;
}) {
  const [accounts,setAccounts] = useState<Account[]>([]);
  const [catalog,setCatalog] = useState<Record<string,Pages>>({});
  const [query,setQuery] = useState("");
  const [provider,setProvider] = useState("");
  const [account,setAccount] = useState("");
  const [project,setProject] = useState("");
  const [repo,setRepo] = useState<Repo>();
  const [preview,setPreview] = useState<Preview>();
  const [outcome,setOutcome] = useState<RemoteOutcome>();
  const [activity,setActivity] = useState<RemoteOutcome[]>();
  const [loading,setLoading] = useState(true);
  const [pending,setPending] = useState(false);
  const [error,setError] = useState("");

  async function loadAccount(id:string,page:number,refresh:boolean) {
    try {
      const result = await api.repositories(id,page,refresh);
      setCatalog(previous => ({...previous,[id]:{...result,page,items:page === 1 ? result.items : [...(previous[id]?.items ?? []),...result.items]}}));
    } catch (error) {
      setCatalog(previous => ({...previous,[id]:{...(previous[id] ?? {page,items:[],more:false,observedAt:""}),error:message(error)}}));
    }
  }

  useEffect(() => {
    let current = true;
    api.accounts().then(async rows => {
      if (!current) return;
      setAccounts(rows);
      await Promise.all(rows.map(row => loadAccount(row.id,1,false)));
    }, error => {if (current) setError(message(error));})
      .finally(() => {if (current) setLoading(false);});
    return () => {current=false;};
  }, [api]);

  async function review(repo:Repo,action:RemoteAction) {
    setPending(true); setError(""); setOutcome(undefined);
    try { setPreview(await api.prepare(repo,action)); }
    catch (error) { setError(message(error)); }
    finally { setPending(false); }
  }

  async function publish() {
    if (!preview || pending) return;
    setPending(true); setError("");
    const id = preview.id;
    setPreview(undefined);
    try {
      const result = await api.publish(id);
      setOutcome(result);
      if (result.copyId && result.kind === "clone" && result.status === "completed") onOpen(result.copyId);
      if (activity) setActivity(await api.activity());
    } catch (error) { setError(message(error)); }
    finally { setPending(false); }
  }

  const filteredAccounts = accounts.filter(row => (!provider || row.kind === provider) && (!account || row.id === account));
  const candidates = filteredAccounts.flatMap(row => catalog[row.id]?.items ?? []);
  const projects = [...new Set(candidates.map(item => item.project))].sort();
  const visible = candidates.filter(item => (!project || item.project === project) && item.path.toLowerCase().includes(query.trim().toLowerCase()));

  return <div className="git-layout">
    <aside className="git-nav git-section">
      <div className="git-row"><h2>Remote repositories</h2></div>
      <input aria-label="Search remote repositories" placeholder="Search repositories" value={query} onChange={event => setQuery(event.target.value)} />
      <select aria-label="Provider filter" value={provider} onChange={event => {setProvider(event.target.value);setAccount("");setProject("");}}>
        <option value="">All providers</option><option value="github">GitHub</option><option value="azure">Azure Repos</option><option value="gitea">Gitea</option>
      </select>
      <select aria-label="Account filter" value={account} onChange={event => {setAccount(event.target.value);setProject("");}}>
        <option value="">All accounts</option>{accounts.filter(row => !provider || row.kind === provider).map(row => <option key={row.id} value={row.id}>{row.label}</option>)}
      </select>
      <select aria-label="Project filter" value={project} onChange={event => setProject(event.target.value)}>
        <option value="">All projects</option>{projects.map(name => <option key={name}>{name}</option>)}
      </select>
      {loading && <p role="status">Loading accounts…</p>}
      {!loading && accounts.length === 0 && <p className="git-muted">Add an account and its API token in BB → Plugins → BB Git Dashboard → Settings.</p>}
      <div className="git-list">{visible.map(item => <button key={repoKey(item)} className="git-entry" aria-current={repo && repoKey(repo) === repoKey(item)}
        onClick={() => {setRepo(item);setError("");}}>{item.path}<br/><span className="git-muted">{accounts.find(row => row.id === item.accountId)?.label}</span></button>)}</div>
      {filteredAccounts.map(row => {
        const page = catalog[row.id];
        return <div className="git-stack git-divider" key={row.id}>
          <div className="git-row"><strong>{row.label}</strong>
            <button disabled={pending} onClick={() => void loadAccount(row.id,1,true)}>Refresh</button>
            {page?.more && <button disabled={page.page >= 100} onClick={() => void loadAccount(row.id,page.page+1,true)}>More repositories</button>}
          </div>
          {page?.observedAt && <span className="git-muted">Observed {new Date(page.observedAt).toLocaleString()}</span>}
          {page?.error && <p role="alert" className="git-error">{page.error}</p>}
        </div>;
      })}
      <button onClick={() => api.activity().then(setActivity,error => setError(message(error)))}>Publication activity</button>
    </aside>
    <div className="git-section">
      {error && <p role="alert" className="git-error">{error}</p>}
      {pending && <p role="status">Checking remote operation…</p>}
      {preview && <section className="git-stack git-divider" aria-label="Publication preview">
        <strong>Confirm {preview.action.kind === "pull" ? preview.action.action.kind : preview.action.kind}</strong>
        {preview.lines.map((line,index) => <p className="git-path" key={index}>{line}</p>)}
        {preview.action.kind === "pull" && "body" in preview.action.action && <pre className="git-code">{preview.action.action.body}</pre>}
        <div className="git-row"><button className="git-primary" disabled={pending} onClick={() => void publish()}>Confirm operation</button>
          <button onClick={() => setPreview(undefined)}>Cancel</button></div>
      </section>}
      {outcome && <p role="status">{outcome.kind} · {outcome.status}{outcome.pullNumber ? " · PR #" + outcome.pullNumber : ""}{outcome.code ? " · " + outcome.code : ""}</p>}
      {activity && <section className="git-stack git-divider">
        <strong>Publication activity</strong>
        {activity.length === 0 && <p className="git-muted">No remote operations recorded.</p>}
        {activity.map(row => <p className="git-path" key={row.id}>{row.at} · {row.kind} · {row.status} · {row.summary[1]}{row.code ? " · " + row.code : ""}</p>)}
      </section>}
      {repo ? <Repository key={repoKey(repo)} api={api} repo={repo} account={accounts.find(row => row.id === repo.accountId)}
        copies={copies} hosts={hosts} pin={number => {try {onPin(repo,number);} catch (error) {setError(message(error));}}} pending={pending || Boolean(preview)} review={action => review(repo,action)} version={outcome?.id}/>
        : <p className="git-muted">Select a remote repository to clone it or open its pull requests.</p>}
    </div>
  </div>;
}

function Repository({api,repo,account,copies,hosts,pending,review,version,pin}: {
  api:RemoteApi; repo:Repo; account?:Account; copies:Copy[]; hosts:Host[]; pending:boolean;
  review(action:RemoteAction):Promise<void>; version?:string; pin(number:number):void;
}) {
  const [host,setHost] = useState("");
  const [destination,setDestination] = useState("");
  const [working,setWorking] = useState("");
  const [copyState,setCopyState] = useState<GitResult>();
  const [list,setList] = useState<Pull[]>([]);
  const [page,setPage] = useState(1);
  const [more,setMore] = useState(false);
  const [chosen,setChosen] = useState<number>();
  const [detail,setDetail] = useState<PullDetails>();
  const [patch,setPatch] = useState<string>();
  const [title,setTitle] = useState("");
  const [body,setBody] = useState("");
  const [base,setBase] = useState(repo.branch ?? "");
  const [comment,setComment] = useState("");
  const [reviewer,setReviewer] = useState("");
  const [error,setError] = useState("");
  const [listing,setListing] = useState(false);
  const hostId = host || (hosts.length === 1 ? hosts[0].id : "");
  const copy = copies.find(item => item.id === working);

  useEffect(() => {
    let current = true;
    if (working) api.status(working).then(value => {if(current) setCopyState(value);}, error => {if(current) setError(message(error));});
    return () => {current=false;};
  }, [working,api,version]);

  useEffect(() => {
    let current = true;
    setListing(true);
    api.pulls(repo,page).then(values => {
      if (current) {setList(values.items);setMore(values.more);}
    }, error => {if(current) setError(message(error));})
      .finally(() => {if(current) setListing(false);});
    return () => {current=false;};
  }, [api,repo,page,version]);

  useEffect(() => {
    let current = true;
    if (chosen !== undefined) api.pull(repo,chosen).then(value => {if(current) setDetail(value);}, error => {if(current) setError(message(error));});
    return () => {current=false;};
  }, [api,repo,chosen,version]);

  function action(value:PullMutation) { void review({kind:"pull",action:value}); }
  const pr = detail?.pull;
  const canMerge = repo.canPush !== false && pr && !pr.merged && ["open","active"].includes(pr.state);
  return <>
    <header className="git-stack git-divider">
      <h2>{repo.path}</h2>
      <p className="git-muted git-path">{account?.kind} · {account?.label} · {account?.origin} · {repo.branch ?? "Default branch unknown"}</p>
      <p className="git-muted">{repo.canPush === null ? "Push permission unverified" : repo.canPush ? "API reports push permission" : "API reports no push permission"}</p>
    </header>
    {error && <p role="alert" className="git-error">{error}</p>}
    <form className="git-row" onSubmit={event => {
      event.preventDefault();
      if (hostId && destination.trim()) void review({kind:"clone",hostId,destination:destination.trim()});
    }}>
      <select aria-label="Clone execution host" value={hostId} onChange={event => setHost(event.target.value)}>
        <option value="">Choose execution host</option>{hosts.map(host => <option key={host.id} value={host.id}>{host.name}</option>)}
      </select>
      <input aria-label="Clone destination" placeholder="Absolute clone path" value={destination} onChange={event => setDestination(event.target.value)}/>
      <button disabled={pending || !hostId || !destination.trim()}>Review clone</button>
    </form>
    <div className="git-row git-divider">
      <select aria-label="Working copy for remote actions" value={working} onChange={event => {setCopyState(undefined);setWorking(event.target.value);}}>
        <option value="">Choose working copy</option>{copies.map(copy => <option key={copy.id} value={copy.id}>{copy.root} · {hosts.find(host => host.id === copy.hostId)?.name ?? copy.hostId}</option>)}
      </select>
      <button disabled={pending || !working} onClick={() => void review({kind:"fetch",copyId:working})}>Review fetch</button>
      <button disabled={pending || !working || !copyState?.head || repo.canPush===false} onClick={() => void review({kind:"push",copyId:working})}>Review push</button>
      {copy && <span className="git-muted git-path">{copy.root} · {copyState?.branch ?? "Branch unavailable"}</span>}
    </div>
    <section className="git-stack git-divider">
      <h2>Pull requests</h2>
      <div className="git-row">
        <button disabled={page===1 || listing} onClick={() => setPage(value => value-1)}>Previous</button>
        <span>Page {page}</span><button disabled={!more || listing} onClick={() => setPage(value => value+1)}>Next</button>
      </div>
      {listing ? <p role="status">Reading pull requests…</p> : list.length ? <div className="git-list">
        {list.map(pr => <button key={pr.number} className="git-entry" aria-current={chosen===pr.number}
          onClick={() => {setChosen(pr.number);setDetail(undefined);setPatch(undefined);setError("");}}>{pr.state} · #{pr.number} {pr.title}</button>)}
      </div> : <p className="git-muted">No pull requests on this page.</p>}
      <details><summary>Create pull request from selected working copy</summary>
        <form className="git-stack" onSubmit={event => {
          event.preventDefault();
          if (copyState?.head && copyState.branch) action({kind:"create",head:copyState.branch,expected:copyState.head,base,title,body});
        }}>
          <p className="git-muted">{copyState?.branch ?? "Choose a working copy with a branch first."}</p>
          <input value={base} onChange={event => setBase(event.target.value)} aria-label="PR base branch" placeholder="Base branch" />
          <input value={title} onChange={event => setTitle(event.target.value)} aria-label="PR title" placeholder="Title" maxLength={220}/>
          <textarea value={body} onChange={event => setBody(event.target.value)} aria-label="PR body" placeholder="Description" maxLength={8000}/>
          <button disabled={pending || !copyState?.branch || !copyState.head || !base || !title.trim()}>Review creation</button>
        </form>
      </details>
    </section>
    {chosen !== undefined && !detail && <p role="status">Reading PR #{chosen}…</p>}
    {pr && detail && <section className="git-stack">
      <div className="git-row"><h2>#{pr.number} {pr.title}</h2><button onClick={() => pin(pr.number)}>Pin pull request</button></div>
      <p className="git-muted git-path">{pr.head.repo}:{pr.head.branch} @ {pr.head.sha ?? "unknown"} → {pr.base.repo}:{pr.base.branch} @ {pr.base.sha ?? "unknown"}</p>
      {pr.body && <pre className="git-code">{pr.body}</pre>}
      <div className="git-row">
        <button disabled={pending || !canMerge || !pr.head.sha} onClick={() => pr.head.sha && action({kind:"merge",number:pr.number,expected:pr.head.sha})}>Review merge</button>
        <button disabled={pending || pr.merged || !["closed","abandoned"].includes(pr.state) || !pr.head.sha} onClick={() => pr.head.sha && action({kind:"reopen",number:pr.number,expected:pr.head.sha})}>Review reopening</button>
      </div>
      <form className="git-row" onSubmit={event => {
        event.preventDefault();
        if (pr.head.sha && reviewer.trim()) action({kind:"review",number:pr.number,expected:pr.head.sha,reviewer:reviewer.trim()});
      }}><input value={reviewer} onChange={event => setReviewer(event.target.value)} aria-label="Reviewer"
        placeholder={account?.kind === "azure" ? "Reviewer identity UUID" : "Reviewer login"}/><button disabled={pending || !reviewer.trim() || !pr.head.sha}>Review request</button></form>
      <form className="git-row" onSubmit={event => {
        event.preventDefault();
        if (pr.head.sha && comment.trim()) action({kind:"comment",number:pr.number,expected:pr.head.sha,body:comment});
      }}><textarea value={comment} onChange={event => setComment(event.target.value)} aria-label="PR comment" maxLength={8000}/><button disabled={pending || !comment.trim() || !pr.head.sha}>Review comment</button></form>
      {detail.issues.map(issue => <p className="git-error" key={issue}>{issue}</p>)}
      <details><summary>Checks ({detail.checks.length})</summary>{detail.checks.map((check,index) => <p key={index}>{check.name} · {check.state}</p>)}</details>
      <details><summary>Discussion ({detail.comments.length})</summary>{detail.comments.map((comment,index) => <div className="git-stack" key={index}><strong>{comment.author}</strong><pre className="git-code">{comment.body}</pre></div>)}</details>
      <details><summary>Diff</summary>
        {detail.diff !== null || patch !== undefined ? <pre className="git-code">{detail.diff ?? patch}</pre> : <>
          {detail.changes.length > 0 && <pre className="git-code">{detail.changes.join("\n")}</pre>}
          <button disabled={!working || !pr.head.sha || !pr.base.sha} onClick={() => {
            if (pr.head.sha && pr.base.sha) void api.compare(working,pr.base.sha,pr.head.sha)
              .then(value => setPatch(value.text ?? ""),error => setError(message(error)));
          }}>Compare these SHAs in working copy</button>
        </>}
      </details>
    </section>}
  </>;
}
