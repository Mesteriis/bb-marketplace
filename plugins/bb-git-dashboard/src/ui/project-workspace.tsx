import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import type { MessageKey } from "../core/i18n/dictionary.ts";
import type { Account } from "../core/providers.ts";
import type { RepositorySection } from "../core/repository-features.ts";
import type { Copy } from "../core/workspace.ts";
import { ConnectionWizard, type ConnectionApi } from "./connection-wizard.tsx";
import { RepositoryPanel, type RepositoryApi } from "./repository-panel.tsx";
import type { CiView } from "./ci/ci-panel.tsx";
import "./project-workspace.css";
import { useT } from "./i18n/use-t.tsx";
import { HistoryPanel } from "./history/history-panel.tsx";
import { ReviewPanel } from "./code-review/review-panel.tsx";

type Host = {id:string;name:string};
type Project = {id:string;name:string};
type Location = {hostId:string;projectId:string;path:string;name:string|null};
const sections = ["Code","History","Review","Actions","Issues","Variables"] as const;
type Section = typeof sections[number];
const labels: Record<Section, MessageKey> = {Code:"pg.tab.code", History:"pg.tab.history", Review:"pg.tab.review", Actions:"pg.tab.actions",
  Issues:"pg.tab.issues", Variables:"pg.tab.variables"};

/** A copy's page (`<copy>/<section>`): its head, the sections as tabs, and the chosen section under them. */
export function ProjectWorkspace({copies,hosts,subPath,loaded,error,api,onOpen,onAttach,renderHead,renderWorktree,onOpenIssue,historyGraph = true,reviewRevisions = {}}: {
  copies:Copy[]; hosts:Host[]; subPath:string;
  /** The History tab draws branch and merge lanes; off by the historyGraph setting. */
  historyGraph?:boolean;
  /** Changes when a copy's line review changed elsewhere (an agent answered). */
  reviewRevisions?:Record<string,number>;
  loaded:boolean; error:string; api:RepositoryApi & ConnectionApi;
  onOpen(path:string):void; onAttach(hostId:string,root:string,projectId?:string):Promise<Copy>;
  /** The copy's head; it reports the number of changed files for the Code tab. */
  renderHead(copy:Copy, onFiles:(count:number)=>void):ReactNode;
  renderWorktree(copy:Copy,host:string,attach:(root:string)=>Promise<void>):ReactNode;
  onOpenIssue?(accountId:string,repo:string,number:number|"new"):void;
}) {
  const t = useT();
  const [first, second, third] = subPath.split("/");
  // `<copy>/review/<file>`: the Review goes to that file once it shows (`bb git-dashboard review open`).
  const reviewFile = third ? decodeURIComponentSafe(third) : undefined;
  const copy = copies.find(item => item.id === first);
  const section = sections.find(item => item.toLowerCase() === second) ?? "Code";
  const [accounts,setAccounts] = useState<Account[]>([]);
  const [accountError,setAccountError] = useState("");
  const [connecting,setConnecting] = useState(false);
  const [files,setFiles] = useState<number|null>(null);
  useEffect(() => { setFiles(null); }, [first]);

  useEffect(() => {
    let active = true;
    api.accounts().then(value => {if(active) setAccounts(value);}, message => {if(active) setAccountError(errorMessage(message));});
    return () => { active = false; };
  }, [api]);

  if (!copy) return <div className="g-page">{error && <div className="g-banner bad" role="alert">{error}</div>}
    <p className="g-state-page" role="status">{loaded ? t("pg.missing") : t("common.loading")}</p></div>;
  const openCopy = (next:Section) => onOpen(copy.id + (next === "Code" ? "" : "/" + next.toLowerCase()));
  const hostName = (id:string) => hosts.find(host => host.id === id)?.name ?? id;
  const name = copy.repositoryName ?? copy.root.split(/[\\/]/).pop() ?? copy.root;
  const forge = section !== "Code" && section !== "History" && section !== "Review";
  // `<copy>/actions/<run>` and `<copy>/actions/templates`: a place inside CI/CD the address keeps.
  const ciView: CiView = section !== "Actions" || !third ? {kind: "runs"} : third === "templates" ? {kind: "templates"}
    : {kind: "run", runId: decodeURIComponentSafe(third)};
  const ci = {view: ciView, onSection: () => onOpen("ci"), onView: (next: CiView) => onOpen(copy.id + "/actions"
    + (next.kind === "run" ? "/" + encodeURIComponent(next.runId) : next.kind === "templates" ? "/templates" : ""))};
  const panel = forge && <RepositoryPanel key={copy.id + section} copyId={copy.id} name={name} ci={section === "Actions" ? ci : undefined}
    accounts={accounts} api={api} onAddConnection={() => setConnecting(true)} section={section.toLowerCase() as RepositorySection} onOpenIssue={onOpenIssue}/>;
  const wizard = connecting && <ConnectionWizard api={api} onClose={() => setConnecting(false)} onSaved={account => {
    setAccounts(previous => [...previous.filter(item => item.id !== account.id),account]);
    setConnecting(false);
  }}/>;
  // A run is a page of its own: its path leads back, so the copy's head and tabs stay away. The tree stays the same,
  // so the CI/CD tab keeps its filter and page while a run is open.
  const run = ciView.kind === "run";

  return <div className={"g-page git-project" + (run ? " git-ci-page" : "")}>
    {!run && renderHead(copy,setFiles)}
    {!run && <div className="g-views" role="tablist" aria-label={t("pg.sections")}>
      {sections.map(item => <button key={item} id={"git-section-" + item} type="button" role="tab" data-section={item} aria-selected={item === section}
        aria-controls="git-section-panel" tabIndex={item === section ? 0 : -1}
        onClick={() => openCopy(item)} onKeyDown={event => {
          const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
          if (!step) return;
          const next = sections[(sections.indexOf(item) + step + sections.length) % sections.length]!;
          openCopy(next);
          (event.currentTarget.parentElement?.querySelector("[data-section=\"" + next + "\"]") as HTMLElement | null)?.focus();
        }}>{t(labels[item])}{item === "Code" && files ? <span className="g-num g-muted"> {files}</span> : null}</button>)}
    </div>}
    <main className="git-project-main" {...(run ? {} : {role: "tabpanel", "aria-labelledby": "git-section-" + section})} id="git-section-panel">
      {accountError && forge && <p role="alert" className="git-panel-message git-error">{accountError}</p>}
      {error && <p className="git-panel-message git-error" role="alert">{error}</p>}
      {section === "Code" && renderWorktree(copy,hostName(copy.hostId),async root => {
        const registered = await onAttach(copy.hostId,root,copy.projectId);
        onOpen(registered.id);
      })}
      {section === "History" && <HistoryPanel key={copy.id} api={api.history} copyId={copy.id} graph={historyGraph}/>}
      {section === "Review" && <ReviewPanel key={copy.id + (reviewFile ?? "")} api={api.review} copyId={copy.id} revision={reviewRevisions[copy.id] ?? 0} initialFile={reviewFile}/>}
      {panel}
      {wizard}
    </main>
  </div>;
}

