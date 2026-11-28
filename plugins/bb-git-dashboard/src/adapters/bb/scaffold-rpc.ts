import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { randomUUID } from "node:crypto";
import { scaffoldCi } from "../../core/scaffolds/ci.ts";
import { offerScaffolds, ownScaffolds, type OwnScaffold } from "../../core/scaffolds/catalog.ts";
import type { ScaffoldRequest } from "../../core/scaffolds/contract.ts";
import { buildScaffold, type ScaffoldOutput } from "../../core/scaffolds/model.ts";
import { repositoryLine, validOwner, type RepositoryChoice } from "../../core/scaffolds/repository.ts";
import type { Account, Provider } from "../../core/providers.ts";
import type { RemoteOutcome } from "../../core/publication.ts";
import { CodedError, failureFor, type Copy } from "../../core/workspace.ts";
import { builtinScaffolds } from "../../templates/scaffolds/index.ts";
import { hostContract } from "./host-contract.ts";

type Caller = {experimental_caller: {kind: string}};
type Deps = {
  /** The projects folder as set. */
  rules(): Promise<{root: string}>;
  saveCopy(hostId: string, root: string, identity: string, metadata: Pick<Copy, "repository" | "repositoryName">): Promise<Copy>;
  accounts(): Promise<Account[]>;
  /** The provider API of an account, and its token for the one Keychain entry of a repository the plugin has just made. */
  api(accountId: string): Promise<{account: Account; api: Provider; token: string}>;
  /** Remembers a provider repository by path and links the copy to it, as a connected copy is. */
  link(copy: Copy, accountId: string, path: string): Promise<void>;
  /** Writes an entry of the remote activity log, as publications do, before and after an outside write. */
  record(entry: RemoteOutcome): Promise<void>;
};
type Prepared = {hostId: string; projectsRoot: string; category: string; name: string; files: ScaffoldOutput[];
  author: ScaffoldRequest["author"]; message: string; expires: number; description: string;
  repository: (RepositoryChoice & {accountId: string; stamp: string; keychain: boolean}) | null};
const ttl = 10 * 60_000;

