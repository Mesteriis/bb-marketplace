import { CommanderError } from "./errors.ts";
import { compileName, type SearchName } from "./glob.ts";
import type { EndpointId, Entry, ResourceRef } from "./model.ts";
import { join, type ResourcePath } from "./path.ts";
import { LIST_PAGE_MAX, type FileProvider } from "./provider.ts";
import type { ScanContext } from "./scan-job.ts";

export interface SearchQuery {
  root: ResourceRef;
  name?: SearchName;
  minSize?: bigint;
  maxSize?: bigint;
  modifiedAfter?: string;
  modifiedBefore?: string;
  content?: { text: string; caseSensitive: boolean };
  limits: { maxDepth: number; maxEntries: number; maxBytesRead: bigint };
}

export interface SearchHit {
  ref: ResourceRef;
  entry: Entry;
  line?: { number: number; text: string };
}

export class SearchConsentError extends Error {
  readonly code = "content_search_needs_consent";
  constructor() {
    super("Remote content search requires a confirmed estimate");
  }
}

type Providers = (endpoint: EndpointId) => FileProvider;
export interface SearchContext extends ScanContext {
  remoteConsent?: boolean;
  matchContent?: (provider: FileProvider, hit: SearchHit, content: NonNullable<SearchQuery["content"]>,
    ctx: ScanContext) => Promise<SearchHit["line"]>;
}

export async function* searchCandidates(query: SearchQuery, provider: FileProvider, ctx: ScanContext): AsyncIterable<SearchHit> {
  const { root, limits, name, minSize, maxSize, modifiedAfter, modifiedBefore, content } = query;
  const matches = name && compileName(name, provider.endpoint.caseSensitive);
  const after = modifiedAfter === undefined ? null : BigInt(Date.parse(modifiedAfter)) * 1_000_000n;
  const before = modifiedBefore === undefined ? null : BigInt(Date.parse(modifiedBefore)) * 1_000_000n;
  const { signal } = ctx;
  let remaining = limits.maxEntries;
  signal.throwIfAborted();
  const rootEntry = await provider.stat(root.path, signal);
  signal.throwIfAborted();
  if (!rootEntry) throw new CommanderError("not_found", "Search directory does not exist");
  if (rootEntry.kind !== "dir") throw new CommanderError("not_a_directory", "Expected a search directory");

  async function* walk(path: ResourcePath, depth: number): AsyncIterable<SearchHit> {
    let cursor: string | null = null;
    const seen = new Set<string>();
    do {
      signal.throwIfAborted();
      if (!remaining) {
        ctx.markPartial("Search entry limit reached");
        return;
      }
      const limit = Math.min(LIST_PAGE_MAX, remaining);
      const page = await provider.list(path, { cursor, limit }, signal);
      signal.throwIfAborted();
      if (page.cursor !== null && (seen.has(page.cursor) || page.entries.length === 0) || page.entries.length > limit) {
        throw new CommanderError("internal", "Invalid search directory page");
      }
      cursor = page.cursor;
      if (cursor !== null) seen.add(cursor);
      for (const entry of page.entries) {
        signal.throwIfAborted();
        if (!remaining) {
          ctx.markPartial("Search entry limit reached");
          return;
        }
        remaining--;
        ctx.progress({ items: 1 });
        const child = join(path, entry.name);
        const size = BigInt(entry.size);
        const mtime = entry.mtimeNs === null ? null : BigInt(entry.mtimeNs);
        if ((!matches || ("t" in entry.name && matches(entry.name.t))) &&
            (minSize === undefined || size >= minSize) && (maxSize === undefined || size <= maxSize) &&
            (after === null || mtime !== null && mtime >= after) && (before === null || mtime !== null && mtime <= before) &&
            (!content || entry.kind === "file")) {
          yield { ref: { endpoint: root.endpoint, path: child }, entry };
        }
        if (entry.kind === "dir") {
          if (depth < limits.maxDepth) yield* walk(child, depth + 1);
          else ctx.markPartial("Search depth limit reached");
        }
      }
    } while (cursor !== null);
  }
  yield* walk(root.path, 1);
}

export async function* search(query: SearchQuery, providers: Providers, ctx: SearchContext,
  candidates?: Iterable<SearchHit>): AsyncIterable<SearchHit> {
  if (query.content && query.root.endpoint.startsWith("sftp:") && !ctx.remoteConsent) {
    throw new SearchConsentError();
  }
  const provider = providers(query.root.endpoint);
  let remaining = query.limits.maxBytesRead;
  for await (const hit of candidates ?? searchCandidates(query, provider, ctx)) {
    ctx.signal.throwIfAborted();
    if (!query.content) {
      yield hit;
      continue;
    }
    const size = BigInt(hit.entry.size);
    if (size > remaining) {
      ctx.markPartial("Search byte limit reached");
      continue;
    }
    remaining -= size;
    if (!ctx.matchContent) throw new CommanderError("unsupported", "Content search is unavailable");
    const line = await ctx.matchContent(provider, hit, query.content, ctx);
    if (line) yield { ...hit, line };
  }
}