function decodeURIComponentSafe(value:string|undefined) {
  try { return value ? decodeURIComponent(value) : ""; }
  catch { return ""; }
}

export function errorMessage(error:unknown) {
  return error instanceof Error ? error.message : "Request failed.";
}

export function AddCopy({hosts,locations,projects,onSubmit}: {
  hosts:Host[]; locations:Location[]; projects:Project[];
  onSubmit(hostId:string,root:string,source:string,projectId?:string):Promise<void>;
}) {
  const t = useT();
  const [manual,setManual] = useState(false);
  const [key,setKey] = useState("");
  const [host,setHost] = useState(hosts.length === 1 ? hosts[0].id : "");
  const [path,setPath] = useState("");
  const [source,setSource] = useState("");
  const [pending,setPending] = useState(false);
  const [error,setError] = useState("");
  const locationKey = (location:Location) => JSON.stringify([location.projectId,location.hostId,location.path]);
  const usePath = manual || !locations.length;
  const location = usePath ? undefined : locations.find(item => locationKey(item) === key) ??
    (locations.length === 1 ? locations[0] : undefined);
  const canSubmit = usePath ? !!host && !!path.trim() : !!location;
  const onAdd = async (event:FormEvent) => {
    event.preventDefault();
    if (pending || !canSubmit) return;
    setPending(true);
    setError("");
    try {
      if (location) await onSubmit(location.hostId,location.path,"",location.projectId);
      else await onSubmit(host,path.trim(),source.trim());
    } catch (error) { setError(errorMessage(error)); }
    finally { setPending(false); }
  };
  return <form className="git-add-copy git-stack" onSubmit={onAdd}>
    {locations.length > 0 && <label><input type="checkbox" checked={manual} disabled={pending}
      onChange={event => {setManual(event.target.checked); setError("");}}/> {t("pj.add.manual")}</label>}
    {!usePath ? <label>{t("pj.add.location")}
      <select disabled={pending} value={location ? locationKey(location) : ""} onChange={event => {setKey(event.target.value); setError("");}}>
        <option value="">{t("pj.add.choose")}</option>
        {locations.map(item => <option key={locationKey(item)} value={locationKey(item)}>
          {projects.find(project => project.id === item.projectId)?.name} · {hosts.find(host => host.id === item.hostId)?.name ?? item.hostId} · {item.path}
        </option>)}
      </select></label> : <div className="git-row">
        <select aria-label={t("pj.add.host")} value={host} onChange={event => setHost(event.target.value)}>
          <option value="">{t("pj.add.choose-host")}</option>{hosts.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select>
        <input aria-label={t("pj.add.path")} placeholder={t("pj.add.path-hint")} value={path} onChange={event => setPath(event.target.value)}/>
        <input aria-label={t("pj.add.bare")} placeholder={t("pj.add.bare-hint")} value={source} onChange={event => setSource(event.target.value)}/>
      </div>}
    <button type="submit" disabled={pending || !canSubmit}>{pending ? t("pj.add.attaching") : usePath && source.trim() ? t("pj.add.clone") : t("pj.add.submit")}</button>
    {error && <p role="alert" className="git-error">{error}</p>}
  </form>;
}
