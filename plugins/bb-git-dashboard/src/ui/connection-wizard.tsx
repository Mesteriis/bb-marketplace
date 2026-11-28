import { useEffect, useRef, useState } from "react";
import { connectionInput, detectProvider, type ConnectionCheck, type ConnectionInput } from "../core/connection.ts";
import { limitation } from "../core/forge/capabilities.ts";
import type { MessageKey } from "../core/i18n/dictionary.ts";
import type { Account } from "../core/providers.ts";
import { useT } from "./i18n/use-t.tsx";
import { Dialog } from "./system/dialog.tsx";
import { Icon } from "./system/icon.tsx";
import "./connections.css";

export type ConnectionApi = {
  checkConnection(input:ConnectionInput):Promise<ConnectionCheck>;
  saveConnection(input:ConnectionInput):Promise<Account>;
};
type Kind = ConnectionInput["kind"];
const providerLabels: Record<Kind, string> = {github:"GitHub",azure:"Azure DevOps",gitea:"Gitea",gitlab:"GitLab"};
const steps = ["cw.step.type","cw.step.access","cw.step.check"] as const;
const known = ["INVALID_INPUT","PROVIDER_DENIED","PROVIDER_UNAVAILABLE","CREDENTIAL_VAULT_UNAVAILABLE","CREDENTIAL_VAULT_MISSING",
  "CREDENTIAL_BINDING_CHANGED","ACCOUNT_EXISTS","REPO_LIMIT"];
/**
 * The server types to choose from. A hosted one fills its address; a server of one's own takes the type for the address
 * typed above (a hosted address already says its type).
 */
const types: {id: string; kind: Kind; title: string; note: MessageKey | null; origin: string | null}[] = [
  {id:"github",kind:"github",title:"GitHub",note:null,origin:"https://github.com"},
  {id:"github-own",kind:"github",title:"GitHub Enterprise",note:"cw.own",origin:null},
  {id:"gitlab",kind:"gitlab",title:"GitLab",note:null,origin:"https://gitlab.com"},
  {id:"gitlab-own",kind:"gitlab",title:"GitLab self-managed",note:"cw.own",origin:null},
  {id:"gitea",kind:"gitea",title:"Gitea",note:"cw.own",origin:null},
  {id:"azure",kind:"azure",title:"Azure DevOps",note:"cw.org",origin:"https://dev.azure.com/"},
];

/**
 * Connecting a forge account in three steps: the server type (from a repository address, or a chosen type), access
 * (the token), and the check — the login and repositories the token opens — before the connection is saved.
 */
