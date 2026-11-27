import { useEffect, useState } from "react";
import type { Account } from "../core/providers.ts";
import { ConnectionWizard, type ConnectionApi } from "./connection-wizard.tsx";
import { PageHead } from "./shell/page-head.tsx";

const kinds = {azure: "Azure Repos", gitea: "Gitea", gitlab: "GitLab", github: "GitHub"};

/**
 * Connected forge accounts, a new connection, and the way to the accounts' repositories. Moved as it was from the
 * projects page's head into its own section; its redesign is R7.
 */
export function ConnectionsPage({api, title, onBrowse, onChanged}: {
  api: ConnectionApi & {accounts(): Promise<Account[]>}; title: string; onBrowse(): void; onChanged?(): void;
}) {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [error, setError] = useState("");
  const [connecting, setConnecting] = useState(false);
  useEffect(() => {
    let active = true;
    api.accounts().then(value => { if (active) setAccounts(value); }, (failure: unknown) => { if (active) setError(failure instanceof Error ? failure.message : String(failure)); });
    return () => { active = false; };
  }, [api]);
  return <div className="g-page">
    <PageHead title={title} actions={<>
      <button type="button" className="g-btn" onClick={onBrowse}>Browse provider repositories</button>
      <button type="button" className="g-btn pri" onClick={() => setConnecting(true)}>+ Add connection</button>
    </>}/>
    <section className="git-project-connections">
      {accounts.map(account => <div className="git-connection" key={account.id}>
        <span aria-hidden="true">⛓</span> <span>{account.label}</span>
        <span className="git-muted">{kinds[account.kind]}</span>
      </div>)}
      {error && <p role="alert" className="git-error">{error}</p>}
    </section>
    {connecting && <ConnectionWizard api={api} onClose={() => setConnecting(false)} onSaved={account => {
      setAccounts(previous => [...previous.filter(item => item.id !== account.id), account]);
      setConnecting(false);
      onChanged?.();
    }}/>}
  </div>;
}
