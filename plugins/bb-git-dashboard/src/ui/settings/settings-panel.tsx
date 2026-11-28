import { useEffect, useState, type ReactNode } from "react";
import type { LanguageSetting } from "../../core/i18n/language.ts";
import type { MainSettings } from "../../core/settings/main.ts";
import { useLanguage, useT } from "../i18n/use-t.tsx";
import "./settings.css";

export type SettingValues = {projectsRoot: string; uiLanguage: LanguageSetting; overviewView: "list" | "board"; inboxNotifyCi: boolean;
  inboxNotifyComments: boolean; aiPermissionMode: "auto" | "accept-edits"; ciTemplatesFolder: string};

function Row({title, note, children, id}: {title: string; note: string; children: ReactNode; id: string}) {
  return <div className="git-set-row">
    <div className="git-set-text"><span id={id} className="git-set-title">{title}</span><span className="git-set-note">{note}</span></div>
    <div className="git-set-control">{children}</div>
  </div>;
}

function Switch({on, label, busy, onChange}: {on: boolean; label: string; busy: boolean; onChange(next: boolean): void}) {
  return <button type="button" role="switch" className="g-tog" aria-checked={on} aria-labelledby={label} disabled={busy} onClick={() => onChange(!on)}/>;
}

/** A path typed in and saved with its button (Enter too); Escape gives back the saved one. */
function PathField({value, labelledBy, busy, onSave, t}: {value: string; labelledBy: string; busy: boolean; onSave(next: string): void; t: ReturnType<typeof useT>}) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const changed = text.trim() !== value;
  return <form className="git-set-path" onSubmit={event => { event.preventDefault(); if (changed) onSave(text); }}>
    <input className="g-inp g-mono" aria-labelledby={labelledBy} value={text} spellCheck={false} onChange={event => setText(event.target.value)}
      onKeyDown={event => { if (event.key === "Escape" && changed) { event.preventDefault(); event.stopPropagation(); setText(value); } }}/>
    <button type="submit" className="g-btn" disabled={busy || !changed}>{t("st.save")}</button>
  </form>;
}

/**
 * The plugin's main settings in groups, in the plugin's language: the projects folder, the interface, notifications,
 * AI review and CI templates. Each change is written at once; the rest of the settings stay in BB's list below.
 */
export function SettingsPanel({values, onSet, onTest}: {values: SettingValues | null;
  onSet(change: MainSettings): Promise<string | null>; onTest(): Promise<string>}) {
  const t = useT();
  const {choose} = useLanguage();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [test, setTest] = useState<{sending: boolean; result: string}>({sending: false, result: ""});
  const set = (change: MainSettings) => {
    setBusy(true); setError("");
    onSet(change).then(problem => setError(problem ?? ""), (failure: unknown) => setError(failure instanceof Error ? failure.message : String(failure)))
      .finally(() => setBusy(false));
  };
  if (!values) return <p className="g-state-page" role="status">{t("common.loading")}</p>;
  return <div className="git-set">
    <header className="git-set-head"><h2>Makosh Git</h2><p className="g-muted">{t("st.sub")}</p></header>
    {error && <div className="g-banner bad git-set-error" role="alert">{error}</div>}
    <section aria-labelledby="git-set-projects"><h3 id="git-set-projects">{t("st.projects")}</h3>
      <Row id="git-set-root" title={t("st.root")} note={t("st.root-note")}>
        <PathField value={values.projectsRoot} labelledBy="git-set-root" busy={busy} t={t} onSave={projectsRoot => set({projectsRoot})}/></Row>
    </section>
    <section aria-labelledby="git-set-ui"><h3 id="git-set-ui">{t("st.interface")}</h3>
      <Row id="git-set-language" title={t("st.language")} note={t("st.language-note")}>
        <div className="g-seg" role="group" aria-labelledby="git-set-language">{(["auto", "ru", "en"] as const).map(option =>
          <button key={option} type="button" aria-pressed={values.uiLanguage === option} onClick={() => choose(option)}>
            {option === "auto" ? t("st.as-bb") : option === "ru" ? "Русский" : "English"}</button>)}</div></Row>
      <Row id="git-set-overview" title={t("st.overview")} note={t("st.overview-note")}>
        <div className="g-seg" role="group" aria-labelledby="git-set-overview">{(["list", "board"] as const).map(option =>
          <button key={option} type="button" aria-pressed={values.overviewView === option} disabled={busy} onClick={() => set({overviewView: option})}>
            {t(option === "list" ? "st.list" : "st.board")}</button>)}</div></Row>
    </section>
    <section aria-labelledby="git-set-alerts"><h3 id="git-set-alerts">{t("st.alerts")}</h3>
      <Row id="git-set-ci" title={t("st.alert-ci")} note={t("st.alert-ci-note")}>
        <Switch on={values.inboxNotifyCi} label="git-set-ci" busy={busy} onChange={inboxNotifyCi => set({inboxNotifyCi})}/></Row>
      <Row id="git-set-comments" title={t("st.alert-comments")} note={t("st.alert-comments-note")}>
        <Switch on={values.inboxNotifyComments} label="git-set-comments" busy={busy} onChange={inboxNotifyComments => set({inboxNotifyComments})}/></Row>
      <Row id="git-set-test" title={t("st.test")} note={t("st.test-note")}>
        <button type="button" className="g-btn" disabled={test.sending} onClick={() => {
          setTest({sending: true, result: ""});
          onTest().then(result => setTest({sending: false, result}), (failure: unknown) => setTest({sending: false, result: failure instanceof Error ? failure.message : t("st.test-failed")}));
        }}>{t("st.test-send")}</button></Row>
      {test.result && <p className="git-set-result" role="status">{test.result}</p>}
    </section>
    <section aria-labelledby="git-set-ai"><h3 id="git-set-ai">{t("cr.ai")}</h3>
      <Row id="git-set-approve" title={t("st.approve")} note={t("st.approve-note")}>
        <Switch on={values.aiPermissionMode === "auto"} label="git-set-approve" busy={busy}
          onChange={on => set({aiPermissionMode: on ? "auto" : "accept-edits"})}/></Row>
    </section>
    <section aria-labelledby="git-set-templates"><h3 id="git-set-templates">{t("st.templates")}</h3>
      <Row id="git-set-folder" title={t("st.folder")} note={t("st.folder-note")}>
        <PathField value={values.ciTemplatesFolder} labelledBy="git-set-folder" busy={busy} t={t} onSave={ciTemplatesFolder => set({ciTemplatesFolder})}/></Row>
    </section>
    <p className="git-set-more g-muted">{t("st.more")}</p>
  </div>;
}
