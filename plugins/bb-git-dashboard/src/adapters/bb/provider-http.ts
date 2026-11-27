import type { Account } from "../../core/providers.ts";

export const segment = encodeURIComponent;
export type Json = Record<string, unknown>;
export function object(value: unknown): Json {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Json : {};
}
export function array(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
export function text(value: unknown): string { return typeof value === "string" ? value : ""; }
export function sha(value: unknown): string | null { return /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(text(value)) ? text(value) : null; }
export function originOf(account: Account) {
  const configured = new URL(account.origin);
  if (configured.protocol !== "https:" || configured.username || configured.password || configured.pathname !== "/" || configured.search || configured.hash) throw new Error("INVALID_INPUT");
  if (account.kind === "azure" && (configured.origin !== "https://dev.azure.com" || !/^[a-z0-9][a-z0-9-]{0,99}$/i.test(account.organization))) throw new Error("INVALID_INPUT");
  if (account.kind === "github" && configured.hostname === "github.com") return "https://api.github.com";
  return configured.origin;
}
export function cloneUrl(account: Account, value: unknown): string {
  const url = new URL(text(value));
  const api = originOf(account);
  const expected = api === "https://api.github.com" ? "https://github.com" : api;
  if (account.kind === "azure" && url.origin === expected && url.username && !url.password) url.username = "";
  if (url.origin !== expected || url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error("REMOTE_MISMATCH");
  if (account.kind === "azure" && !url.pathname.toLowerCase().startsWith("/" + account.organization.toLowerCase() + "/")) throw new Error("REMOTE_MISMATCH");
  return url.href;
}
type Options = {method?: "POST" | "PATCH" | "PUT"; body?: unknown; accept?: string; raw?: boolean;
  /** 404 and 405 mean the server has no such operation (older self-hosted versions). */
  unsupported?: boolean};
export type Http = (path: string, options?: Options) => Promise<{payload: unknown; headers: Headers}>;

export function authorization(account: Account, token: string) {
  return account.kind === "azure" ? "Basic " + Buffer.from(":" + token).toString("base64") : (account.kind === "gitea" ? "token " : "Bearer ") + token;
}

export function client(account: Account, token: string, send: typeof fetch): Http {
  const origin = originOf(account);
  if (!token || /[\r\n]/.test(token)) throw new Error("ACCOUNT_UNCONFIGURED");
  const basic = Buffer.from(":" + token).toString("base64");
  const header = authorization(account, token);
  return async (path, options = {}) => {
    const url = new URL(path, origin);
    if (url.origin !== origin) throw new Error("INVALID_INPUT");
    const writing = options.method !== undefined;
    try {
      const headers = new Headers({authorization:header, accept:options.accept ?? "application/json"});
      if (account.kind === "github") headers.set("X-GitHub-Api-Version", "2022-11-28");
      if (options.body !== undefined) headers.set("content-type", "application/json");
      const response = await send(url, {
        method:options.method ?? "GET", headers, redirect:"error", signal:AbortSignal.timeout(12_000),
        body:options.body === undefined ? undefined : JSON.stringify(options.body),
      });
      if (!response.ok) {
        await response.body?.cancel();
        if (options.unsupported && (response.status === 404 || response.status === 405)) throw new Error("PROVIDER_UNSUPPORTED");
        if (writing && response.status >= 500) throw new Error("OUTCOME_UNKNOWN");
        if ([401,403,404].includes(response.status)) throw new Error("PROVIDER_DENIED");
        if (response.status >= 500 || response.status === 429) throw new Error("PROVIDER_UNAVAILABLE");
        throw new Error("PROVIDER_REJECTED");
      }
      const reader = response.body?.getReader();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      if (reader) {
        try {
          for (;;) {
            const {done,value} = await reader.read();
            if (done) break;
            bytes += value.length;
            if (bytes > 768 * 1024) {
              await reader.cancel();
              throw new Error(writing ? "OUTCOME_UNKNOWN" : "GIT_OUTPUT_LIMIT");
            }
            chunks.push(value);
          }
        } finally { reader.releaseLock(); }
      }
      const raw = Buffer.concat(chunks).toString("utf8");
      const redact = (value: string) => value.replaceAll(token, "[redacted]").replaceAll(basic, "[redacted]");
      const payload = options.raw ? redact(raw) : raw ? JSON.parse(raw, (_, value) => typeof value === "string" ? redact(value) : value) : null;
      return {payload, headers:response.headers};
    } catch (error) {
      if (error instanceof Error && /^(OUTCOME_UNKNOWN|PROVIDER_DENIED|PROVIDER_REJECTED|PROVIDER_UNAVAILABLE|PROVIDER_UNSUPPORTED|GIT_OUTPUT_LIMIT)$/.test(error.message)) throw error;
      throw new Error(writing ? "OUTCOME_UNKNOWN" : "PROVIDER_UNAVAILABLE");
    }
  };
}
