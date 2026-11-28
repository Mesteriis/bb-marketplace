import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { accountHealth, remoteHosts, type AccountCheck, type Health } from "../core/connections/health.ts";
import { ago } from "../core/i18n/time.ts";
import type { Account } from "../core/providers.ts";
import { ConnectionWizard, type ConnectionApi } from "./connection-wizard.tsx";
import { useLanguage, useT } from "./i18n/use-t.tsx";
import { PageHead } from "./shell/page-head.tsx";
import { Icon } from "./system/icon.tsx";
import "./connections.css";
import type { RemoteOutcome } from "../core/publication.ts";
import { PublicationActivity } from "./publication-activity.tsx";

const kinds = {azure: "Azure DevOps", gitea: "Gitea", gitlab: "GitLab", github: "GitHub"};
type T = ReturnType<typeof useT>;
export type ConnectionsApi = ConnectionApi & {
  accounts(): Promise<Account[]>;
  /** The last check of an account (refresh false), or a new one with its stored token. */
  accountCheck(accountId: string, refresh: boolean): Promise<AccountCheck | null>;
  /** The writes done through the accounts, newest first. */
  activity(): Promise<RemoteOutcome[]>;
};
type Host = {id: string; name: string};
const hostOf = (origin: string) => { try { return new URL(origin).host; } catch { return origin; } };

function chip(health: Health, t: T) {
  const word = health.state === "ok" ? t("cn.ok") : health.state === "limited" ? t("cn.limited") : health.state === "expiring" ? t("cn.expiring")
    : health.state === "expired" ? t("cn.expired") : health.state === "other-login" ? t("cn.other-login") : t("cn.failed");
  return <span className={"g-chip " + health.tone}><Icon name={health.tone === "good" ? "CircleCheck" : health.tone === "warn" ? "AlertTriangle" : "CircleX"} small/>{word}</span>;
}

/** What a check said of an account, in one line: repositories, the token's rights or end, the server's version, when. */
function facts(account: Account, check: AccountCheck, health: Health, local: number, t: T, language: Parameters<typeof ago>[0]) {
  if (!check.ok) return [t("cn.code", {code: check.code})];
  const parts = [local ? t("cn.local", {n: local}) : t(check.more ? "cn.repos-more" : "cn.repos", {n: check.repositories})];
  if (check.scopes) parts.push(t("cn.scopes", {scopes: check.scopes.join(", ") || "—"}));
  if (health.state === "limited") parts.push(t(health.missing === "workflow" ? "cn.no-workflow" : "cn.no-api"));
  if (health.state === "expiring") parts.push(t("cn.ends", {n: health.days}));
  if (health.state === "other-login") parts.push(t("cn.login", {login: health.login, user: account.username}));
  if (check.version) parts.push(t("cn.version", {version: check.version}));
  const when = ago(language, Date.now(), check.checkedAt);
  parts.push(when === t("time.now") ? t("cn.checked-now") : t("cn.checked", {when}));
  return parts;
}

/**
 * Connected forge accounts with what a check of each found (its login, repositories, the token's rights and end), a new
 * connection, and the servers the projects folder's remotes use — with the account on each, or a way to connect one.
 */
