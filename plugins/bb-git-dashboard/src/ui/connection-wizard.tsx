import { useEffect, useRef, useState } from "react";
import { useModal } from "./system/dialog.tsx";
import { limitation } from "../core/forge/capabilities.ts";
import { connectionInput, detectProvider, type ConnectionCheck, type ConnectionInput } from "../core/connection.ts";
import type { Account } from "../core/providers.ts";
import "./connection-wizard.css";

export type ConnectionApi = {
  checkConnection(input:ConnectionInput):Promise<ConnectionCheck>;
  saveConnection(input:ConnectionInput):Promise<Account>;
};
const providerLabels = {github:"GitHub",azure:"Azure DevOps",gitea:"Gitea",gitlab:"GitLab"};
const steps = ["Provider","Token","Review"];
const errors:Record<string,string> = {
  INVALID_INPUT:"Check the provider address and required fields.",
  PROVIDER_DENIED:"The provider rejected the token or denied repository access.",
  PROVIDER_UNAVAILABLE:"Could not reach the provider. Check the address and try again.",
  CREDENTIAL_VAULT_UNAVAILABLE:"Credential Vault is enabled but unavailable. Check its status in BB Settings and retry.",
  CREDENTIAL_VAULT_MISSING:"This connection’s Credential Vault entry is missing.",
  CREDENTIAL_BINDING_CHANGED:"The saved credential belongs to a different provider account or server.",
  ACCOUNT_EXISTS:"This account is already connected.",
  REPO_LIMIT:"The workspace has reached its account limit.",
};

export function ConnectionWizard({api,onClose,onSaved}:{
  api:ConnectionApi;onClose():void;onSaved(account:Account):void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const [step,setStep] = useState(0);
  const [address,setAddress] = useState("");
  const [kind,setKind] = useState<ConnectionInput["kind"]| "">("");
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

  useModal(dialog);
  useEffect(() => {
    active.current = true;
    return () => {active.current = false;};
  },[]);
  useEffect(() => {heading.current?.focus();},[step]);

  const submit = async () => {
    setError("");
    if (!detection || !provider) {
      setError("Enter a Git URL and select a provider.");
      return;
    }
    const unsupported = limitation(provider,"repositories");
    if (unsupported) {
      setError(unsupported);
      return;
    }
    if (step === 0) {
      const draft = connectionInput.safeParse({kind:provider,origin:detection.origin,
        organization:provider === "azure" ? org : "",label:name || providerLabels[provider],username,token:"pending"});
      if (!draft.success || (provider === "azure" && (!org || !username.trim()))) {
        setError("Check the connection name, organization and Git username.");
        return;
      }
      setStep(1);
      return;
    }
    const input = connectionInput.safeParse({kind:provider,origin:detection.origin,
      organization:provider === "azure" ? org : "",label:name || providerLabels[provider],username,token:token.trim()});
    if (!input.success) {
      setError("Enter a token without spaces or line breaks.");
      return;
    }
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
      const code = cause instanceof Error ? cause.message : "";
      if (active.current) setError(errors[code] ?? "Could not complete the connection. Try again.");
    } finally {if (active.current) setBusy(false);}
  };

  return <dialog ref={dialog} className="git-connection-dialog" aria-labelledby="git-connect-title"
    onCancel={event => {event.preventDefault(); if (!busy) onClose();}}>
    <form onSubmit={event => {event.preventDefault(); if (!busy) void submit();}}>
      <header className="git-connection-heading">
        <div><h2 id="git-connect-title">Connect a Git provider</h2>
          <p className="git-muted">Give Git Workspace access to your repositories.</p></div>
        <button type="button" aria-label="Close connection wizard" disabled={busy} onClick={onClose}>×</button>
      </header>
      <ol className="git-connection-steps" aria-label="Connection steps">
        {steps.map((label,index) => <li key={label} aria-current={index === step ? "step" : undefined} data-complete={index < step}>
          <span aria-hidden="true">{index < step ? "✓" : index+1}</span>{label}
        </li>)}
      </ol>
      <div className="git-connection-body">
        <h3 ref={heading} tabIndex={-1}>{step === 0 ? "Where is your repository?" : step === 1 ? "Verify access" : "Review connection"}</h3>
        {step === 0 && <>
          <label>Git server or repository URL
            <input value={address} onChange={event => {setAddress(event.target.value); setKind("");setOrganization(null);setToken("");}}
              placeholder="https://github.com/owner/repo" autoComplete="off" required maxLength={1000}/>
          </label>
          {detection?.kind ? <p className="git-connection-context">Detected <strong>{providerLabels[detection.kind]}</strong> · {detection.origin}</p> :
            detection && <label>Provider type
              <select value={kind} onChange={event => setKind(event.target.value as typeof kind)} required>
                <option value="">Choose the server type</option>
                <option value="github">GitHub Enterprise</option><option value="gitlab">GitLab self-managed</option><option value="gitea">Gitea</option>
              </select>
            </label>}
          {provider === "azure" && <>
            <label>Azure DevOps organization<input required maxLength={100} value={org} onChange={event => setOrganization(event.target.value)} placeholder="Organization name"/></label>
            <label>Git username<input value={username} onChange={event => setUsername(event.target.value)} required maxLength={128} autoComplete="off"/></label>
          </>}
          <label>Connection name <span className="git-muted">Optional</span>
            <input value={name} onChange={event => setName(event.target.value)} maxLength={80}
              placeholder={provider ? providerLabels[provider] : "Team or account name"}/>
          </label>
        </>}
        {step === 1 && <>
          <p>Git Workspace will use a read request to check the token and list repositories you can access.</p>
          <p className="git-connection-context">Token destination <strong>{detection?.origin === "https://github.com" ? "https://api.github.com" : detection?.origin}</strong></p>
          <label>Personal access token
            <input type="password" value={token} onChange={event => setToken(event.target.value)} autoComplete="off"
              spellCheck={false} required maxLength={4096} aria-describedby="git-token-note"/>
          </label>
          <p id="git-token-note" className="git-muted">Use a token with repository read access. Saving uses Credential Vault when enabled and keeps a backup in BB’s secret settings.</p>
        </>}
        {step === 2 && checked && <>
          <p className="git-connection-context">{provider === "azure"
            ? <>Repository access verified for <strong>{org}</strong> · Azure DevOps</>
            : <>Access verified for <strong>{checked.username}</strong> · {provider && providerLabels[provider]}</>}</p>
          <p className="git-muted">{checked.repositories.length ? "Accessible repositories on the first page" : "The provider returned no accessible repositories."}</p>
          {!!checked.repositories.length && <ul className="git-connection-repositories">{checked.repositories.map((repo,index) => <li key={index}>{repo}</li>)}</ul>}
          {checked.hasMore && <p className="git-muted">More repositories are available in the catalog.</p>}
        </>}
        {error && <p className="git-error" role="alert">{error}</p>}
        {busy && <p className="git-muted" role="status">{step === 2 ? "Saving connection…" : "Checking provider access…"}</p>}
      </div>
      <footer className="git-connection-actions">
        <button type="button" disabled={busy} onClick={() => {
          if (!step) onClose();
          else {setError("");setChecked(undefined);if (step === 1) setToken("");setStep(step-1);}
        }}>{step === 0 ? "Cancel" : "Back"}</button>
        <button type="submit" className="git-primary" disabled={busy}>
          {step === 0 ? "Continue" : step === 1 ? "Check access" : "Save connection"}
        </button>
      </footer>
    </form>
  </dialog>;
}
