import type { Account } from "../providers.ts";
import type { Copy } from "../workspace.ts";
import { pickAccount, type AccountChoice, type GithubFacts } from "./account-pick.ts";
import { azureOrganization, parseRemote, providerPath, type RemoteRef } from "./remote-url.ts";
import { forgeResolver, type CachedForge, type Detection } from "./resolve.ts";

export type LinkTarget = {accountId: string; repoId: string};
export type LinkPorts = {
  /** `origin` URL of the copy, read on the copy's host. */
  origin(copy: Copy): Promise<string>;
  /** `ssh -G` on the given BB host. */
  sshHostname(hostId: string, alias: string): Promise<string>;
  /** Credential-free version probe, run from the given BB host so private servers are reachable. */
  probe(hostId: string, origin: string): Promise<"gitea" | "gitlab" | null | "unreachable">;
  /** Forge answers, keyed by BB host and server name. */
  cache: {get(key: string): Promise<CachedForge | undefined>; set(key: string, value: CachedForge): Promise<void>};
  now(): number;
  accounts(): Promise<Account[]>;
  facts: GithubFacts;
  /** Finds the provider repository and remembers it for the account; returns its HTTPS clone URL. */
  lookup(accountId: string, path: string): Promise<{target: LinkTarget; clone: string}>;
  links: {get(copy: Copy): Promise<LinkTarget | undefined>; set(copy: Copy, target: LinkTarget): Promise<void>};
};
export type ForgeStatus = {
  remote: {host: string; path: string} | null;
  detection: Detection | null;
  candidates: Account[];
  chosen: string | null;
  reason: AccountChoice["reason"] | "linked";
  linked: LinkTarget | null;
  error: string | null;
};
type Place = {detection: Detection; path: string | null; organization: string | null};

const codeOf = (error: unknown) => error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : "PROVIDER_UNAVAILABLE";

export function forgeLinks(ports: LinkPorts) {
  const resolvers = new Map<string, ReturnType<typeof forgeResolver>>();
  const resolverFor = (hostId: string) => {
    let resolver = resolvers.get(hostId);
    if (!resolver) {
      resolver = forgeResolver({
        sshHostname: alias => ports.sshHostname(hostId, alias),
        probe: origin => ports.probe(hostId, origin),
        cache: {get: host => ports.cache.get(hostId + "/" + host), set: (host, value) => ports.cache.set(hostId + "/" + host, value)},
        now: ports.now,
      });
      resolvers.set(hostId, resolver);
    }
    return resolver;
  };

  /** A server the user configured an account for is that account's forge, whatever its name. */
  async function configured(host: string, port: number | null = null): Promise<Detection | null> {
    for (const account of await ports.accounts()) {
      try {
        const url = new URL(account.origin);
        if (url.hostname.toLowerCase() !== host) continue;
        // An https remote names the web port; SSH ports say nothing about it.
        if (port !== null && port !== Number(url.port || 443)) continue;
        const origin = url.hostname === "api.github.com" ? "https://github.com" : url.origin;
        return {kind: account.kind, origin, host, status: "known"};
      } catch { continue; }
    }
    return null;
  }

  async function place(hostId: string, remote: RemoteRef, recheck = false): Promise<Place> {
    const webPort = remote.transport === "https" ? remote.port ?? 443 : null;
    let detection = await configured(remote.host, webPort) ?? await resolverFor(hostId).resolve(remote, {recheck});
    if (!detection.kind) detection = await configured(detection.host, webPort) ?? detection;
    const resolved = {...remote, host: detection.host};
    return {
      detection,
      path: detection.kind ? providerPath(detection.kind, resolved) : null,
      organization: detection.kind === "azure" ? azureOrganization(resolved) : null,
    };
  }

  /** Null when the copy has no forge remote; errors (host offline, ssh) propagate with their code. */
  async function locate(copy: Copy, recheck = false) {
    const remote = parseRemote(await ports.origin(copy));
    return remote ? place(copy.hostId, remote, recheck) : null;
  }

  /** Forge kind, server, Azure organization and provider path, case-insensitive. */
  async function identity(hostId: string, remote: RemoteRef) {
    const found = await place(hostId, remote);
    if (!found.detection.kind || !found.path) return null;
    return [found.detection.kind, found.detection.origin, found.organization ?? "", found.path.toLowerCase()].join("|");
  }

  async function originMatches(copy: Copy, clone: string) {
    const origin = parseRemote(await ports.origin(copy));
    const provider = parseRemote(clone);
    if (!origin || !provider) return false;
    const [left, right] = await Promise.all([identity(copy.hostId, origin), identity(copy.hostId, provider)]);
    return left !== null && left === right;
  }

  /** Accounts that may serve this place: Azure accounts only of the remote's organization. */
  async function accountsFor(found: Place) {
    const accounts = await ports.accounts();
    return found.detection.kind === "azure"
      ? accounts.filter(account => account.kind !== "azure" || account.organization.toLowerCase() === found.organization)
      : accounts;
  }

  async function connect(copy: Copy, accountId: string, known?: Place) {
    const found = known ?? await locate(copy);
    if (!found?.path) throw new Error("NO_ORIGIN");
    const choice = await pickAccount(found.detection, found.path, await accountsFor(found), {orgs: async () => [], canSee: async () => false});
    if (!choice.candidates.includes(accountId)) throw new Error("ACCESS_DENIED");
    const {target, clone} = await ports.lookup(accountId, found.path);
    if (!await originMatches(copy, clone)) throw new Error("REMOTE_MISMATCH");
    await ports.links.set(copy, target);
    return target;
  }

  return {
    connect: (copy: Copy, accountId: string) => connect(copy, accountId),
    originMatches,
    async status(copy: Copy, options: {recheck?: boolean} = {}): Promise<ForgeStatus> {
      const linked = await ports.links.get(copy) ?? null;
      const empty = {candidates: [], chosen: linked?.accountId ?? null, reason: linked ? "linked" as const : "none" as const, linked};
      let found: Place | null;
      try { found = await locate(copy, options.recheck); }
      catch (error) { return {...empty, remote: null, detection: null, error: codeOf(error)}; }
      if (!found) return {...empty, remote: null, detection: null, error: null};
      const remote = {host: found.detection.host, path: found.path ?? ""};
      if (linked || !found.path || found.detection.status === "unreachable") return {...empty, remote, detection: found.detection, error: null};
      const accounts = await accountsFor(found);
      const choice = await pickAccount(found.detection, found.path, accounts, ports.facts);
      const base = {
        remote, detection: found.detection, candidates: accounts.filter(account => choice.candidates.includes(account.id)),
        chosen: choice.chosen, reason: choice.reason,
      };
      if (!choice.chosen) return {...base, linked: null, error: null};
      try {
        return {...base, linked: await connect(copy, choice.chosen, found), error: null};
      } catch (error) {
        return {...base, linked: null, error: codeOf(error)};
      }
    },
  };
}
