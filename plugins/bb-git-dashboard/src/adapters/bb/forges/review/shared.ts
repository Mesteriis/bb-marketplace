import type { PrDetail } from "../../../../core/pulls/detail.ts";
import type { Account } from "../../../../core/providers.ts";
import { ownLink } from "../inbox/shared.ts";

/** Splits `owner/name` (or `group/sub/name` where the forge allows it), refusing anything that could leave the path. */
export function repoParts(path: string, nested = false): string[] {
  const parts = path.split("/");
  if (parts.length < 2 || (!nested && parts.length !== 2) || parts.some(part => !part || part === "." || part === "..")) throw new Error("INVALID_INPUT");
  return parts;
}

/** Every link of a detail kept only over https on the account's own server; others become empty or null. */
export function ownLinks(account: Account, detail: PrDetail): PrDetail {
  const keep = (url: string) => ownLink(account, url) ?? "";
  return {
    ...detail, url: keep(detail.url),
    stackedOn: detail.stackedOn ? {...detail.stackedOn, url: keep(detail.stackedOn.url)} : null,
    timeline: detail.timeline.map(entry => ({...entry, url: keep(entry.url)})),
    threads: detail.threads.map(thread => ({...thread, comments: thread.comments.map(comment => ({...comment, url: keep(comment.url)}))})),
    checks: detail.checks.map(check => ({...check, url: check.url === null ? null : ownLink(account, check.url)})),
  };
}
