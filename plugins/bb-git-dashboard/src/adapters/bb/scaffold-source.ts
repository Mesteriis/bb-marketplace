import { templatesSource, type SourceState } from "../../core/scaffolds/github-source.ts";
import type { TreeFile } from "../../core/scaffolds/source.ts";
import { CodedError } from "../../core/workspace.ts";
import type { ScaffoldCache } from "./scaffold-cache.ts";
import { fetchBranch, fetchTarball, unpackArchive, withLimit } from "./scaffold-github.ts";

/** Why a check runs: the New project form opened, the Refresh button, or the 15-minute background round. */
export type CheckReason = "open" | "button" | "background";
type Deps = {
  send: typeof fetch;
  cache: ScaffoldCache;
  /** The templates repository and branch as set (empty for the defaults). */
  settings(): Promise<{repository: string; branch: string}>;
  /** The token of a connected github.com account, asked for only after GitHub's anonymous limit. */
  token(): Promise<string | null>;
  now?(): number;
};
/** The form's opening checks at most this often; the button always checks. */
const openEvery = 60_000;

/**
 * The templates from the templates repository on GitHub: the revision held for the repository and branch set, and
 * the checks that renew it. A check asks GitHub for the branch's head with the ETag of the last answer — an unchanged
 * branch is a 304 — and only for a new head reads that commit's archive, which replaces the revision held once it
 * unpacks within the limits. A failure keeps the revision held and tells why. One check runs at a time.
 */
export function githubTemplates(deps: Deps) {
  const now = deps.now ?? Date.now;
  const errors = new Map<string, {code: string; detail: string}>();
  const lastOpen = new Map<string, number>();
  const unpacked = new Map<string, TreeFile[]>();
  let running: Promise<void> | null = null;
  const key = (repository: string, branch: string) => repository + "\u0000" + branch;

  async function chosen() {
    const raw = await deps.settings();
    return {raw: {repository: raw.repository.trim(), branch: raw.branch.trim()}, source: templatesSource(raw.repository, raw.branch)};
  }
  /** The files of a revision held, unpacked once per sha. */
  function filesOf(sha: string, archive: Uint8Array) {
    const known = unpacked.get(sha);
    if (known) return known;
    const files = unpackArchive(archive);
    unpacked.clear();
    unpacked.set(sha, files);
    return files;
  }

  async function current(): Promise<{state: SourceState; files: TreeFile[] | null}> {
    const {raw, source} = await chosen();
    if (!source) return {state: {repository: raw.repository, branch: raw.branch, revision: null, checkedAt: null,
      error: {code: "INVALID_INPUT", detail: "the templates repository is not owner/name on GitHub, or the branch is not a branch name"}}, files: null};
    const held = deps.cache.get(source.repository, source.branch);
    const error = errors.get(key(source.repository, source.branch)) ?? null;
    const state: SourceState = {...source, revision: held ? {sha: held.sha, committedAt: held.committedAt} : null, checkedAt: held?.checkedAt ?? null, error};
    if (!held) return {state, files: null};
    try { return {state, files: filesOf(held.sha, held.archive)}; }
    catch (failure) { return {state: {...state, revision: null, error: describe(failure)}, files: null}; }
  }

  async function renew(repository: string, branch: string) {
    const held = deps.cache.get(repository, branch);
    const at = () => new Date(now()).toISOString();
    try {
      const head = await withLimit(auth => fetchBranch(deps.send, {repository, branch}, held?.etag ?? null, auth), deps.token);
      if (!head.value.changed) { deps.cache.touch(repository, branch, at()); errors.delete(key(repository, branch)); return; }
      const {sha, committedAt, etag} = head.value;
      if (held?.sha === sha) { deps.cache.touch(repository, branch, at(), etag); errors.delete(key(repository, branch)); return; }
      const {value} = await withLimit(auth => fetchTarball(deps.send, {repository, sha}, auth), deps.token);
      // The revision is taken only when its archive unpacks within the limits.
      const files = unpackArchive(value.archive);
      deps.cache.put({repository, branch, sha, committedAt, etag, checkedAt: at(), archive: value.archive});
      unpacked.clear();
      unpacked.set(sha, files);
      errors.delete(key(repository, branch));
    } catch (failure) {
      errors.set(key(repository, branch), describe(failure));
    }
  }

  return {
    current,
    /** Checks for a new revision (the form's opening at most once a minute), then says what is held. */
    async check(reason: CheckReason) {
      const {source} = await chosen();
      if (source) {
        const pair = key(source.repository, source.branch);
        const skip = reason === "open" && now() - (lastOpen.get(pair) ?? -Infinity) < openEvery;
        if (!skip) {
          if (reason === "open") lastOpen.set(pair, now());
          running ??= renew(source.repository, source.branch).finally(() => { running = null; });
          await running;
        }
      }
      return current();
    },
  };
}

/** A failure as the form shows it: the plugin's code and its detail, never a token or a stack. */
function describe(failure: unknown): {code: string; detail: string} {
  if (failure instanceof CodedError) return {code: failure.message, detail: failure.detail};
  const code = failure instanceof Error && /^[A-Z_]+$/.test(failure.message) ? failure.message : "PROVIDER_UNAVAILABLE";
  return {code, detail: code === "PROVIDER_RATE_LIMITED" ? "GitHub's request limit for this machine is reached" : "GitHub could not be read"};
}
