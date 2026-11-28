import { useEffect, useState } from "react";
import { clonePath } from "../../core/catalog/catalog.ts";
import { Dialog } from "../system/dialog.tsx";
import { Icon } from "../system/icon.tsx";
import { useT } from "../i18n/use-t.tsx";
import type { CatalogApi, CatalogView, RemoteRow } from "./catalog-api.ts";

export type Host = {id: string; name: string};
import { message } from "../ci/ci-api.ts";

/**
 * Where to clone a repository: the machine, a category folder of its projects folder and a folder name, with the path
 * that will be made. The server's preview of the clone (account, clone URL, destination) is shown in the same dialog
 * and confirmed there; nothing is cloned before that.
 */
export function CloneDialog({row, view, hosts, hostId, api, onClose, onDone}: {row: RemoteRow; view: CatalogView; hosts: Host[]; hostId: string;
  api: CatalogApi; onClose(): void; onDone(): void}) {
  const t = useT();
  const [host, setHost] = useState(hostId);
  // Another machine has a projects folder and categories of its own.
  const [place, setPlace] = useState<{root: string; categories: string[]} | null>({root: view.root, categories: view.categories});
  const [category, setCategory] = useState(view.categories.includes("") ? "" : view.categories[0] ?? "");
  const [name, setName] = useState(row.repo.name);
  const [preview, setPreview] = useState<{id: string; lines: string[]} | null>(null);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  useEffect(() => {
    // Back on the catalog's machine: its own categories, and a category chosen on another machine is not kept.
    const pick = (categories: string[]) => setCategory(current => categories.includes(current) ? current : categories.includes("") ? "" : categories[0] ?? "");
    if (host === hostId) { setPlace({root: view.root, categories: view.categories}); pick(view.categories); return; }
    let active = true;
    setPlace(null); setError("");
    api.catalog(host, false).then(other => {
      if (!active) return;
      setPlace({root: other.root, categories: other.categories});
      pick(other.categories);
    }, failure => { if (active) setError(message(failure)); });
    return () => { active = false; };
  }, [api, host, hostId, view]);
  const destination = place ? clonePath(place.root, category, name.trim()) : null;
  const review = () => {
    if (!destination) return;
    setPending(true); setError("");
    api.prepareClone(row.repo, host, destination).then(setPreview, failure => setError(message(failure))).finally(() => setPending(false));
  };
  const confirm = () => {
    if (!preview) return;
    setPending(true); setError("");
    api.clone(preview.id).then(() => onDone(), failure => { setError(message(failure)); setPending(false); });
  };
  const title = t("ct.clone-title", {path: row.repo.path});
  return <Dialog wide title={title} busy={pending} onClose={onClose} actions={preview ? <>
    <button type="button" className="g-btn" disabled={pending} onClick={() => { setPreview(null); setError(""); }}>{t("ct.back")}</button>
    <button type="button" className="g-btn pri" disabled={pending} onClick={confirm}><Icon name="Download" small/>{pending ? t("ct.cloning") : t("ct.clone-confirm")}</button>
  </> : <>
    <button type="button" className="g-btn" disabled={pending} onClick={onClose}>{t("common.cancel")}</button>
    <button type="submit" form="git-clone-form" className="g-btn pri" disabled={pending || !destination}><Icon name="Download" small/>{pending ? t("ct.working") : t("ct.clone-go")}</button>
  </>}>
    {preview ? <div className="git-clone-preview">
      <p>{t("ct.clone-check")}</p>
      <ul className="git-clone-lines">{preview.lines.map((line, index) => <li key={index} className="g-mono">{line}</li>)}</ul>
    </div> : <form id="git-clone-form" className="git-clone-form" onSubmit={event => { event.preventDefault(); review(); }}>
      <label className="git-field">{t("ct.machine")}
        <select className="g-inp" value={host} disabled={hosts.length < 2} onChange={event => { setHost(event.target.value); setPreview(null); }}>
          {hosts.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      <div className="git-field" role="group" aria-labelledby="git-clone-category">
        <span id="git-clone-category">{t("ct.category")}</span>
        {place ? <div className="g-seg git-clone-categories">{place.categories.map(value => <button key={value} type="button" aria-pressed={category === value}
          onClick={() => setCategory(value)}>{value || t("ct.category-root")}</button>)}</div> : <span className="g-muted" role="status">{t("common.loading")}</span>}
      </div>
      <label className="git-field">{t("ct.folder")}
        <input className="g-inp" value={name} onChange={event => setName(event.target.value)}/></label>
      <p className="git-clone-where"><Icon name="Folder" small/>{destination
        ? <span>{t("ct.will-create")} <span className="g-mono">{destination}</span></span>
        : <span className="g-warn">{place ? t("ct.bad-name") : t("common.loading")}</span>}</p>
    </form>}
    {error && <div className="g-banner bad git-clone-error" role="alert">{error}</div>}
  </Dialog>;
}
