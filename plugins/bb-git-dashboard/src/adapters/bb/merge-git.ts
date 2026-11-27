import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GitAction, GitResult } from "../../core/git.ts";
import { hasMarkers, mergeMessage } from "../../core/merge/conflicts.ts";
import type { GitRun } from "./git-process.ts";
import { readReviewFile, writeReviewFile } from "./review-files.ts";

type Sequence = NonNullable<GitResult["sequence"]>;
type Conflict = Sequence["conflicts"][number];
export type MergeAction = Extract<GitAction, {kind: "sequence" | "mergePreview" | "conflict" | "merge" | "rebase" | "abort" | "continue" | "skip" | "resolve" | "take"}>;
/** What the merge work needs of the worktree: its Git, its root, a status read, and a checked literal path. */
type Context = {git: GitRun; root: string; status(): Promise<GitResult>; filePath(path: string): Promise<string>};

const fail = (code: string): never => { throw new Error(code); };
const states: Record<string, Conflict["state"]> = {UU: "both modified", AA: "both added", DD: "both deleted", AU: "added by us", UA: "added by them",
  DU: "deleted by us", UD: "deleted by them"};
// Markers are written with the base between the sides, so an editor outside Makosh Git sees it too.
const zdiff3 = ["-c", "merge.conflictStyle=zdiff3"];

async function gitPath(git: GitRun, name: string) {
  return (await git(["rev-parse", "--path-format=absolute", "--git-path", name])).text.replace(/\n$/, "");
}
const readText = (path: string) => readFile(path, "utf8").then(text => text.trim(), () => null);

/** The merge, rebase, cherry-pick or revert in progress, with the files still in conflict; null when none is. */
export async function sequenceOf(git: GitRun): Promise<Sequence | null> {
  const [mergeHead, rebaseMerge, rebaseApply, pick, revert] = await Promise.all(
    ["MERGE_HEAD", "rebase-merge", "rebase-apply", "CHERRY_PICK_HEAD", "REVERT_HEAD"].map(name => gitPath(git, name)));
  const exists = async (path: string) => (await readFile(path).then(() => true, (error: NodeJS.ErrnoException) => error.code === "EISDIR"));
  let kind: Sequence["kind"] | null = null;
  let head: string | null = null, onto: string | null = null, step: Sequence["step"] = null;
  for (const [folder, at, of] of [[rebaseMerge, "msgnum", "end"], [rebaseApply, "next", "last"]] as const) {
    if (await exists(folder)) {
      kind = "rebase";
      [head, onto] = await Promise.all([readText(join(folder, "orig-head")), readText(join(folder, "onto"))]);
      const [done, total] = (await Promise.all([readText(join(folder, at)), readText(join(folder, of))])).map(Number);
      step = Number.isSafeInteger(done) && Number.isSafeInteger(total) && total > 0 ? {done: done!, total: total!} : null;
      break;
    }
  }
  if (!kind && await exists(mergeHead!)) kind = "merge";
  if (!kind && await exists(pick!)) kind = "cherry-pick";
  if (!kind && await exists(revert!)) kind = "revert";
  if (!kind) return null;
  if (kind !== "rebase") head = (await git(["rev-parse", "--verify", "--quiet", "HEAD"], {codes: [0, 1]})).text.trim() || null;
  return {kind, head, onto, step, conflicts: await conflictsOf(git)};
}

async function conflictsOf(git: GitRun): Promise<Conflict[]> {
  const {text} = await git(["status", "--porcelain=v2", "-z", "--untracked-files=no", "--ignore-submodules=all"], {limit: 8 * 1024 * 1024});
  return text.split("\0").filter(record => record.startsWith("u ")).map(record => {
    const offset = record.split(" ").slice(0, 10).join(" ").length + 1;
    return {path: record.slice(offset), state: states[record.slice(2, 4)] ?? "both modified"};
  });
}

