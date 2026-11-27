import type { Account } from "../providers.ts";
import type { Copy } from "../workspace.ts";
import { pickAccount, type AccountChoice, type GithubFacts } from "./account-pick.ts";
import { parseRemote, providerPath, type RemoteRef } from "./remote-url.ts";
import { forgeResolver, type Detection, type ResolverPorts } from "./resolve.ts";

export type LinkTarget = {accountId: string; repoId: string};
export type LinkPorts = Pick<ResolverPorts, "probe" | "cache" | "now"> & {
  /** `origin` URL of the copy, read on the copy's host. */
  origin(copy: Copy): Promise<string>;
  /** `ssh -G` on the given BB host. */
  sshHostname(hostId: string, alias: string): Promise<string>;
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

const codeOf = (error: unknown) => error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : "PROVIDER_UNAVAILABLE";

export function forgeLinks(ports: LinkPorts) {
  const resolvers = new Map<string, ReturnType<typeof forgeResolver>>();
  const resolverFor = (hostId: string) => {
    let resolver = resolvers.get(hostId);
    if (!resolver) {
      resolver = forgeResolver({...ports, sshHostname: alias => ports.sshHostname(hostId, alias)});
      resolvers.set(hostId, resolver);
    }
    return resolver;
  };

  async function locate(copy: Copy, recheck = false) {
    let remote: RemoteRef | null = null;
    try { remote = parseRemote(await ports.origin(copy)); } catch { remote = null; }
    if (!remote) return null;
    const detection = await resolverFor(copy.hostId).resolve(remote, {recheck});
    const path = detection.kind ? providerPath(detection.kind, remote) : null;
    return {detection, path};
  }

  /** The repository identity used to compare remotes: forge server and provider path, case-insensitive. */
  async function identity(hostId: string, remote: RemoteRef) {
    const detection = await resolverFor(hostId).resolve(remote);
    const path = detection.kind ? providerPath(detection.kind, remote) : null;
    return detection.kind && path ? detection.kind + "|" + detection.origin + "|" + path.toLowerCase() : null;
  }

  async function sameAsOrigin(copy: Copy, clone: string) {
    const origin = parseRemote(await ports.origin(copy));
    const provider = parseRemote(clone);
    if (!origin || !provider) return false;
    const [left, right] = await Promise.all([identity(copy.hostId, origin), identity(copy.hostId, provider)]);
    return left !== null && left === right;
  }

  async function connect(copy: Copy, accountId: string, located?: {detection: Detection; path: string | null} | null) {
    const place = located === undefined ? await locate(copy) : located;
    if (!place?.path) throw new Error("NO_ORIGIN");
    const choice = await pickAccount(place.detection, place.path, await ports.accounts(), {orgs: async () => [], canSee: async () => false});
    if (!choice.candidates.includes(accountId)) throw new Error("ACCESS_DENIED");
    const {target, clone} = await ports.lookup(accountId, place.path);
    if (!await sameAsOrigin(copy, clone)) throw new Error("REMOTE_MISMATCH");
    await ports.links.set(copy, target);
    return target;
  }

  return {
    connect: (copy: Copy, accountId: string) => connect(copy, accountId),
    originMatches: sameAsOrigin,
    async status(copy: Copy, options: {recheck?: boolean} = {}): Promise<ForgeStatus> {
      const place = await locate(copy, options.recheck);
      const linked = await ports.links.get(copy) ?? null;
      const empty = {candidates: [], chosen: null, error: null};
      if (!place) return {...empty, remote: null, detection: null, reason: linked ? "linked" : "none", linked};
      const remote = {host: place.detection.host, path: place.path ?? ""};
      const accounts = await ports.accounts();
      const pool = (ids: string[]) => accounts.filter(account => ids.includes(account.id));
      if (linked) {
        return {...empty, remote, detection: place.detection, reason: "linked", linked, chosen: linked.accountId};
      }
      if (!place.path) return {...empty, remote, detection: place.detection, reason: "none", linked: null};
      const choice = await pickAccount(place.detection, place.path, accounts, ports.facts);
      const base = {remote, detection: place.detection, candidates: pool(choice.candidates), chosen: choice.chosen, reason: choice.reason};
      if (!choice.chosen) return {...base, linked: null, error: null};
      try {
        return {...base, linked: await connect(copy, choice.chosen, place), error: null};
      } catch (error) {
        return {...base, linked: null, error: codeOf(error)};
      }
    },
  };
}
