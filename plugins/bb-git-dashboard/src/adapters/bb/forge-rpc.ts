import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { forgeLinks } from "../../core/forge/links.ts";
import type { CachedForge } from "../../core/forge/resolve.ts";
import { failureFor, type Copy } from "../../core/workspace.ts";
import { accountFacts } from "./github-facts.ts";
import { hostContract } from "./host-contract.ts";
import type { remoteService } from "./remote-service.ts";

type Remote = ReturnType<typeof remoteService>;
type Target = {accountId: string; repoId: string};

/** Forge detection and automatic account linking for working copies. */
export function forgeLinking(bb: BbPluginApi, linkKey: (copy: Copy) => string, remote: () => Remote) {
  const host = bb.hosts.experimental_client({contract: hostContract});
  const kv = bb.storage.kv;
  const unwrap = <T extends {ok: boolean}>(result: T) => {
    if (!result.ok) throw new Error((result as unknown as {code: string}).code);
    return result as Extract<T, {ok: true}>;
  };
  const links = forgeLinks({
    origin: async copy => unwrap(await host.call("originUrl", {root: copy.root, identity: copy.identity}, {hostId: copy.hostId})).url,
    sshHostname: async (hostId, alias) => unwrap(await host.call("sshHostname", {alias}, {hostId})).hostname,
    probe: async (hostId, origin) => (await host.call("probeForge", {origin}, {hostId})).kind,
    cache: {
      get: key => kv.get<CachedForge>("forge-host/" + key),
      set: (key, value) => kv.set("forge-host/" + key, value),
    },
    now: Date.now,
    accounts: () => remote().accountList(),
    facts: accountFacts(id => remote().credential(id)),
    lookup: (accountId, path) => remote().lookup(accountId, path),
    links: {get: copy => kv.get<Target>(linkKey(copy)), set: (copy, target) => kv.set(linkKey(copy), target)},
  });
  return {
    originMatches: (copy: Copy, clone: string) => links.originMatches(copy, clone),
    status: async (copy: Copy, recheck: boolean) => {
      try { return {ok: true as const, value: await links.status(copy, {recheck})}; }
      catch (error) { return failureFor(error, "PROVIDER_UNAVAILABLE"); }
    },
    connect: async (copy: Copy, accountId: string) => {
      try { return {ok: true as const, target: await links.connect(copy, accountId)}; }
      catch (error) { return failureFor(error, "PROVIDER_UNAVAILABLE"); }
    },
  };
}
