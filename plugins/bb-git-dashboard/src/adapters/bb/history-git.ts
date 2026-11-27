import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { objectName, type HistoryPage } from "../../core/history/model.ts";
import { detailFormat, fileChanges, parseCommits, parseDetail, parseRefs, refFormat, summaryFormat, workingChanges } from "../../core/history/parse.ts";
import { gitRunner, type GitRun } from "./git-process.ts";

/** All refs except tools' own bookkeeping refs. */
const allRefs = ["--exclude=refs/t3/checkpoints", "--exclude=refs/t3/checkpoints/*", "--all"];
const diffFlags = ["--no-ext-diff", "--no-textconv", "--no-color"];
/** Merges are shown against their first parent, the way a branch's own history reads. */
const commitDiff = ["diff-tree", "-r", "--root", "-m", "--first-parent", ...diffFlags];

function hashOf(value: string) {
  if (!objectName.safeParse(value).success) throw new Error("INVALID_INPUT");
  return value;
}
function pathOf(value: string) {
  if (!value || isAbsolute(value) || value.split("/").some(part => !part || part === "." || part === ".." || part.toLowerCase() === ".git")) {
    throw new Error("INVALID_PATH");
  }
  return value;
}

async function refs(git: GitRun) {
  const [raw, head, branch] = await Promise.all([
    git(["for-each-ref", "--sort=refname", "--format=" + refFormat]),
    git(["rev-parse", "--verify", "--quiet", "HEAD"], {codes: [0, 1]}),
    git(["symbolic-ref", "--quiet", "HEAD"], {codes: [0, 1]}),
  ]);
  const headRef = branch.text.trim() || null;
  return {...parseRefs(raw.text, headRef, head.text.trim() || null), headRef, hasHead: head.code === 0};
}

async function working(git: GitRun, hasHead: boolean) {
  const [status, counts] = await Promise.all([
    git(["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=all"]),
    hasHead ? git(["diff", "--numstat", "-z", ...diffFlags, "HEAD"]) : Promise.resolve({text: "", code: 0}),
  ]);
  return {status: status.text, files: workingChanges(status.text, counts.text)};
}

/** A page of the graph over all refs, newest first in topological order, with the working tree's changes. */
export async function historyPage(root: string, offset: number, limit: number, signal?: AbortSignal): Promise<HistoryPage> {
  const git = gitRunner(root, signal);
  const found = await refs(git);
  const [log, count, work] = await Promise.all([
    git(["log", ...allRefs, "--topo-order", "--format=" + summaryFormat, "--max-count=" + (limit + 1), "--skip=" + offset]),
    git(["rev-list", ...allRefs, "--count"]),
    working(git, found.hasHead),
  ]);
  const commits = parseCommits(log.text, found.byHash);
  const shortBranch = found.headRef?.replace(/^refs\/heads\//, "") ?? null;
  return {
    currentBranch: shortBranch, uncommitted: work.files, commits: commits.slice(0, limit), offset,
    total: Number(count.text.trim()) || 0, more: commits.length > limit,
    revision: createHash("sha256").update(found.revision + "\n" + work.status).digest("hex"),
  };
}

/** A fingerprint of refs, HEAD and the working tree; it changes exactly when the history view would. */
export async function historyRevision(root: string, signal?: AbortSignal) {
  const git = gitRunner(root, signal);
  const found = await refs(git);
  const status = await git(["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=all"]);
  return createHash("sha256").update(found.revision + "\n" + status.text).digest("hex");
}

export async function commitDetails(root: string, hash: string, signal?: AbortSignal) {
  const commit = hashOf(hash);
  const git = gitRunner(root, signal);
  const [found, detail, names, counts] = await Promise.all([
    refs(git),
    git(["show", "-s", "--format=" + detailFormat, commit]),
    git([...commitDiff, "--name-status", "-z", "--no-commit-id", commit]),
    git([...commitDiff, "--numstat", "-z", "--no-commit-id", commit]),
  ]);
  const parsed = parseDetail(detail.text, found.byHash);
  if (!parsed) throw new Error("NOT_FOUND");
  return {...parsed, files: fileChanges(names.text, counts.text)};
}

export async function commitPatch(root: string, hash: string, path: string, signal?: AbortSignal) {
  const commit = hashOf(hash);
  const file = pathOf(path);
  return {text: (await gitRunner(root, signal)([...commitDiff, "-p", "--no-commit-id", commit, "--", file])).text};
}

export async function workingPatch(root: string, path: string, signal?: AbortSignal) {
  const file = pathOf(path);
  const git = gitRunner(root, signal);
  const tracked = (await git(["ls-files", "--error-unmatch", "--", file], {codes: [0, 1]})).code === 0;
  const hasHead = (await git(["rev-parse", "--verify", "--quiet", "HEAD"], {codes: [0, 1]})).code === 0;
  if (tracked) return {text: (await git(["diff", ...diffFlags, ...(hasHead ? ["HEAD"] : ["--cached"]), "--", file])).text};
  return {text: (await git(["diff", ...diffFlags, "--no-index", "--", "/dev/null", file], {codes: [0, 1]})).text};
}