async function verifiedRef(git: GitRun, ref: string, target: string) {
  const found = (await git(["rev-parse", "--verify", "--quiet", "--end-of-options", ref + "^{commit}"], {codes: [0, 1]})).text.trim();
  if (found !== target) fail("STALE_HEAD");
}

async function preview(git: GitRun, ref: string, target: string): Promise<NonNullable<GitResult["preview"]>> {
  await verifiedRef(git, ref, target);
  const ancestor = async (a: string, b: string) => (await git(["merge-base", "--is-ancestor", a, b], {codes: [0, 1]})).code === 0;
  const count = async (range: string) => Number((await git(["rev-list", "--count", range])).text.trim());
  const [upToDate, fastForward, incoming, outgoing] = await Promise.all([ancestor(target, "HEAD"), ancestor("HEAD", target), count("HEAD.." + target), count(target + "..HEAD")]);
  // merge-tree merges in memory: the tree, the index and HEAD stay as they are.
  const merged = upToDate || fastForward ? {code: 0, text: ""} :
    await git(["merge-tree", "--write-tree", "--name-only", "--no-messages", "-z", "HEAD", target], {codes: [0, 1], limit: 8 * 1024 * 1024});
  const conflicts = merged.code === 1 ? [...new Set(merged.text.split("\0").slice(1).filter(Boolean))] : [];
  return {incoming, outgoing, conflicts, fastForward: fastForward && !upToDate, upToDate};
}

/** The worktree may start a merge or rebase: nothing in progress, nothing uncommitted, still at the head that was shown. */
async function ready(context: Context, expected: string) {
  if (await sequenceOf(context.git)) fail("GIT_SEQUENCE_ACTIVE");
  const state = await context.status();
  if (state.head !== expected) fail("STALE_HEAD");
  if (state.files?.length) fail("DIRTY_WORKTREE");
  return state;
}

async function blob(git: GitRun, object: string | undefined) {
  if (!object) return {text: null, binary: false};
  try {
    const {text} = await git(["cat-file", "blob", object], {limit: 4 * 1024 * 1024});
    return text.includes("\0") ? {text: null, binary: true} : {text, binary: false};
  } catch { return {text: null, binary: true}; }
}

/** A conflicted file: its three stages, Git's own merge of them with zdiff3 markers, and the file as it stands. */
async function conflict(context: Context, path: string): Promise<NonNullable<GitResult["conflict"]>> {
  const file = await context.filePath(path);
  const {text} = await context.git(["ls-files", "-u", "-z", "--", file]);
  const stages = new Map(text.split("\0").filter(Boolean).map(entry => {
    const [meta] = entry.split("\t");
    const [, object, stage] = meta!.split(" ");
    return [stage!, object!] as const;
  }));
  if (!stages.size) fail("NOT_FOUND");
  const [base, ours, theirs] = await Promise.all(["1", "2", "3"].map(stage => blob(context.git, stages.get(stage))));
  const binary = base!.binary || ours!.binary || theirs!.binary;
  let merged: string | null = null;
  if (!binary && ours!.text !== null && theirs!.text !== null) {
    const folder = await mkdtemp(join(tmpdir(), "makosh-git-merge-"));
    try {
      const files = ["ours", "base", "theirs"].map(name => join(folder, name));
      await Promise.all([writeFile(files[0]!, ours!.text), writeFile(files[1]!, base!.text ?? ""), writeFile(files[2]!, theirs!.text)]);
      // merge-file answers with the number of conflicts (at most 127); the merged text goes to stdout.
      merged = (await context.git(["merge-file", "-p", "--zdiff3", "-L", "ours", "-L", "base", "-L", "theirs", ...files],
        {codes: Array.from({length: 128}, (_, index) => index), limit: 8 * 1024 * 1024})).text;
    } finally { await rm(folder, {recursive: true, force: true}); }
  }
  const current = await readReviewFile(context.root, file).catch((error: Error) => error.message === "NOT_FOUND" ? null : "unreadable" as const);
  return {path: file, ours: ours!.text, base: base!.text, theirs: theirs!.text, merged, binary: binary || current === "unreadable",
    current: current && current !== "unreadable" ? current.text : null, sha256: current && current !== "unreadable" ? current.sha256 : null};
}

