import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { objectName, type HistoryPage } from "../../core/history/model.ts";
import { detailFormat, fileChanges, parseCommits, parseDetail, parseRefs, refFormat, summaryFormat, workingChanges } from "../../core/history/parse.ts";
import { gitRunner, type GitRun } from "./git-process.ts";
import { filePath } from "./local-git.ts";

/** Reads that grow with the repository (refs, status, logs, file lists) may use more than the default cap. */
const large = 8 * 1024 * 1024;

/** All refs except tools' own bookkeeping refs. */
const allRefs = ["--exclude=refs/t3/checkpoints", "--exclude=refs/t3/checkpoints/*", "--all"];
const diffFlags = ["--no-ext-diff", "--no-textconv", "--no-color"];
/**
 * The change a commit brings, against its first parent (so a merge shows what it brought into its branch). A root
 * commit is compared with the empty tree. `diff-tree -m --first-parent` is not used: it still diffs every parent.
 */
async function commitDiff(git: GitRun, commit: string, options: string[]) {
  const parent = await git(["rev-parse", "--verify", "--quiet", commit + "^1"], {codes: [0, 1]});
  return parent.code === 0
    ? ["diff", ...diffFlags, ...options, parent.text.trim(), commit]
    : ["diff-tree", "-r", "--root", ...diffFlags, ...options, "--no-commit-id", commit];
}

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
    git(["for-each-ref", "--sort=refname", "--format=" + refFormat], {limit: large}),
    git(["rev-parse", "--verify", "--quiet", "HEAD"], {codes: [0, 1]}),
    git(["symbolic-ref", "--quiet", "HEAD"], {codes: [0, 1]}),
  ]);
  const headRef = branch.text.trim() || null;
  return {...parseRefs(raw.text, headRef, head.text.trim() || null), headRef, hasHead: head.code === 0};
}

/** Untracked files counted line by line, at most this many (each is a git call); beyond, they show no counts. */
const untrackedCounted = 200;

async function working(git: GitRun, hasHead: boolean) {
  const [status, counts] = await Promise.all([
    git(["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=all"], {limit: large}),
    hasHead ? git(["diff", "--numstat", "-z", ...diffFlags, "HEAD"], {limit: large}) : Promise.resolve({text: "", code: 0}),
  ]);
  // `diff HEAD` does not see untracked files: each is counted against /dev/null, as its patch is shown ("2\t0\t\0/dev/null\0path\0").
  const untracked = status.text.split("\0").filter(record => record.startsWith("?? ")).map(record => record.slice(3)).slice(0, untrackedCounted);
  const extra = await Promise.all(untracked.map(path => git(["diff", "--no-index", "--numstat", "-z", ...diffFlags, "--", "/dev/null", path], {codes: [0, 1]})
    .then(answer => { const [numbers = ""] = answer.text.split("\0"); return numbers + path + "\0"; }, () => "")));
  return {status: status.text, files: workingChanges(status.text, counts.text + extra.join(""))};
}

/** A page of the graph over all refs, newest first in topological order, with the working tree's changes. */
export async function historyPage(root: string, offset: number, limit: number, signal?: AbortSignal): Promise<HistoryPage> {
  const git = gitRunner(root, signal);
  const found = await refs(git);
  const [log, count, work] = await Promise.all([
    git(["log", ...allRefs, "--topo-order", "--format=" + summaryFormat, "--max-count=" + (limit + 1), "--skip=" + offset], {limit: large}),
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
  const status = await git(["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=all"], {limit: large});
  return createHash("sha256").update(found.revision + "\n" + status.text).digest("hex");
}

export async function commitDetails(root: string, hash: string, signal?: AbortSignal) {
  const commit = hashOf(hash);
  const git = gitRunner(root, signal);
  const [found, detail, names, counts] = await Promise.all([
    refs(git),
    git(["show", "-s", "--format=" + detailFormat, commit]),
    commitDiff(git, commit, ["--name-status", "-z"]).then(args => git(args, {limit: large})),
    commitDiff(git, commit, ["--numstat", "-z"]).then(args => git(args, {limit: large})),
  ]);
  const parsed = parseDetail(detail.text, found.byHash);
  if (!parsed) throw new Error("NOT_FOUND");
  return {...parsed, files: fileChanges(names.text, counts.text)};
}

/** A patch is shown up to 1.5 MB; a longer one is cut at a whole line and says so. */
const patchRead = {limit: 1.5 * 1024 * 1024, truncate: true};
const shown = ({text, truncated}: {text: string; truncated?: boolean}) => ({text, truncated: truncated === true});

export async function commitPatch(root: string, hash: string, path: string, signal?: AbortSignal) {
  const commit = hashOf(hash);
  const file = pathOf(path);
  const git = gitRunner(root, signal);
  return shown(await git([...await commitDiff(git, commit, ["-p"]), "--", file], patchRead));
}

/** The working tree's change of one file listed by `git status`; ignored and unlisted files are not read. */
export async function workingPatch(root: string, path: string, signal?: AbortSignal) {
  const file = await filePath(root, pathOf(path));
  const git = gitRunner(root, signal);
  const status = (await git(["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", file])).text.split("\0")
    .find(record => record.slice(3) === file);
  if (!status) throw new Error("INVALID_PATH");
  if (status.startsWith("??")) return shown(await git(["diff", ...diffFlags, "--no-index", "--", "/dev/null", file], {...patchRead, codes: [0, 1]}));
  const hasHead = (await git(["rev-parse", "--verify", "--quiet", "HEAD"], {codes: [0, 1]})).code === 0;
  return shown(await git(["diff", ...diffFlags, ...(hasHead ? ["HEAD"] : ["--cached"]), "--", file], patchRead));
}
