// Parsing of Git's NUL-separated output, adapted from plugins/git-history/host.ts (MIT, © 2026 Yusuf Akbulut).
import type { CommitSummary, FileChange, Ref } from "./model.ts";

export const summaryFormat = ["%H", "%P", "%an", "%ae", "%aI", "%cI", "%s"].join("%x00") + "%x00";
export const detailFormat = ["%H", "%P", "%an", "%ae", "%aI", "%cI", "%s", "%b"].join("%x00") + "%x00";
export const refFormat = "%(objectname)%00%(*objectname)%00%(refname)%00";
const summaryFields = 7;
/** Refs written by tools for their own bookkeeping are not shown. */
const hidden = ["refs/t3/checkpoints"];

function kindOf(fullName: string): Ref["kind"] {
  if (fullName.startsWith("refs/heads/")) return "local";
  if (fullName.startsWith("refs/remotes/")) return "remote";
  if (fullName.startsWith("refs/tags/")) return "tag";
  if (fullName === "refs/stash") return "stash";
  return "other";
}
function shortName(fullName: string) {
  for (const prefix of ["refs/heads/", "refs/remotes/", "refs/tags/"]) if (fullName.startsWith(prefix)) return fullName.slice(prefix.length);
  return fullName === "refs/stash" ? "stash" : fullName.replace(/^refs\//, "");
}
const priority = (item: Ref) => item.isHead ? 0 : ({local: 1, tag: 2, remote: 3, stash: 4, other: 5} as const)[item.kind];

/** `for-each-ref --format=<refFormat>` output grouped by the commit each ref points at. */
export function parseRefs(raw: string, headRef: string | null, headHash: string | null) {
  const byHash: Record<string, Ref[]> = {};
  const fields = raw.split("\0");
  const records: string[] = [];
  for (let index = 0; index + 2 < fields.length; index += 3) {
    const object = fields[index].trim(), peeled = fields[index + 1].trim(), fullName = fields[index + 2].trim();
    if (!object || !fullName || hidden.some(space => fullName === space || fullName.startsWith(space + "/"))) continue;
    records.push(object + ":" + peeled + ":" + fullName);
    const hash = peeled || object;
    (byHash[hash] ??= []).push({fullName, name: shortName(fullName), kind: kindOf(fullName), isHead: fullName === headRef});
  }
  if (headHash && !(byHash[headHash] ?? []).some(item => item.isHead)) {
    (byHash[headHash] ??= []).push({fullName: "HEAD", name: "HEAD", kind: "other", isHead: true});
  }
  for (const list of Object.values(byHash)) list.sort((left, right) => priority(left) - priority(right) || left.name.localeCompare(right.name));
  return {byHash, revision: records.join("\n") + "\nHEAD:" + (headRef ?? "") + ":" + (headHash ?? "")};
}

/** `log --format=<summaryFormat> -z` records. */
export function parseCommits(raw: string, refs: Record<string, Ref[]>): CommitSummary[] {
  const fields = raw.split("\0").map((field, index) => index % summaryFields === 0 ? field.replace(/^\n/, "") : field);
  const commits: CommitSummary[] = [];
  for (let index = 0; index + summaryFields - 1 < fields.length; index += summaryFields) {
    const hash = fields[index].trim();
    if (!hash) continue;
    commits.push({
      hash, parents: fields[index + 1] ? fields[index + 1].split(" ").filter(Boolean) : [],
      authorName: fields[index + 2], authorEmail: fields[index + 3], authorDate: fields[index + 4],
      committerDate: fields[index + 5], subject: fields[index + 6], refs: refs[hash] ?? [],
    });
  }
  return commits;
}

/** `show -s --format=<detailFormat>` of one commit. */
export function parseDetail(raw: string, refs: Record<string, Ref[]>) {
  const fields = raw.split("\0");
  const [summary] = parseCommits(fields.slice(0, summaryFields).join("\0") + "\0", refs);
  return summary ? {...summary, body: (fields[summaryFields] ?? "").trim()} : null;
}

function statusOf(code: string): FileChange["status"] {
  return ({A: "added", C: "copied", D: "deleted", M: "modified", R: "renamed", T: "type-changed"} as const)[code[0] as "A"] ?? "unknown";
}

/** `diff-tree --name-status -z` joined with `--numstat -z`; renames are listed under their new path. */
export function fileChanges(nameStatus: string, numstat: string): FileChange[] {
  const statuses = new Map<string, FileChange["status"]>();
  const tokens = nameStatus.split("\0");
  for (let index = 0; index < tokens.length; index++) {
    const code = tokens[index];
    if (!code) continue;
    if (/^[RC]/.test(code)) { statuses.set(tokens[index + 2], statusOf(code)); index += 2; }
    else { statuses.set(tokens[index + 1], statusOf(code)); index += 1; }
  }
  const files: FileChange[] = [];
  const records = numstat.split("\0");
  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    if (!record) continue;
    const [added, deleted, ...rest] = record.split("\t");
    let path = rest.join("\t");
    if (!path) { path = records[index + 2] ?? ""; index += 2; }
    if (!path) continue;
    const count = (value: string) => /^\d+$/.test(value) ? Number(value) : null;
    files.push({path, status: statuses.get(path) ?? "unknown", additions: count(added), deletions: count(deleted)});
  }
  return files;
}

/** `status --porcelain=v1 -z` joined with `diff --numstat -z HEAD`. */
export function workingChanges(status: string, numstat: string): FileChange[] {
  const counts = new Map<string, [number | null, number | null]>();
  for (const record of numstat.split("\0")) {
    const [added, deleted, ...rest] = record.split("\t");
    const path = rest.join("\t");
    if (path) counts.set(path, [/^\d+$/.test(added) ? Number(added) : null, /^\d+$/.test(deleted) ? Number(deleted) : null]);
  }
  const files: FileChange[] = [];
  const records = status.split("\0");
  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    if (record.length < 4) continue;
    const code = record.slice(0, 2), path = record.slice(3);
    if (/[RC]/.test(code)) index += 1;
    const state: FileChange["status"] = code.includes("U") || code === "AA" || code === "DD" ? "conflicted"
      : code === "??" || code.includes("A") ? "added" : code.includes("D") ? "deleted" : code.includes("R") ? "renamed"
      : code.includes("C") ? "copied" : code.includes("T") ? "type-changed" : code.includes("M") ? "modified" : "unknown";
    const [additions, deletions] = counts.get(path) ?? [null, null];
    files.push({path, status: state, additions, deletions});
  }
  return files;
}
