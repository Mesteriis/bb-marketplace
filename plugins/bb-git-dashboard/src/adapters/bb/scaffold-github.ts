import { gunzipSync } from "node:zlib";
import { archiveLimits, readTarball } from "../../core/scaffolds/archive.ts";
import { validBranch, validRepository } from "../../core/scaffolds/github-source.ts";
import type { TreeFile } from "../../core/scaffolds/source.ts";
import { CodedError } from "../../core/workspace.ts";

/**
 * The templates repository on GitHub, read anonymously: the branch's head commit (with its ETag, so an unchanged
 * branch is a 304) and the tarball of one commit. Requests go to https://api.github.com and, for the archive,
 * https://codeload.github.com only; a redirect anywhere else is refused before anything is sent there. A token, when
 * one is given (after GitHub's anonymous limit, see withLimit), is sent to those two origins only and never appears
 * in an error.
 */
const api = "https://api.github.com";
const codeload = "https://codeload.github.com";
const allowed = new Set([api, codeload]);
const branchLimit = 256 * 1024;
const timeoutMs = 30_000;
type Send = typeof fetch;

/** One GET to an allowed origin, redirects not followed; the token only rides with it there. */
async function get(send: Send, url: string, token: string | null, headers: Record<string, string> = {}) {
  const target = new URL(url);
  if (!allowed.has(target.origin) || target.username || target.password) throw new CodedError("PROVIDER_REJECTED", "not a GitHub address");
  try {
    return await send(target.href, {redirect: "manual", signal: AbortSignal.timeout(timeoutMs), headers: {
      accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "makosh-git-scaffolds",
      ...headers, ...(token ? {authorization: "Bearer " + token} : {})}});
  } catch {
    throw new CodedError("PROVIDER_UNAVAILABLE", "GitHub could not be reached");
  }
}

/** GitHub's primary or secondary limit: 403 or 429 with no requests left, or asked to wait. */
function limited(response: Response) {
  return (response.status === 403 || response.status === 429)
    && (response.headers.get("x-ratelimit-remaining") === "0" || response.headers.has("retry-after"));
}
const rateLimited = () => new CodedError("PROVIDER_RATE_LIMITED", "GitHub's request limit for this machine is reached");

/** The body, read up to a limit: past it the reading stops and the answer is refused. */
async function body(response: Response, limit: number, refusal: () => Error) {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) { await response.body?.cancel(); throw refusal(); }
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const {done, value} = await reader.read().catch(() => { throw new CodedError("PROVIDER_UNAVAILABLE", "GitHub's answer broke off"); });
    if (done) break;
    size += value.length;
    if (size > limit) { await reader.cancel().catch(() => {}); throw refusal(); }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { all.set(chunk, offset); offset += chunk.length; }
  return all;
}

export type Branch = {repository: string; branch: string};
export type BranchHead = {changed: false} | {changed: true; sha: string; committedAt: string; etag: string | null};

/** The branch's head commit; with the ETag of the last answer, {changed: false} when GitHub says it is the same. */
export function fetchBranch(send: Send, {repository, branch}: Branch, etag: string | null, token: string | null = null): Promise<BranchHead> {
  if (!validRepository(repository) || !validBranch(branch)) throw new CodedError("INVALID_INPUT", "not a GitHub repository and branch");
  const [owner, name] = repository.split("/") as [string, string];
  return (async () => {
    const response = await get(send, api + "/repos/" + encodeURIComponent(owner) + "/" + encodeURIComponent(name) + "/branches/" + encodeURIComponent(branch),
      token, etag ? {"if-none-match": etag} : {});
    if (response.status === 304) return {changed: false};
    if (limited(response)) throw rateLimited();
    if (response.status === 301 || response.status === 302 || response.status === 307)
      throw new CodedError("NOT_FOUND", repository + " moved on GitHub: set the templates repository to its new name");
    if (response.status === 404) throw new CodedError("NOT_FOUND", repository + " has no branch " + branch + " on GitHub, or the repository is private");
    if (!response.ok) throw new CodedError("PROVIDER_UNAVAILABLE", "GitHub answered " + response.status);
    const text = new TextDecoder().decode(await body(response, branchLimit, () => new CodedError("PROVIDER_REJECTED", "GitHub's answer is too large")));
    let value: {commit?: {sha?: unknown; commit?: {committer?: {date?: unknown}}}};
    try { value = JSON.parse(text) as typeof value; } catch { throw new CodedError("PROVIDER_REJECTED", "GitHub's answer for branch " + branch + " is not JSON"); }
    const head = value.commit?.sha;
    const date = value.commit?.commit?.committer?.date;
    if (typeof head !== "string" || !/^[a-f0-9]{40}$/.test(head)) throw new CodedError("PROVIDER_REJECTED", "GitHub's answer for branch " + branch + " has no commit");
    return {changed: true, sha: head, committedAt: typeof date === "string" && Number.isFinite(Date.parse(date)) ? new Date(date).toISOString() : "",
      etag: response.headers.get("etag")};
  })();
}