export function ConnectionWizard({api,onClose,onSaved,initialAddress = ""}:{
  api:ConnectionApi;onClose():void;onSaved(account:Account):void;initialAddress?:string;
}) {
  const t = useT();
  const heading = useRef<HTMLHeadingElement>(null);
  const [step,setStep] = useState(0);
  const [address,setAddress] = useState(initialAddress);
  const [kind,setKind] = useState<Kind | "">("");
  const [organization,setOrganization] = useState<string|null>(null);
  const [name,setName] = useState("");
  const [username,setUsername] = useState("");
  const [token,setToken] = useState("");
  const [checked,setChecked] = useState<ConnectionCheck>();
  const [busy,setBusy] = useState(false);
  const [error,setError] = useState("");
  const detection = detectProvider(address);
  const provider = detection?.kind ?? kind;
  const org = organization ?? detection?.organization ?? "";
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {active.current = false;};
  },[]);
  useEffect(() => {if (step) heading.current?.focus();},[step]);
  const failed = (cause: unknown) => {
    const code = cause instanceof Error ? cause.message : "";
    return known.includes(code) ? t(("cw.e." + code) as MessageKey) : t("cw.e.other");
  };
  const choose = (type: typeof types[number]) => {
    setError("");
    if (type.origin) { setAddress(type.origin); setKind(""); setOrganization(null); setToken(""); return; }
    // A server of one's own: its address is typed above; a hosted address keeps its own type.
    if (detection?.kind && detection.kind !== type.kind) setAddress("");
    setKind(type.kind);
  };
  const chosen = (type: typeof types[number]) => provider === type.kind && (type.origin
    ? detection?.origin === type.origin.replace(/\/$/, "") || (type.kind === "azure" && detection?.kind === "azure")
    : !detection?.kind && kind === type.kind);
  const label = name.trim() || (provider ? providerLabels[provider] : "");

  const submit = async () => {
    setError("");
    if (!detection || !provider) { setError(t("cw.e.address")); return; }
    const unsupported = limitation(provider,"repositories");
    if (unsupported) { setError(unsupported); return; }
    if (step === 0) {
      const draft = connectionInput.safeParse({kind:provider,origin:detection.origin,organization:provider === "azure" ? org : "",label,username,token:"pending"});
      if (!draft.success || (provider === "azure" && (!org || !username.trim()))) { setError(t("cw.e.fields")); return; }
      setStep(1);
      return;
    }
    const input = connectionInput.safeParse({kind:provider,origin:detection.origin,organization:provider === "azure" ? org : "",label,username,token:token.trim()});
    if (!input.success) { setError(step === 2 ? t("cw.e.name") : t("cw.e.token")); return; }
    setBusy(true);
    try {
      if (step === 1) {
        const result = await api.checkConnection(input.data);
        if (!active.current) return;
        setChecked(result);
        setStep(2);
      } else {
        const result = await api.saveConnection(input.data);
        if (!active.current) return;
        setToken("");
        onSaved(result);
      }
    } catch (cause) {
      if (active.current) setError(failed(cause));
    } finally {if (active.current) setBusy(false);}
  };
  const back = () => { setError(""); setChecked(undefined); if (step === 1) setToken(""); setStep(step - 1); };

  return <Dialog wide title={t("cw.title")} busy={busy} onClose={onClose} actions={<>
    {step === 0 ? <button type="button" className="g-btn" disabled={busy} onClick={onClose}>{t("common.cancel")}</button>
      : <button type="button" className="g-btn" disabled={busy} onClick={back}><Icon name="ChevronLeft" small/>{t("cw.back")}</button>}
    <button type="submit" form="git-connect-form" className="g-btn pri" disabled={busy}>
      {step === 0 ? <>{t("cw.next")}<Icon name="ChevronRight" small/></> : step === 1 ? t("cw.check") : t("cw.save")}</button>
  </>}>
    <form id="git-connect-form" className="git-connect" onSubmit={event => {event.preventDefault(); if (!busy) void submit();}}>
      <ol className="git-connect-steps" aria-label={t("cw.steps")}>
        {steps.map((key,index) => <li key={key} aria-current={index === step ? "step" : undefined} data-done={index < step || undefined}>
          <span className="git-connect-mark" aria-hidden="true">{index < step ? <Icon name="Check" small/> : index + 1}</span>{t(key)}
          {index < step && <span className="g-sr"> — {t("cw.done")}</span>}
        </li>)}
      </ol>
      <h3 ref={heading} tabIndex={-1} className="g-sr">{t(steps[step]!)}</h3>
      {step === 0 && <>
        <p className="git-connect-lead">{t("cw.lead")}</p>
        <label className="git-connect-field"><span>{t("cw.address")}</span>
          <input className="g-inp" value={address} autoFocus onChange={event => {setAddress(event.target.value); setKind(""); setOrganization(null); setToken("");}}
            placeholder="https://github.com/owner/repo" autoComplete="off" maxLength={1000}/></label>
        {detection?.kind ? <p className="git-connect-found"><Icon name="CircleCheck" small/><span>{t("cw.detected")} <strong>{providerLabels[detection.kind]}</strong> · <span className="g-mono">{detection.origin}</span></span></p>
          : detection && <p className="git-connect-found g-muted"><Icon name="Info" small/><span>{t("cw.choose-own", {origin: detection.origin})}</span></p>}
        <h4 className="git-connect-group" id="git-connect-types">{t("cw.or-type")}</h4>
        <div className="git-connect-types" role="radiogroup" aria-labelledby="git-connect-types">
          {types.map(type => <button key={type.id} type="button" role="radio" aria-checked={chosen(type)} className="git-connect-type" onClick={() => choose(type)}>
            <strong>{type.title}</strong><span className="g-muted">{type.note ? t(type.note) : type.origin!.replace(/^https:\/\//, "").replace(/\/$/, "")}</span></button>)}
        </div>
        {provider === "azure" && <div className="git-connect-pair">
          <label className="git-connect-field"><span>{t("cw.azure-org")}</span><input className="g-inp" maxLength={100} value={org} onChange={event => setOrganization(event.target.value)}/></label>
          <label className="git-connect-field"><span>{t("cw.git-user")}</span><input className="g-inp" value={username} onChange={event => setUsername(event.target.value)} maxLength={128} autoComplete="off"/></label>
        </div>}
      </>}
      {step === 1 && <>
        <p className="git-connect-lead">{t("cw.access-lead")}</p>
        <p className="git-connect-found"><Icon name="Info" small/><span>{t("cw.destination")} <span className="g-mono">{detection?.origin === "https://github.com" ? "https://api.github.com" : detection?.origin}</span></span></p>
        <label className="git-connect-field"><span>{t("cw.token")}</span>
          <input className="g-inp" type="password" value={token} autoFocus onChange={event => setToken(event.target.value)} autoComplete="off"
            spellCheck={false} maxLength={4096} aria-describedby="git-token-note"/></label>
        <p id="git-token-note" className="git-connect-found g-muted"><Icon name="Info" small/><span>{t("cw.token-note")}</span></p>
      </>}
      {step === 2 && checked && <>
        <label className="git-connect-field"><span>{t("cw.name")}</span>
          <input className="g-inp" value={name} autoFocus onChange={event => setName(event.target.value)} maxLength={80} placeholder={provider ? providerLabels[provider] : ""}/></label>
        <ul className="git-connect-checks">
          <li><Icon name="CircleCheck" small/><span><strong>{t("cw.access-ok")}</strong>
            <span className="g-muted">{provider === "azure" ? t("cw.azure-ok", {org}) : t("cw.as", {login: checked.username})}</span></span></li>
          <li><Icon name={checked.repositories.length ? "CircleCheck" : "Info"} small/><span><strong>{checked.repositories.length ? t("cw.repos-ok") : t("cw.repos-none")}</strong>
            {checked.repositories.length > 0 && <span className="g-muted">{checked.repositories.slice(0, 3).join(", ")}
              {checked.repositories.length > 3 || checked.hasMore ? " · " + t(checked.hasMore ? "cw.more-catalog" : "cw.more", {n: checked.repositories.length - 3}) : ""}</span>}</span></li>
        </ul>
      </>}
      {error && <div className="g-banner bad git-connect-error" role="alert">{error}</div>}
      {busy && <p className="g-muted" role="status">{step === 2 ? t("cw.saving") : t("cw.checking")}</p>}
    </form>
  </Dialog>;
}
