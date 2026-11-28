import { detectProvider, type ConnectionInput } from "../../core/connection.ts";
import type { AccountCheck } from "../../core/connections/health.ts";
import { account, type Account } from "../../core/providers.ts";
import { failureFor } from "../../core/workspace.ts";
import { forgePrefix } from "./forge-provider.ts";
import { client, object, originOf, text } from "./provider-http.ts";
import { provider } from "./provider.ts";

export async function checkConnection(input:ConnectionInput,id:string,send:typeof fetch = fetch) {
  const {token, ...metadata} = input;
  const detected = detectProvider(metadata.origin);
  if (!detected || (detected.kind && detected.kind !== metadata.kind) ||
      (metadata.kind === "azure" && (!metadata.organization || !metadata.username))) throw new Error("INVALID_INPUT");
  const draft = account.safeParse({...metadata,id,username:metadata.username || "pending"});
  if (!draft.success) throw new Error("INVALID_INPUT");
  originOf(draft.data);
  const transport = client(draft.data, token, send);
  let username = metadata.username;
  if (metadata.kind !== "azure") {
    const {payload} = await transport(forgePrefix(draft.data) + "/user");
    username = text(object(payload).login) || text(object(payload).username);
    if (!username) throw new Error("PROVIDER_DENIED");
  }
  const selected = account.safeParse({...draft.data,username});
  if (!selected.success) throw new Error("PROVIDER_DENIED");
  const result = await provider(selected.data,token,send).repositories(1);
  return {account:selected.data,username, repositories:result.items.map(repo => repo.path), hasMore:result.more};
}

/** GitHub's token end header ("2026-12-01 10:00:00 +0100" or "… UTC") as an ISO time; null when it is not one. */
function githubExpiry(value: string | null) {
  const match = value && /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) (?:UTC|([+-]\d{2})(\d{2}))$/.exec(value.trim());
  if (!match) return null;
  const at = Date.parse(match[1] + "T" + match[2] + (match[3] ? match[3] + ":" + match[4] : "Z"));
  return Number.isNaN(at) ? null : new Date(at).toISOString();
}
const isoDate = (value: unknown) => { const at = typeof value === "string" ? Date.parse(value) : NaN; return Number.isNaN(at) ? null : new Date(at).toISOString(); };

/**
 * Checks a stored account with its own token: the login it answers as, how many repositories its first page has, and
 * what the server says of the token — GitHub's scopes and end (classic tokens), GitLab's scopes and end, Gitea's
 * version. What a server does not say stays null. The token is in no answer.
 */
export async function accountCheck(selected: Account, token: string, send: typeof fetch = fetch, now = () => new Date().toISOString()): Promise<AccountCheck> {
  // The transport hides the token in bodies; headers are read here, so anything that carries it — or the hidden mark
  // standing in for it — is not taken. A login that does, is not a login.
  const carries = (value: string) => value.includes(token) || value.includes("[redacted]");
  const clean = (value: string | null) => value !== null && carries(value) ? null : value;
  try {
    const transport = client(selected, token, send);
    const prefix = forgePrefix(selected);
    let login = selected.username;
    let scopes: string[] | null = null;
    let expiresAt: string | null = null;
    let version: string | null = null;
    if (selected.kind !== "azure") {
      const {payload, headers} = await transport(prefix + "/user");
      login = text(object(payload).login) || text(object(payload).username);
      if (!login) throw new Error("PROVIDER_DENIED");
      if (carries(login)) throw new Error("PROVIDER_REJECTED");
      if (selected.kind === "github") {
        const listed = headers.get("x-oauth-scopes");
        scopes = listed === null ? null : listed.split(",").map(scope => scope.trim()).filter(scope => scope && !carries(scope));
        expiresAt = githubExpiry(clean(headers.get("github-authentication-token-expiration")));
      }
      // Optional facts: a server that does not answer them leaves them unknown, not the check failed.
      if (selected.kind === "gitlab") await transport(prefix + "/personal_access_tokens/self").then(({payload: self}) => {
        const own = object(self);
        scopes = Array.isArray(own.scopes) ? own.scopes.filter((scope): scope is string => typeof scope === "string" && !carries(scope)) : null;
        expiresAt = isoDate(own.expires_at);
      }, () => {});
      if (selected.kind === "gitea") await transport(prefix + "/version").then(({payload: about}) => { version = clean(text(object(about).version) || null); }, () => {});
    }
    const first = await provider(selected, token, send).repositories(1);
    return {ok: true, login, repositories: first.items.length, more: first.more, scopes, expiresAt, version, checkedAt: now()};
  } catch (error) {
    return {ok: false, code: failureFor(error, "PROVIDER_UNAVAILABLE").code};
  }
}