/** The gzip archive of one commit, as GitHub serves it (api.github.com redirects to codeload.github.com). */
export async function fetchTarball(send: Send, {repository, sha}: {repository: string; sha: string}, token: string | null = null): Promise<{archive: Uint8Array}> {
  if (!validRepository(repository) || !/^[a-f0-9]{40}$/.test(sha)) throw new CodedError("INVALID_INPUT", "not a GitHub repository and commit");
  const [owner, name] = repository.split("/") as [string, string];
  const first = await get(send, api + "/repos/" + encodeURIComponent(owner) + "/" + encodeURIComponent(name) + "/tarball/" + sha, token);
  if (limited(first)) throw rateLimited();
  let response = first;
  if (first.status === 302 || first.status === 301 || first.status === 307) {
    await first.body?.cancel().catch(() => {});
    let target: URL;
    try { target = new URL(first.headers.get("location") ?? "", api); } catch { throw new CodedError("PROVIDER_REJECTED", "GitHub sent the archive nowhere"); }
    if (target.origin !== codeload) throw new CodedError("PROVIDER_REJECTED", "GitHub sent the archive to " + target.hostname + ", which is not codeload.github.com");
    response = await get(send, target.href, token);
    if (limited(response)) throw rateLimited();
  }
  if (response.status === 404) throw new CodedError("NOT_FOUND", repository + " has no commit " + sha.slice(0, 7) + " on GitHub");
  if (!response.ok) throw new CodedError("PROVIDER_UNAVAILABLE", "GitHub answered " + response.status + " for the archive");
  return {archive: await body(response, archiveLimits.compressed, () => new CodedError("SCAFFOLDS_INVALID", "the archive is over 5 MB"))};
}

/** The files of a gzip archive: unpacked in memory, stopping past the limit, then read as a tar archive. */
export function unpackArchive(archive: Uint8Array): TreeFile[] {
  if (archive.length > archiveLimits.compressed) throw new CodedError("SCAFFOLDS_INVALID", "the archive is over 5 MB");
  let tar: Buffer;
  // The headers of 2000 entries take at most 3 MB on top of the files' 20 MB; readTarball counts the files exactly.
  try { tar = gunzipSync(archive, {maxOutputLength: archiveLimits.unpacked + 4 * 1024 * 1024}); }
  catch (error) {
    throw new CodedError("SCAFFOLDS_INVALID", error instanceof RangeError || (error as {code?: string}).code === "ERR_BUFFER_TOO_LARGE"
      ? "over 20 MB unpacked" : "the archive is not gzip");
  }
  return readTarball(tar);
}

/**
 * Runs a read anonymously; when GitHub's limit stops it and a GitHub account's token is there, once more with the
 * token. Says which was used, never the token itself.
 */
export async function withLimit<T>(read: (token: string | null) => Promise<T>, token: () => Promise<string | null>): Promise<{value: T; used: "anonymous" | "token"}> {
  try { return {value: await read(null), used: "anonymous"}; }
  catch (error) {
    if (!(error instanceof Error) || error.message !== "PROVIDER_RATE_LIMITED") throw error;
    const secret = await token().catch(() => null);
    if (!secret) throw error;
    return {value: await read(secret), used: "token"};
  }
}
