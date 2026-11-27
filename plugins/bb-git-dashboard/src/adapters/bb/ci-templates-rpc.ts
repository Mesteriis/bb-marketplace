import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { z } from "zod";
import { offerTemplates, ownTemplates, templateDefaults, type OwnEntry } from "../../core/ci-templates/catalog.ts";
import type { ciTemplateRequest, CiTemplatesView } from "../../core/ci-templates/contract.ts";
import { renderTemplate, resolveValues, secretIssues } from "../../core/ci-templates/render.ts";
import { detectStacks } from "../../core/ci-templates/stack.ts";
import type { Account, Repo } from "../../core/providers.ts";
import type { Preview, RemoteAction } from "../../core/publication.ts";
import { CodedError, failureFor, type Copy, type Failure } from "../../core/workspace.ts";
import { hostContract } from "./host-contract.ts";

type Caller = {experimental_caller: {kind: string}};
type Deps = {
  copy(copyId: string): Promise<Copy | undefined>;
  /** The account and repository a copy is linked to, with its origin checked. */
  linked(copy: Copy): Promise<{account: Account; repo: Repo}>;
  prepare(request: {accountId: string; repoId: string; action: RemoteAction}): Promise<{ok: true; value: Preview} | Failure>;
};
const ciPaths = /^(?:\.github\/workflows\/|\.gitea\/workflows\/)[^/]+$|^\.gitlab-ci\.yml$|^azure-pipelines\.yml$/;

/** CI templates of a copy's forge: the stack at HEAD, the built-in and own templates, and the render into a new branch. */
export function ciTemplateHandlers(bb: BbPluginApi, deps: Deps) {
  const settings = bb.settings.define({
    ciTemplates: {type: "string", label: "CI templates: own templates (JSON list)", default: "", experimental_multiline: true,
      description: "Templates in the plugin's template format, offered next to the built-in ones. Only the skeleton and parameters: no secrets, hosts or addresses."},
    ciTemplatesFolder: {type: "string", label: "CI templates: folder of own templates", default: "",
      description: "An absolute folder on the working copy's machine (or ~/…) with one template per .json file."},
  });
  const host = bb.hosts.experimental_client({contract: hostContract});

  async function own(copy: Copy): Promise<OwnEntry[]> {
    const {ciTemplates, ciTemplatesFolder} = await settings.get();
    const entries = ownTemplates("settings", ciTemplates);
    if (ciTemplatesFolder.trim()) {
      const folder = await host.call("ciTemplateFolder", {folder: ciTemplatesFolder.trim()}, {hostId: copy.hostId}).catch(() => failureFor(undefined, "HOST_UNAVAILABLE"));
      if (!folder.ok) entries.push({source: "folder", name: ciTemplatesFolder.trim(), raw: null, error: "The folder could not be read (" + folder.code + ")."});
      else {
        for (const file of folder.files) entries.push(...ownTemplates("folder", file.text, file.name));
        for (const name of folder.skipped) entries.push({source: "folder", name, raw: null, error: "Not a regular file up to 64 KB, or past the first 50."});
      }
    }
    return entries;
  }

  async function view(copyId: string): Promise<CiTemplatesView & {account: Account; repoRef: Repo}> {
    const copy = await deps.copy(copyId);
    if (!copy) throw new Error("NOT_FOUND");
    const {account, repo} = await deps.linked(copy);
    const read = await host.call("ciStack", {root: copy.root, identity: copy.identity}, {hostId: copy.hostId}).catch(() => failureFor(undefined, "HOST_UNAVAILABLE"));
    if (!read.ok) throw new Error(read.code);
    const stacks = detectStacks(read);
    const {offered, rejected} = offerTemplates(account.kind, stacks, await own(copy));
    return {forge: account.kind, repo: {path: repo.path, name: repo.name, branch: repo.branch}, head: read.head, stacks, offered, rejected,
      existing: read.paths.filter(path => ciPaths.test(path)), account, repoRef: repo};
  }

  const handle = <I, O extends object>(action: (input: I) => Promise<O>) => async (input: I, context: Caller) => {
    if (context.experimental_caller.kind !== "client") return failureFor(undefined, "ACCESS_DENIED");
    try { return {ok: true as const, ...await action(input)}; }
    catch (error) { return failureFor(error, "PROVIDER_UNAVAILABLE"); }
  };
  return {
    ciTemplatesView: handle(async ({copyId}: {copyId: string}) => {
      const {account: _account, repoRef: _repo, ...value} = await view(copyId);
      return value;
    }),
    ciTemplatePrepare: handle(async (input: z.infer<typeof ciTemplateRequest>) => {
      const found = await view(input.copyId);
      const entry = found.offered.find(item => item.key === input.key);
      if (!entry) throw new Error("NOT_FOUND");
      const values = resolveValues(entry.template, input.values, templateDefaults(entry.template, found.stacks, found.repo));
      const file = renderTemplate(entry.template, values);
      // Values are single words, but one can still be an address: the rendered file is checked as a whole.
      const issues = secretIssues(file.path + "\n" + file.text);
      if (issues.length) throw new CodedError("TEMPLATE_INVALID", "the rendered file has " + issues.join(", "));
      const prepared = await deps.prepare({accountId: found.account.id, repoId: found.repoRef.id, action: {kind: "ciFile", copyId: input.copyId,
        template: input.key, path: file.path, content: file.text, branch: input.branch, title: input.title, body: input.body}});
      if (!prepared.ok) throw new Error(prepared.code);
      return {preview: prepared.value, file};
    }),
  };
}