export function ConnectionsPage({api, title, hosts, localKeys, onChanged}: {
  api: ConnectionsApi; title: string; hosts: Host[];
  /** The forge keys (host/path) of a machine's projects folder, for the table of servers. */
  localKeys(hostId: string): Promise<(string | null)[]>;
  onChanged?(): void;
}) {
  const t = useT();
  const {language} = useLanguage();
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [checks, setChecks] = useState<Map<string, AccountCheck | null>>(new Map());
  const [checking, setChecking] = useState<Set<string>>(new Set());
  const [keys, setKeys] = useState<(string | null)[] | null>(null);
  const [keysError, setKeysError] = useState("");
  const [error, setError] = useState("");
  const [connecting, setConnecting] = useState<{address: string} | null>(null);
  const hostId = hosts[0]?.id ?? "";
  // Each account's answers are numbered: the last check read or asked wins, so a slow read of the kept check cannot
  // overwrite a newer Check. Nothing is set once the page is gone.
  const order = useRef({next: 0, latest: new Map<string, number>(), live: true});
  useEffect(() => { order.current.live = true; return () => { order.current.live = false; }; }, []);
  const ask = useCallback((id: string, refresh: boolean) => {
    const number = ++order.current.next;
    order.current.latest.set(id, number);
    const keep = (found: AccountCheck | null) => {
      if (order.current.live && order.current.latest.get(id) === number) setChecks(previous => new Map(previous).set(id, found));
    };
    return api.accountCheck(id, refresh).then(keep, (failure: unknown) => { if (refresh) keep({ok: false, code: failure instanceof Error ? failure.message : "FAILED"}); });
  }, [api]);
  useEffect(() => {
    let active = true;
    api.accounts().then(value => {
      if (!active) return;
      setAccounts(value);
      for (const account of value) void ask(account.id, false);
    }, (failure: unknown) => { if (active) setError(failure instanceof Error ? failure.message : String(failure)); });
    return () => { active = false; };
  }, [api, ask]);
  useEffect(() => {
    if (!hostId) return;
    let active = true;
    localKeys(hostId).then(value => { if (active) setKeys(value); }, (failure: unknown) => { if (active) setKeysError(failure instanceof Error ? failure.message : String(failure)); });
    return () => { active = false; };
  }, [localKeys, hostId]);
  const check = useCallback((id: string) => {
    setChecking(previous => new Set(previous).add(id));
    void ask(id, true).finally(() => { if (order.current.live) setChecking(previous => { const next = new Set(previous); next.delete(id); return next; }); });
  }, [ask]);
  const servers = useMemo(() => keys ? remoteHosts(keys, accounts ?? []) : [], [keys, accounts]);
  const localOf = (account: Account) => servers.find(row => row.accounts.includes(account.id) && row.accounts.length === 1)?.repositories ?? 0;
  // Two servers on one host name (told apart by port) share a row: each account then says its forge.
  const label = (id: string, many: boolean) => { const own = accounts?.find(account => account.id === id); return own ? own.label + (many ? " (" + kinds[own.kind] + ")" : "") : id; };

  return <div className="g-page git-connections">
    <PageHead title={title} sub={t("cn.sub")} actions={<button type="button" className="g-btn pri" onClick={() => setConnecting({address: ""})}>
      <Icon name="Plus" small/>{t("cn.connect")}</button>}/>
    {error && <div className="g-banner bad" role="alert">{error}</div>}
    {!accounts && !error && <p className="g-state-page" role="status">{t("common.loading")}</p>}
    {accounts && !accounts.length && <div className="g-state-page" role="status"><strong>{t("cn.none")}</strong><span>{t("cn.none-hint")}</span></div>}
    {accounts && accounts.length > 0 && <ul className="git-connection-list" aria-label={t("cn.accounts")}>{accounts.map(account => {
      const found = checks.get(account.id);
      const health = found ? accountHealth(account, found, Date.now()) : null;
      const busy = checking.has(account.id);
      return <li key={account.id} className="git-connection-row">
        <Icon name="Cloud"/>
        <div className="git-connection-text">
          <div><strong>{kinds[account.kind]} · {account.label}</strong> <span className="g-muted">{hostOf(account.origin)}{account.organization ? "/" + account.organization : ""}</span></div>
          <div className="g-muted">{found && health ? facts(account, found, health, localOf(account), t, language).join(" · ") : found === null ? t("cn.never") : t("common.loading")}</div>
        </div>
        {health && chip(health, t)}
        <button type="button" className="g-btn sm" disabled={busy} onClick={() => check(account.id)}>{busy ? t("cn.checking") : t("cn.check")}</button>
      </li>;
    })}</ul>}
    <section className="git-connection-hosts" aria-labelledby="git-connection-hosts">
      <h2 id="git-connection-hosts" className="git-connection-group">{t("cn.hosts")}</h2>
      {keysError ? <div className="g-banner warn" role="status">{keysError}</div>
        : !keys ? <p className="g-state-page" role="status">{t("common.loading")}</p>
        : !servers.length ? <p className="g-state-page">{t("cn.no-hosts")}</p>
        : <div className="g-scroll"><table className="g-table" aria-labelledby="git-connection-hosts">
          <thead><tr><th>{t("cn.col.host")}</th><th>{t("cn.col.what")}</th><th>{t("cn.col.repos")}</th><th>{t("cn.col.account")}</th><th><span className="g-sr">{t("ct.col.actions")}</span></th></tr></thead>
          <tbody>{servers.map(row => <tr key={row.host}>
            <td className="g-mono">{row.host}</td>
            <td>{row.kind ? kinds[row.kind] : <span className="g-muted">{t("cn.unknown")}</span>}</td>
            <td className="g-num">{row.repositories}</td>
            <td>{row.accounts.length ? row.accounts.map(id => label(id, row.accounts.length > 1)).join(", ") : <span className="g-warn">{t("cn.no-account")}</span>}</td>
            <td className="git-catalog-act">{!row.accounts.length && <button type="button" className="g-btn sm" onClick={() => setConnecting({address: "https://" + row.host})}>
              {t("cn.connect-host")}</button>}</td>
          </tr>)}</tbody>
        </table></div>}
    </section>
    <PublicationActivity load={api.activity}/>
    {connecting && <ConnectionWizard api={api} initialAddress={connecting.address} onClose={() => setConnecting(null)} onSaved={account => {
      setAccounts(previous => [...(previous ?? []).filter(item => item.id !== account.id), account]);
      setConnecting(null);
      check(account.id);
      onChanged?.();
    }}/>}
  </div>;
}
