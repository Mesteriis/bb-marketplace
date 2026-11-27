import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { checkConnection } from "./connection.ts";
import type { ConnectionInput } from "../../core/connection.ts";
import { account, type CatalogPage } from "../../core/providers.ts";
import { remoteRequest, type Preview, type RemoteOutcome } from "../../core/publication.ts";
import { failureFor, type Copy } from "../../core/workspace.ts";
import { provider } from "./provider.ts";
import type { RepositorySection } from "../../core/repository-features.ts";
import { repositoryFeatures } from "./repository-features.ts";
import { client, originOf } from "./provider-http.ts";
import { credentialVault } from "./credential-vault.ts";
import { providerCredentials, type CredentialState } from "./provider-credentials.ts";
import { hostContract } from "./host-contract.ts";
import { prepareCiFile, publishCiFile } from "./ci-file.ts";

const catalogKey = (id: string, page: number) => "catalog/" + id + "/" + page;
const remoteLog = "remote-operation/";
const ttl = 5 * 60_000;
type Target = {accountId:string; repoId:string};

export function remoteService(bb: BbPluginApi, loadCopy: (id:string) => Promise<Copy | undefined>,
  saveCopy: (hostId:string,root:string,identity:string, metadata?: Pick<Copy,"repository"|"repositoryName">) => Promise<Copy>,
  originMatches: (copy:Copy, clone:string) => Promise<boolean>) {
  const settings = bb.settings.define({
    accounts: {type:"string",label:"Provider account declarations (JSON)",default:"[]"},
    tokens: {type:"string",label:"Provider API tokens by account ID (JSON)",secret:true},
  });
  const kv = bb.storage.kv;
  const vault = credentialVault(bb.sdk.plugins);
  const credentials = providerCredentials(vault,{
    get: id => kv.get<CredentialState>("provider-credential/" + id),
    set: (id,state) => kv.set("provider-credential/" + id,state),
  });
  const host = bb.hosts.experimental_client({contract:hostContract});
  const active = new Set<string>();
  const previews = new Map<string, {value:Preview; snapshot?:{branch:string;head:string}; generation:number; actor:string; base?:string | null}>();
  let generation = 0;
  let connectionWrites = Promise.resolve();
  settings.onChange(() => { generation++; previews.clear(); });
  bb.onDispose(() => previews.clear());

  function accounts(value: string) {
    const rows = z.array(account).max(50).parse(JSON.parse(value));
    if (new Set(rows.map(row => row.id)).size !== rows.length) throw new Error("INVALID_INPUT");
    for (const row of rows) originOf(row);
    return rows;
  }
  const tokenMap = z.record(z.string(),z.string());
  function backupToken(raw:string|undefined,id:string) {
    try {
      const backup = tokenMap.parse(JSON.parse(raw ?? "{}"));
      return Object.hasOwn(backup,id) ? backup[id] : undefined;
    } catch { return undefined; }
  }

  bb.background.service("provider-credential-migration", {
    async start(signal) {
      const stop = new Promise<void>(resolve => signal.addEventListener("abort",() => resolve(),{once:true}));
      try {
        if (await vault.enabled(signal)) {
          const current = await settings.get();
          for (const selected of accounts(current.accounts)) {
            if (signal.aborted) break;
            // A failed account remains intact and its next use reports the specific error.
            await credentials.resolve(selected,() => backupToken(current.tokens,selected.id),signal).catch(() => {});
          }
        }
      } catch { /* The next provider request will retry Vault discovery. */ }
      if (!signal.aborted) await stop;
    },
  });

  async function context(id: string) {
    const current = await settings.get();
    const selected = accounts(current.accounts).find(row => row.id === id);
    if (!selected) throw new Error("ACCOUNT_UNCONFIGURED");
    const token = await credentials.resolve(selected,() => backupToken(current.tokens,id));
    return {selected, api:provider(selected,token), token};
  }

  async function repository(target:Target) {
    const {selected,api,token} = await context(target.accountId);
    const entry = await kv.get<{account:string;item:Preview["repo"]}>("repository/" + selected.id + "/" + encodeURIComponent(target.repoId));
    if (!entry || entry.account !== JSON.stringify(selected)) throw new Error("NOT_FOUND");
    return {selected, api, token, repo:entry.item};
  }

  async function run<T>(action: () => Promise<T>, fallback = "PROVIDER_UNAVAILABLE") {
    try { return {ok:true as const,value:await action()}; }
    catch (error) { return failureFor(error,fallback); }
  }

  // SSH and HTTPS remotes of one repository match; HTTPS exchange still requires the exact origin on the host.
  async function assertOrigin(repo:Preview["repo"], copy:Copy) {
    if (!await originMatches(copy,repo.clone)) throw new Error("REMOTE_MISMATCH");
  }

  async function saveConnection(input:ConnectionInput) {
    const {account:selected} = await checkConnection(input,randomUUID());
    const write = connectionWrites.then(async () => {
      const current = await settings.get();
      const existing = accounts(current.accounts);
      const tokens = tokenMap.parse(JSON.parse(current.tokens ?? "{}"));
      if (existing.length >= 50) throw new Error("REPO_LIMIT");
      const sameIdentity = existing.some(row => row.kind === selected.kind && originOf(row) === originOf(selected) &&
        row.organization.toLowerCase() === selected.organization.toLowerCase() &&
        row.username.toLowerCase() === selected.username.toLowerCase());
      if (sameIdentity) throw new Error("ACCOUNT_EXISTS");
      if (await credentials.resolve(selected,() => input.token) !== input.token) throw new Error("CREDENTIAL_BINDING_CHANGED");
      await settings.experimental_set({
        accounts:JSON.stringify([...existing,selected]),tokens:JSON.stringify({...tokens,[selected.id]:input.token}),
      });
      return selected;
    });
    connectionWrites = write.then(() => {}, () => {});
    return write;
  }

  return {
    /** Account, token and provider repository of a linked target, with the copy's origin checked. */
    linked: async (target:Target, copy:Copy) => {
      const found = await repository(target);
      await assertOrigin(found.repo,copy);
      return {account:found.selected, token:found.token, repo:found.repo};
    },
    accountList: async () => accounts((await settings.get()).accounts),
    credential: async (id:string) => {
      const {selected,token} = await context(id);
      return {account:selected,token};
    },
    /** Finds one provider repository by path and remembers it like a catalog entry. */
    lookup: async (accountId:string, path:string) => {
      const {selected,api} = await context(accountId);
      const item = await api.repository(path);
      await kv.set("repository/" + accountId + "/" + encodeURIComponent(item.id),{account:JSON.stringify(selected),item});
      return {target:{accountId,repoId:item.id},clone:item.clone};
    },
    checkConnection: (input:ConnectionInput) => run(async () => {
      const {username,repositories,hasMore} = await checkConnection(input,"connection-check");
      return {username,repositories,hasMore};
    }),
    saveConnection: (input:ConnectionInput) => run(() => saveConnection(input)),
    matches: async (target:Target,copy:Copy) => assertOrigin((await repository(target)).repo,copy),
    features: (target:Target,copy:Copy,section:RepositorySection) => run(async () => {
      const {repo, selected, token} = await repository(target);
      await assertOrigin(repo,copy);
      return {repo,features:await repositoryFeatures(selected,repo,section,client(selected,token,fetch))};
    }),
    accounts: async () => {
      const result = await run(async () => accounts((await settings.get()).accounts),"INVALID_INPUT");
      return result.ok ? {ok:true as const,items:result.value} : result;
    },
    repositories: ({accountId,page,refresh}:{accountId:string; page:number; refresh:boolean}) => run(async () => {
      const {selected,api} = await context(accountId);
      const stamp = JSON.stringify(selected);
      const key = catalogKey(accountId,page);
      if (!refresh) {
        const saved = await kv.get<{stamp:string;value:CatalogPage}>(key);
        if (saved?.stamp === stamp) return saved.value;
      }
      const value = await api.repositories(page);
      for (const item of value.items) await kv.set("repository/" + accountId + "/" + encodeURIComponent(item.id),{account:stamp,item});
      await kv.set(key,{stamp,value});
      return value;
    }),
    pulls: async ({accountId,repoId,page}:Target & {page:number}) => {
      const result = await run(async () => {
        const {api,repo} = await repository({accountId,repoId});
        return api.pulls(repo,page);
      });
      return result.ok ? {ok:true as const,...result.value} : result;
    },
    pull: ({number,...target}:Target & {number:number}) => run(async () => {
      const {api,repo} = await repository(target);
      return api.details(repo,number);
    }),
    prepare: (input:z.infer<typeof remoteRequest>, actor="human") => run(async () => {
      const startGeneration = generation;
      const {selected,api,repo} = await repository(input);
      const {action} = input;
      const lines = [selected.kind + " · " + selected.origin + " · " + selected.label + " (" + selected.username + ")",repo.path + " · " + repo.clone];
      let base: string | null | undefined;
      let snapshot: {branch:string;head:string} | undefined;
      if (action.kind === "clone") lines.push(action.hostId + " · " + action.destination);
      else if (action.kind === "fetch" || action.kind === "push") {
        const copy = await loadCopy(action.copyId);
        if (!copy) throw new Error("NOT_FOUND");
        const result = await host.call("git",{root:copy.root,identity:copy.identity,action:{kind:"status"}},{hostId:copy.hostId}).catch(() => { throw new Error("HOST_UNAVAILABLE"); });
        if (!result.ok) throw new Error(result.code);
        lines.push(copy.hostId + " · " + copy.root + " · " + (result.value.branch ?? "Detached HEAD"));
        if (action.kind === "push") {
          if (repo.canPush === false) throw new Error("PROVIDER_DENIED");
          if (!result.value.branch || !result.value.head) throw new Error("STALE_HEAD");
          snapshot = {branch:result.value.branch,head:result.value.head};
          lines.push(snapshot.head + " → refs/heads/" + snapshot.branch);
        }
      } else if (action.kind === "ciFile") {
        const copy = await loadCopy(action.copyId);
        if (!copy) throw new Error("NOT_FOUND");
        await assertOrigin(repo,copy);
        const checked = await prepareCiFile(api,repo,action);
        base = checked.base;
        lines.push(...checked.lines);
      } else {
        const command = action.action;
        if (command.kind === "create") {
          if (await api.branch(repo,command.head) !== command.expected) throw new Error("STALE_HEAD");
          base = await api.branch(repo,command.base);
          lines.push(repo.path + ":" + command.head + " @ " + command.expected,repo.path + ":" + command.base + " @ " + base,command.title);
        } else {
          const candidate = await api.pull(repo,command.number);
          if (candidate.head.sha !== command.expected) throw new Error("STALE_HEAD");
          base = candidate.base.sha;
          lines.push("#" + candidate.number + " · " + candidate.title,
            candidate.head.repo + ":" + candidate.head.branch + " @ " + candidate.head.sha,
            candidate.base.repo + ":" + candidate.base.branch + " @ " + candidate.base.sha);
          if (command.kind === "review") lines.push("Reviewer · " + command.reviewer);
        }
      }
      if (generation !== startGeneration) throw new Error("PREVIEW_EXPIRED");
      for (const [id,record] of previews) if (Date.parse(record.value.expires) < Date.now()) previews.delete(id);
      if (previews.size >= 64) throw new Error("REPO_LIMIT");
      const value:Preview = {id:randomUUID(),account:selected,repo,action,lines,expires:new Date(Date.now()+ttl).toISOString()};
      previews.set(value.id,{value,snapshot,generation,actor,base});
      return value;
    }),
    publish: (id:string, actor="human") => run(async () => {
      const record = previews.get(id);
      if (record?.actor !== actor) throw new Error("PREVIEW_EXPIRED");
      previews.delete(id);
      if (!record || record.generation !== generation || Date.parse(record.value.expires) < Date.now()) throw new Error("PREVIEW_EXPIRED");
      const {value} = record;
      const target = {accountId:value.account.id,repoId:value.repo.id};
      const latest = await repository(target);
      if (record.generation !== generation || JSON.stringify(latest.selected) !== JSON.stringify(value.account)
        || JSON.stringify(latest.repo) !== JSON.stringify(value.repo)) throw new Error("PREVIEW_EXPIRED");
      const {action,repo} = value;
      if (action.kind === "pull") {
        const command = action.action;
        const base = command.kind === "create" ? await latest.api.branch(repo,command.base) : (await latest.api.pull(repo,command.number)).base.sha;
        if (base !== record.base) throw new Error("STALE_HEAD");
      }
      if (record.generation !== generation) throw new Error("PREVIEW_EXPIRED");
      const pending:RemoteOutcome = {id,kind:action.kind,target,status:"pending",actor,at:new Date().toISOString(),summary:value.lines};
      active.add(id);
      try {
        await kv.set(remoteLog+id,pending);
        let outcome:RemoteOutcome;
        try {
          if (action.kind === "pull") {
            const result = await latest.api.mutate(repo,action.action);
            outcome = {...pending,status:result.outcome,pullNumber:result.number};
          } else if (action.kind === "ciFile") {
            const result = await publishCiFile(latest.api,repo,action,record.base!);
            // RPC answers carry no undefined values: absent fields are left out.
            outcome = {...pending,status:result.status,summary:[...pending.summary,...result.notes],
              ...(result.pullNumber !== undefined ? {pullNumber:result.pullNumber} : {}),...(result.code !== undefined ? {code:result.code} : {})};
          } else if (action.kind === "clone") {
            const result = await host.call("cloneHttps",{clone:repo.clone, username:latest.selected.username,destination:action.destination},{hostId:action.hostId});
            if (!result.ok) throw new Error(result.code);
            const copy = await saveCopy(action.hostId,result.root,result.identity,result);
            outcome = {...pending,status:"completed",copyId:copy.id};
          } else {
            const copy = await loadCopy(action.copyId);
            if (!copy) throw new Error("NOT_FOUND");
            const exchange = action.kind === "fetch" ? {kind:"fetch" as const} : {
              kind:"push" as const, expected:record.snapshot!.head, branch:record.snapshot!.branch,
            };
            const result = await host.call("exchangeHttps",{root:copy.root,identity:copy.identity,clone:repo.clone,username:latest.selected.username,action:exchange},{hostId:copy.hostId});
            if (!result.ok) throw new Error(result.code);
            outcome = {...pending,status:"completed",copyId:copy.id};
          }
        } catch (error) {
          const known = failureFor(error,"OUTCOME_UNKNOWN");
          const uncertain = ["OUTCOME_UNKNOWN","GIT_RESULT_UNKNOWN","GIT_PROCESS_UNAVAILABLE"].includes(known.code);
          outcome = {...pending,status:uncertain ? "unknown" : "failed",code:known.code};
        }
        await kv.set(remoteLog+id,outcome);
        bb.realtime.publish("git-workspace-changed",{copyId:outcome.copyId ?? null});
        return outcome;
      } finally { active.delete(id); }
    }),
    activity: async (actor?:string) => {
      const keys = await kv.list(remoteLog);
      return (await Promise.all(keys.map(key => kv.get<RemoteOutcome>(key))))
        .filter((entry): entry is RemoteOutcome => entry !== undefined && (!actor || entry.actor === actor)).sort((left,right) => right.at.localeCompare(left.at)).slice(0,30)
        .map(entry => entry.status === "pending" && !active.has(entry.id) ? {...entry,status:"unknown" as const} : entry);
    },
  };
}
