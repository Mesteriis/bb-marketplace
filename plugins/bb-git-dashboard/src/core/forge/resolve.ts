import type { RemoteRef } from "./remote-url.ts";

export type ForgeKind = "github" | "gitlab" | "gitea" | "azure";
export type Detection = {
  kind: ForgeKind | null;
  origin: string | null;
  host: string;
  status: "known" | "probed" | "cached" | "unknown" | "unreachable";
};
export type CachedForge = {kind: ForgeKind | null; checkedAt: number};
export type ResolverPorts = {
  /** `ssh -G <alias>` on the copy's host; returns the alias itself when no hostname is configured. */
  sshHostname(alias: string): Promise<string>;
  /** Credential-free version probe of a server origin. */
  probe(origin: string): Promise<"gitea" | "gitlab" | null | "unreachable">;
  cache: {get(host: string): Promise<CachedForge | undefined>; set(host: string, value: CachedForge): Promise<void>};
  now(): number;
};

const day = 86_400_000;
const foundTtl = 30 * day;
const unknownTtl = day;

function wellKnown(host: string): {kind: ForgeKind; origin: string} | null {
  if (host === "github.com") return {kind: "github", origin: "https://github.com"};
  if (host === "gitlab.com") return {kind: "gitlab", origin: "https://gitlab.com"};
  if (host === "dev.azure.com" || host === "ssh.dev.azure.com" || host.endsWith(".visualstudio.com")) {
    return {kind: "azure", origin: "https://dev.azure.com"};
  }
  return null;
}

export function forgeResolver(ports: ResolverPorts) {
  const aliases = new Map<string, Promise<string>>();
  const probes = new Map<string, Promise<Detection>>();

  function hostnameOf(remote: RemoteRef) {
    if (remote.transport !== "ssh") return Promise.resolve(remote.host);
    let pending = aliases.get(remote.host);
    if (!pending) {
      pending = ports.sshHostname(remote.host).then(name => name.trim().toLowerCase());
      aliases.set(remote.host, pending);
      pending.catch(() => aliases.delete(remote.host));
    }
    return pending;
  }

  async function probe(host: string, origin: string): Promise<Detection> {
    const result = await ports.probe(origin);
    const kind = result === "gitea" || result === "gitlab" ? result : null;
    await ports.cache.set(host, {kind, checkedAt: ports.now()});
    return {kind, origin, host, status: kind ? "probed" : result === "unreachable" ? "unreachable" : "unknown"};
  }

  return {
    async resolve(remote: RemoteRef, options: {recheck?: boolean} = {}): Promise<Detection> {
      const host = await hostnameOf(remote);
      const known = wellKnown(host);
      if (known) return {...known, host, status: "known"};
      if (!host.includes(".")) return {kind: null, origin: null, host, status: "unknown"};
      const origin = "https://" + host;
      if (!options.recheck) {
        const cached = await ports.cache.get(host);
        if (cached && ports.now() - cached.checkedAt < (cached.kind ? foundTtl : unknownTtl)) {
          return {kind: cached.kind, origin, host, status: "cached"};
        }
      }
      let pending = probes.get(host);
      if (!pending) {
        pending = probe(host, origin).finally(() => probes.delete(host));
        probes.set(host, pending);
      }
      return pending;
    },
  };
}
