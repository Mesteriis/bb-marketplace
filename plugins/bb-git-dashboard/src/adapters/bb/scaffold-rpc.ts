import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { randomUUID } from "node:crypto";
import { scaffoldCi } from "../../core/scaffolds/ci.ts";
import { offerScaffolds, ownScaffolds, type OwnScaffold } from "../../core/scaffolds/catalog.ts";
import type { ScaffoldRequest } from "../../core/scaffolds/contract.ts";
import { buildScaffold, type ScaffoldOutput } from "../../core/scaffolds/model.ts";
import { CodedError, failureFor, type Copy } from "../../core/workspace.ts";
import { builtinScaffolds } from "../../templates/scaffolds/index.ts";
import { hostContract } from "./host-contract.ts";

type Caller = {experimental_caller: {kind: string}};
type Deps = {
  /** The projects folder as set. */
  rules(): Promise<{root: string}>;
  saveCopy(hostId: string, root: string, identity: string, metadata: Pick<Copy, "repository" | "repositoryName">): Promise<Copy>;
};
type Prepared = {hostId: string; projectsRoot: string; category: string; name: string; files: ScaffoldOutput[];
  author: ScaffoldRequest["author"]; message: string; expires: number};
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
    scaffoldsView: handle(async ({hostId}: {hostId: string}) => ({...await offer(hostId), suggested: {year: year()}})),
    scaffoldPrepare: handle(async (input: ScaffoldRequest) => {
      const {offered} = await offer(input.hostId);
      const entry = offered.find(item => item.key === input.key) ?? (() => { throw new Error("NOT_FOUND"); })();
      const {values, files} = buildScaffold(entry.scaffold, input.values, {year: year()});
      const name = String(values.name);
      const ci = scaffoldCi(files, entry.scaffold, input.ciForge, {name, branch: "main"});
      const all = ci ? [...files.filter(file => file.path !== ci.path), {path: ci.path, text: ci.text, executable: false}]
        .sort((a, b) => a.path < b.path ? -1 : 1) : files;
      const {root} = await deps.rules();
      const now = Date.now();
      // A new preview of the same place replaces the earlier one; expired ones go.
      for (const [key, record] of previews) if (record.expires < now || (record.hostId === input.hostId && record.projectsRoot === root
        && record.category === input.category && record.name === name)) previews.delete(key);
      if (previews.size >= 64) throw new Error("REPO_LIMIT");
      const id = randomUUID();
      const message = "Initial commit from the " + entry.scaffold.title + " scaffold";
      previews.set(id, {hostId: input.hostId, projectsRoot: root, category: input.category, name, files: all, author: input.author, message, expires: now + ttl});
      return {preview: {id, expires: new Date(now + ttl).toISOString(), files: all.map(file => ({path: file.path, bytes: Buffer.byteLength(file.text)})),
        lines: [
          entry.scaffold.title + " · " + all.length + " files",
          input.hostId + " · " + [root.replace(/\/+$/, ""), input.category, name].filter(Boolean).join("/"),
          ci ? "CI · " + ci.path + " (" + ci.template + ")" : "No CI file",
          "git init on main · first commit by " + input.author.name + " <" + input.author.email + ">",
          message,
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
        .catch(() => { throw new CodedError("OUTCOME_UNKNOWN", "the project was made at " + made.root + " but not attached: open it from the catalog"); });
      bb.realtime.publish("git-workspace-changed", {copyId: copy.id});
      return {copyId: copy.id, root: made.root};
    }),
  };
}