async function unmerged(context: Context, path: string) {
  const file = await context.filePath(path);
  if (!(await context.git(["ls-files", "-u", "-z", "--", file])).text) fail("NOT_FOUND");
  return file;
}

/** Reads and writes of merge, rebase and their conflicts; every write answers with the status and what is in progress. */
export async function mergeGit(context: Context, action: MergeAction): Promise<GitResult> {
  const {git} = context;
  const answer = async () => ({...await context.status(), sequence: await sequenceOf(git)});
  switch (action.kind) {
    case "sequence": return answer();
    case "mergePreview": return {root: context.root, preview: await preview(git, action.ref, action.target)};
    case "conflict": return {root: context.root, conflict: await conflict(context, action.path)};
    case "merge": {
      const state = await ready(context, action.expected);
      await verifiedRef(git, action.ref, action.target);
      const identity = action.author ?? state.author ?? fail("AUTHOR_REQUIRED");
      const merged = await git([...zdiff3, "merge", "--no-autostash", "--no-verify-signatures", "--no-edit", action.fastForward ? "--ff" : "--no-ff",
        "-m", mergeMessage(action.ref, state.branch ?? null), action.target], {codes: [0, 1], author: identity});
      const result = await answer();
      // A refusal (an untracked file in the way) leaves no merge behind: report it rather than a silent no-op.
      if (merged.code === 1 && !result.sequence) fail("GIT_REJECTED");
      return result;
    }
    case "rebase": {
      const state = await ready(context, action.expected);
      await verifiedRef(git, action.ref, action.target);
      const identity = action.author ?? state.author ?? fail("AUTHOR_REQUIRED");
      const rebased = await git([...zdiff3, "rebase", "--no-autostash", "--no-autosquash", "--no-update-refs", action.target], {codes: [0, 1], committer: identity});
      const result = await answer();
      if (rebased.code === 1 && !result.sequence) fail("GIT_REJECTED");
      return result;
    }
    case "abort": {
      const current = await sequenceOf(git) ?? fail("NO_SEQUENCE");
      await git([current.kind, "--abort"]);
      return answer();
    }
    case "continue": {
      const current = await sequenceOf(git) ?? fail("NO_SEQUENCE");
      if (current.conflicts.length) fail("UNMERGED_PATH");
      const state = await context.status();
      const identity = action.author ?? state.author ?? fail("AUTHOR_REQUIRED");
      // A merge or revert commit is the user's own; a rebase or cherry-pick keeps each commit's author.
      const own = current.kind === "merge" || current.kind === "revert";
      await git([...zdiff3, current.kind, "--continue"], {codes: [0, 1], ...(own ? {author: identity} : {committer: identity})});
      return answer();
    }
    case "skip": {
      const current = await sequenceOf(git) ?? fail("NO_SEQUENCE");
      if (current.kind === "merge" || current.kind === "revert") fail("INVALID_INPUT");
      const state = await context.status();
      await git([...zdiff3, current.kind, "--skip"], {codes: [0, 1], ...(state.author ? {committer: state.author} : {})});
      return answer();
    }
    case "resolve": {
      const file = await unmerged(context, action.path);
      if (hasMarkers(action.text)) fail("CONFLICT_MARKERS");
      await writeReviewFile(context.root, file, action.expected, action.text);
      await git(["add", "--", file]);
      return answer();
    }
    case "take": {
      const file = await unmerged(context, action.path);
      const {text} = await git(["ls-files", "-u", "-z", "--", file]);
      const has = (stage: string) => text.split("\0").some(entry => entry.split("\t")[0]?.split(" ")[2] === stage);
      if (action.side !== "delete" && has(action.side === "ours" ? "2" : "3")) {
        await git(["checkout", "--" + action.side, "--", file]);
        await git(["add", "--", file]);
      } else await git(["rm", "-q", "--", file]);
      return answer();
    }
  }
}
