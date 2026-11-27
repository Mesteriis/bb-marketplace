import { useEffect, useMemo, useRef, useState } from "react";
import { nestedFolders, projectTree, type FolderNode, type Project, type Source } from "../../core/project-workspace.ts";
import type { Copy } from "../../core/workspace.ts";
import { useLanguage, useT } from "../i18n/use-t.tsx";
import { Icon } from "../system/icon.tsx";
import { connections, sectionOf, sections, type SectionId } from "./sections.ts";
import "./shell.css";

type Host = {id: string; name: string};
type Row = ReturnType<typeof projectTree>[number];
export type SidebarApi = {
  projectVisibility(projectId: string, hidden: boolean): Promise<void>;
  repositoryVisibility(projectId: string, copyId: string, hidden: boolean): Promise<void>;
  removeSource(input: {projectId: string; sourceId: string; hostId: string; path: string; mode: "unlink" | "trash"}): Promise<void>;
  reload(): Promise<void>;
};
export type SidebarCounts = Partial<Record<SectionId, number | null>>;

/** The one navigation of the Git panel: search, sections, the projects folder tree, connections and the language. */
export function Sidebar({subPath, open, projects, copies, hosts, hiddenRepositories, hiddenProjects, loaded, error, counts, api}: {
  subPath: string; open(path: string): void; projects: Project[]; copies: Copy[]; hosts: Host[]; hiddenRepositories: string[];
  hiddenProjects: Project[]; loaded: boolean; error: string; counts: SidebarCounts; api: SidebarApi;
}) {
  const t = useT();
  const {language, choose} = useLanguage();
  const groups = useMemo(() => projectTree(projects, copies), [projects, copies]);
  const [query, setQuery] = useState("");
  const folders = useMemo(() => nestedFolders(groups, query), [groups, query]);
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const [manage, setManage] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{source: Source; mode: "unlink" | "trash"} | null>(null);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const search = useRef<HTMLInputElement>(null);
  const current = sectionOf(subPath);
  const copyOf = subPath.split("/")[0];

  // "/" puts the cursor in the search, unless one is already typing somewhere.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "/" || event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      // A page's own "/" (My PRs searches its list) and an open dialog keep it.
      if (document.querySelector("dialog[open]")) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
      event.preventDefault();
      search.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  async function act(run: () => Promise<void>) {
    setBusy(true);
    setNotice("");
    try { await run(); await api.reload(); }
    catch (err) { setNotice(err instanceof Error ? err.message : t("shell.failed")); }
    finally { setBusy(false); }
  }
  async function visibility(project: Project, hidden: boolean) {
    await api.projectVisibility(project.id, hidden);
    if (hidden && (subPath === "project/" + encodeURIComponent(project.id) || copies.some(copy => copy.projectId === project.id && copy.id === copyOf))) open("");
    setManage(null);
  }
  const toggle = (key: string) => setClosed(previous => {
    const next = new Set(previous);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });

  function actions(group: Row) {
    return <div className="git-source-actions">
      {group.repositories.length > 0 && <strong>{t("shell.repositories")}</strong>}
      {group.repositories.map(repo => {
        const hidden = hiddenRepositories.includes(JSON.stringify([group.id, repo.key]));
        return <button key={repo.key} disabled={busy} onClick={() => void act(async () => {
          await api.repositoryVisibility(group.id, repo.copies[0]!.id, !hidden);
          if (!hidden && repo.copies.some(copy => copy.id === copyOf)) open("project/" + encodeURIComponent(group.id));
        })}>{hidden ? t("shell.restore", {name: repo.name}) : t("shell.hideRepository", {name: repo.name})}</button>;
      })}
      <strong>{t("shell.sources")}</strong>
      {!group.sources?.length && <small>{t("shell.noSources")}</small>}
      {group.sources?.map(source => <div key={source.id} className="git-source-item">
        <small>{hosts.find(host => host.id === source.hostId)?.name ?? source.hostId}{source.isDefault && " · " + t("shell.defaultSource")}</small>
        <code>{source.path}</code>
        {confirm?.source.id === source.id ? <>
          <strong>{confirm.mode === "trash" ? t("shell.confirmTrash") : t("shell.confirmUnlink")}</strong>
          {confirm.mode === "trash" && <input aria-label={t("shell.typePath")} placeholder={t("shell.typePath")} value={typed} onChange={event => setTyped(event.target.value)}/>}
          <button disabled={busy || (confirm.mode === "trash" && typed !== source.path)} onClick={() => void act(async () => {
            await api.removeSource({projectId: group.id, sourceId: source.id, path: source.path, hostId: source.hostId, mode: confirm.mode});
            setNotice(confirm.mode === "trash" ? t("shell.trashed") : t("shell.unlinked"));
            setConfirm(null);
          })}>{t("common.confirm")}</button>
          <button disabled={busy} onClick={() => setConfirm(null)}>{t("common.cancel")}</button>
        </> : <>
          <button disabled={busy} onClick={() => setConfirm({source, mode: "unlink"})}>{t("shell.unlink")}</button>
          <button disabled={busy} onClick={() => { setTyped(""); setConfirm({source, mode: "trash"}); }}>{t("shell.trash")}</button>
        </>}
      </div>)}
      {group.id && <button disabled={busy} onClick={() => void act(() => visibility(group, true))}>{t("shell.hideProject")}</button>}
    </div>;
  }

  function folderView(folder: FolderNode, depth: number) {
    const expanded = Boolean(query.trim()) || !closed.has(folder.key);
    return <li key={folder.key}>
      <button className="g-tree dir" style={{paddingLeft: 8 + depth * 14}} aria-expanded={expanded} disabled={Boolean(query.trim())}
        aria-label={(expanded ? t("shell.folderCollapse", {name: folder.label || t("shell.noFolder")}) : t("shell.folderExpand", {name: folder.label || t("shell.noFolder")}))}
        onClick={() => toggle(folder.key)}>
        <Icon name={expanded ? "ChevronDown" : "ChevronRight"} small/>
        <span className="g-ell" title={folder.label || t("shell.noFolder")}>{folder.label || t("shell.noFolder")}</span>
        <span className="g-state">{folder.count}</span>
      </button>
      {expanded && <ul>
        {folder.rows.map(group => {
          const path = "project/" + encodeURIComponent(group.id);
          const here = subPath === path || group.repositories.some(repo => repo.copies.some(copy => copy.id === copyOf));
          return <li key={path}>
            <div className="g-tree-row">
              <button className="g-tree" style={{paddingLeft: 26 + depth * 14}} title={group.name} aria-current={here ? "location" : undefined} onClick={() => open(path)}>
                <span className="g-ell">{group.name}</span>
              </button>
              <button className="g-btn ghost sm g-tree-more" disabled={busy} aria-label={t("shell.manage", {name: group.name})} aria-expanded={manage === group.id}
                onClick={() => { setManage(manage === group.id ? null : group.id); setConfirm(null); setNotice(""); }}>
                <Icon name="MoreHorizontal" small/>
              </button>
            </div>
            {manage === group.id && actions(group)}
          </li>;
        })}
        {folder.children.map(child => folderView(child, depth + 1))}
      </ul>}
    </li>;
  }

  const navItem = (section: typeof connections) => {
    const count = counts[section.id];
    return <button key={section.id} className="g-nav" aria-current={current === section.id ? "page" : undefined} onClick={() => open(section.path)}>
      <Icon name={section.icon}/>
      <span className="g-ell">{t(section.label)}</span>
      {count ? <span className={"g-count" + (section.id === "inbox" ? " hot" : "")} aria-label={section.id === "reviews" ? t("shell.openThreads", {n: count})
        : section.id === "inbox" ? t("shell.unread", {n: count}) : t("shell.accounts", {n: count})}>{count}</span> : null}
    </button>;
  };

  return <nav className="git-ws g-side" aria-label={t("shell.nav")} lang={language}>
    <label className="g-find">
      <Icon name="Search" small/>
      <input ref={search} type="search" aria-label={t("shell.searchLabel")} placeholder={t("shell.search")} value={query}
        onChange={event => setQuery(event.target.value)}/>
      <kbd className="g-kbd" aria-hidden="true">/</kbd>
    </label>
    <div className="g-side-sections">{sections.map(navItem)}</div>
    <div className="g-sec g-side-label">{t("shell.folder")}</div>
    {notice && <p role="status" className="g-side-note">{notice}</p>}
    <div className="g-side-tree" role="region" aria-label={t("shell.projectList")} tabIndex={0}>
      {error && <p role="alert" className="g-side-note g-bad">{error}</p>}
      {!loaded && <p role="status" className="g-side-note">{t("common.loading")}</p>}
      {loaded && !error && !folders.length && <p role="status" className="g-side-note">{t("shell.notFound")}</p>}
      <ul>{folders.map(folder => folderView(folder, 0))}</ul>
      {hiddenProjects.length > 0 && <details className="g-side-hidden"><summary>{t("shell.hiddenProjects", {n: hiddenProjects.length})}</summary>
        {hiddenProjects.map(project => <button key={project.id} className="g-btn ghost sm" disabled={busy}
          onClick={() => void act(() => visibility(project, false))}>{t("shell.restore", {name: project.name})}</button>)}</details>}
    </div>
    <div className="g-side-foot">
      {navItem(connections)}
      <div className="g-side-language">
        <span id="git-language-label">{t("shell.language")}</span>
        <div className="g-seg" role="group" aria-labelledby="git-language-label">
          {(["ru", "en"] as const).map(code => <button key={code} aria-pressed={language === code} lang={code}
            title={code === "ru" ? "Русский" : "English"} onClick={() => choose(code)}>{code.toUpperCase()}</button>)}
        </div>
      </div>
    </div>
  </nav>;
}