/** New projects from scaffolds: what is offered, a preview of what would be written, and the project made after confirmation. */
export function scaffoldHandlers(bb: BbPluginApi, deps: Deps) {
  const settings = bb.settings.define({
    scaffolds: {type: "string", label: "Scaffolds: own scaffolds (JSON list)", default: "", experimental_multiline: true,
      description: "Scaffolds in the plugin's scaffold format, offered after the built-in ones. Only the skeleton and parameters: no secrets, hosts or addresses."},
    scaffoldsFolder: {type: "string", label: "Scaffolds: folder of own scaffolds", default: "",
      description: "An absolute folder on the chosen machine (or ~/…) with one scaffold per .json file."},
  });
  const host = bb.hosts.experimental_client({contract: hostContract});
  const previews = new Map<string, Prepared>();
  bb.onDispose(() => previews.clear());

  async function offer(hostId: string) {
    const {scaffolds, scaffoldsFolder} = await settings.get();
    const own: OwnScaffold[] = ownScaffolds("settings", scaffolds);
    if (scaffoldsFolder.trim()) {
      const folder = await host.call("ciTemplateFolder", {folder: scaffoldsFolder.trim()}, {hostId}).catch(() => failureFor(undefined, "HOST_UNAVAILABLE"));
      if (!folder.ok) own.push({source: "folder", name: scaffoldsFolder.trim(), raw: null, error: "The folder could not be read (" + folder.code + ")."});
      else {
        for (const file of folder.files) own.push(...ownScaffolds("folder", file.text, file.name));
        for (const name of folder.skipped) own.push({source: "folder", name, raw: null, error: "Not a regular file up to 64 KB, or past the first 50."});
      }
    }
    return offerScaffolds(builtinScaffolds, own);
  }
  const year = () => String(new Date().getFullYear());

  const handle = <I, O extends object>(action: (input: I) => Promise<O>) => async (input: I, context: Caller) => {
    if (context.experimental_caller.kind !== "client") return failureFor(undefined, "ACCESS_DENIED");
    try { return {ok: true as const, ...await action(input)}; }
    catch (error) { return failureFor(error, "GIT_REJECTED"); }
  };
  return {
    scaffoldsView: handle(async ({hostId}: {hostId: string}) => ({...await offer(hostId), suggested: {year: year()},
      accounts: (await deps.accounts()).map(({id, label, kind, username}) => ({id, label, kind, username}))})),
    scaffoldPrepare: handle(async (input: ScaffoldRequest) => {
      const {offered} = await offer(input.hostId);
      const entry = offered.find(item => item.key === input.key) ?? (() => { throw new Error("NOT_FOUND"); })();
      const {values, files} = buildScaffold(entry.scaffold, input.values, {year: year()});
      const name = String(values.name);
      const ci = scaffoldCi(files, entry.scaffold, input.ciForge, {name, branch: "main"});
      const all = ci ? [...files.filter(file => file.path !== ci.path), {path: ci.path, text: ci.text, executable: false}]
        .sort((a, b) => a.path < b.path ? -1 : 1) : files;
      const {root} = await deps.rules();
      // The repository, when one is asked for: its account must exist and the owner fit its forge.
      let repository: Prepared["repository"] = null;
      let repositoryText: string | null = null;
      if (input.repository) {
        const account = (await deps.accounts()).find(item => item.id === input.repository!.accountId) ?? (() => { throw new Error("ACCOUNT_UNCONFIGURED"); })();
        // The account's own login as owner is the account's user (the organisation endpoint does not know it).
        const owner = input.repository.owner !== null && account.kind !== "azure" && input.repository.owner.toLowerCase() === account.username.toLowerCase()
          ? null : input.repository.owner;
        if (!validOwner(account.kind, owner)) throw new CodedError("INVALID_INPUT", "the owner does not fit a " + account.kind + " repository");
        if (account.kind === "azure" && owner !== null) {
          const visibility = await (await deps.api(account.id)).api.repositoryVisibility?.(owner);
          if (visibility !== input.repository.visibility) throw new CodedError("VISIBILITY_MISMATCH", "the Azure project " + owner + " is " + (visibility ?? "unknown"));
        }
        const choice = {...input.repository, owner};
        // The token goes into the Keychain only on macOS: elsewhere (or when the machine does not say) nothing is promised.
        const keychain = await host.call("credentialHelper", {}, {hostId: input.hostId}).then(answer => answer.keychain, () => false);
        // What the preview promised is what is done: without a Keychain the repository is made and left empty.
        repository = {...choice, stamp: JSON.stringify(account), keychain};
        repositoryText = repositoryLine(account, choice, name) + (keychain
          ? " · the token of " + account.username + " is saved in the Keychain for the new repository's address only, then main is pushed over HTTPS with it"
          : " · this machine has no Keychain for the token: the repository is created empty; add the HTTPS credential of " + account.username
            + " by hand, then push main from Git");
      }
      const now = Date.now();
      // A new preview of the same place replaces the earlier one; expired ones go.
      for (const [key, record] of previews) if (record.expires < now || (record.hostId === input.hostId && record.projectsRoot === root
        && record.category === input.category && record.name === name)) previews.delete(key);
      if (previews.size >= 64) throw new Error("REPO_LIMIT");
      const id = randomUUID();
      const message = "Initial commit from the " + entry.scaffold.title + " scaffold";
      previews.set(id, {hostId: input.hostId, projectsRoot: root, category: input.category, name, files: all, author: input.author, message,
        expires: now + ttl, description: String(values.description), repository});
      return {preview: {id, expires: new Date(now + ttl).toISOString(), files: all.map(file => ({path: file.path, bytes: Buffer.byteLength(file.text)})),
        lines: [
          entry.scaffold.title + " · " + all.length + " files",
          input.hostId + " · " + [root.replace(/\/+$/, ""), input.category, name].filter(Boolean).join("/"),
          ci ? "CI · " + ci.path + " (" + ci.template + ")" : "No CI file",
          "git init on main · first commit by " + input.author.name + " <" + input.author.email + ">",
          message,
          ...(repositoryText ? [repositoryText] : ["No repository on a forge"]),
        ]}};
    }),
    scaffoldCreate: handle(async ({previewId}: {previewId: string}) => {
      const record = previews.get(previewId);
      previews.delete(previewId);
      if (!record || record.expires < Date.now()) throw new Error("PREVIEW_EXPIRED");
      // The projects folder changed since the preview: the place shown is not where the catalog now looks.
      if ((await deps.rules()).root !== record.projectsRoot) throw new Error("PREVIEW_EXPIRED");
      const place = [record.projectsRoot.replace(/\/+$/, ""), record.category, record.name].filter(Boolean).join("/");
      const unknown = () => new CodedError("OUTCOME_UNKNOWN", "the project may have been made at " + place + ": look there, and open it from the catalog to attach it");
      const made = await host.call("scaffoldCreate", {projectsRoot: record.projectsRoot, category: record.category, name: record.name,
        files: record.files, author: record.author, message: record.message}, {hostId: record.hostId, timeoutMs: 60_000})
        .catch(() => null);
      if (!made) throw unknown();
      if (!made.ok) throw new Error(made.code);
      const copy = await deps.saveCopy(record.hostId, made.root, made.identity,
        {...(made.repository ? {repository: made.repository} : {}), ...(made.repositoryName ? {repositoryName: made.repositoryName} : {})})
        .catch(() => { throw new CodedError("OUTCOME_UNKNOWN", "the project was made at " + made.root + " but not attached: open it from the catalog"
          + (record.repository ? "; no repository was created on the forge" : "")); });
      bb.realtime.publish("git-workspace-changed", {copyId: copy.id});
      if (!record.repository) return {copyId: copy.id, root: made.root, repository: null, notes: []};
      // The project is made: whatever happens with the repository now, it stays, and the answer says what is left.
      const choice = record.repository;
      const code = (error: unknown) => failureFor(error, "OUTCOME_UNKNOWN").code;
      const where = (choice.owner ?? "the account's user") + "/" + record.name;
      // The outside writes go into the activity log first, as publications do, and the log is completed after them.
      const entry: RemoteOutcome = {id: randomUUID(), kind: "repository", target: {accountId: choice.accountId, repoId: "new:" + record.name},
        at: new Date().toISOString(), status: "pending", actor: "human", copyId: copy.id,
        summary: ["New " + choice.visibility + " repository " + where, "First push of main from " + made.root]};
      const finish = (patch: Partial<RemoteOutcome>) => deps.record({...entry, ...patch}).catch(() => {});
      await deps.record(entry).catch(() => {});
      let created: Awaited<ReturnType<Provider["createRepository"]>>;
      let account: Account;
      let token: string;
      try {
        const found = await deps.api(choice.accountId);
        if (JSON.stringify(found.account) !== choice.stamp) throw new Error("PREVIEW_EXPIRED");
        account = found.account;
        token = found.token;
        created = await found.api.createRepository({owner: choice.owner, name: record.name, description: record.description, visibility: choice.visibility});
      } catch (error) {
        const failed = code(error);
        await finish({status: failed === "OUTCOME_UNKNOWN" ? "unknown" : "failed", code: failed});
        return {copyId: copy.id, root: made.root, repository: null, notes: [failed === "OUTCOME_UNKNOWN"
          ? "The project was made; the forge did not answer whether repository " + where + " was created. Look for it on the forge before creating it again."
          : "The project was made, but the repository was not created (" + failed + "). Create it on the forge, then push main from Git."]};
      }
      const notes: string[] = [];
      if (!choice.keychain) {
        // The push step sets origin, and linking checks it: with neither, the copy is linked by hand afterwards.
        notes.push("Repository " + created.path + " was created empty, as the preview said: this machine has no Keychain for the token. Set origin to "
          + created.clone + ", add the HTTPS credential of " + account.username + " for it by hand, push main from Git, then link the repository in the repository panel.");
        await finish({status: "completed", target: {accountId: choice.accountId, repoId: created.id},
          summary: ["New " + choice.visibility + " repository " + created.path, "No Keychain on this machine: the token of " + account.username + " is not saved",
            "main not pushed from " + made.root]});
        bb.realtime.publish("git-workspace-changed", {copyId: copy.id});
        return {copyId: copy.id, root: made.root, repository: {path: created.path, pushed: false}, notes};
      }
      const addByHand = "Add the HTTPS credential of " + account.username + " for " + created.clone + " to the Keychain, then push main from Git.";
      // Only now, with the repository made by this account, its token goes into the Keychain for this repository's exact
      // address, through the host's Git on stdin; the first push then takes it as any HTTPS push of the plugin does.
      const saved = await host.call("scaffoldCredential", {root: made.root, identity: made.identity, clone: created.clone, username: account.username, secret: token},
        {hostId: record.hostId, timeoutMs: 60_000}).catch(() => failureFor(undefined, "GIT_RESULT_UNKNOWN"));
      const pushed = !saved.ok ? saved : await host.call("scaffoldPublish", {root: made.root, identity: made.identity, clone: created.clone, username: account.username},
        {hostId: record.hostId, timeoutMs: 120_000}).catch(() => failureFor(undefined, "GIT_RESULT_UNKNOWN"));
      if (!saved.ok) notes.push("Repository " + created.path + " was created empty: the token of " + account.username + " was not saved in the Keychain (" +
        (saved.code === "GIT_RESULT_UNKNOWN" ? "the machine did not answer, so it may be there" : saved.code) + "), so main was not pushed. " + addByHand);
      else if (!pushed.ok) notes.push(pushed.code === "GIT_RESULT_UNKNOWN"
        ? "Repository " + created.path + " was created; the push of main did not answer and may have gone through. Fetch in Git to see, then push main if it is missing."
        : "Repository " + created.path + " was created empty: main was not pushed (" + pushed.code + "). " + addByHand);
      await finish({status: pushed.ok ? "completed" : saved.ok && pushed.code === "GIT_RESULT_UNKNOWN" ? "unknown" : "failed",
        target: {accountId: choice.accountId, repoId: created.id}, ...(pushed.ok ? {} : {code: pushed.code}),
        summary: ["New " + choice.visibility + " repository " + created.path,
          saved.ok ? "Token of " + account.username + " saved in the Keychain for " + created.clone
            : "Token of " + account.username + " not saved in the Keychain (" + saved.code + ")",
          pushed.ok ? "main pushed from " + made.root : "main not pushed from " + made.root]});
      // Linking checks the copy's origin, which the push step set.
      await deps.link(copy, choice.accountId, created.path).catch((error: unknown) => {
        notes.push("Repository " + created.path + " was created but not linked to the copy (" + code(error) + "); link it in the repository panel.");
      });
      bb.realtime.publish("git-workspace-changed", {copyId: copy.id});
      return {copyId: copy.id, root: made.root, repository: {path: created.path, pushed: pushed.ok}, notes};
    }),
  };
}
