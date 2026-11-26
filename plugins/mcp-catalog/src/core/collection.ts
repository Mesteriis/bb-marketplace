import { z } from "zod";
import { RegistryServer } from "./registry";

export const CollectionEntry = z.object({
  name: z.string(),
  version: z.string(),
  serverJsonSha256: z.string(),
  choice: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("package"), index: z.number().int().nonnegative() }),
    z.object({ kind: z.literal("remote"), index: z.number().int().nonnegative() }),
  ]),
  // A reviewer may write null for a non-OCI package; it means "absent".
  ociDigest: z.preprocess((value) => (value === null ? undefined : value), z.string().optional()),
  notes: z.array(z.string()).optional(),
  acceptedAt: z.string(),
});
export type CollectionEntry = z.infer<typeof CollectionEntry>;

/** What the reviewer writes: `acceptedAt` is added by `accept`. */
export const CollectionEntryDraft = CollectionEntry.omit({ acceptedAt: true });
export type CollectionEntryDraft = z.infer<typeof CollectionEntryDraft>;

/** Stable identifier of a registry server name: lower-case, `-`-separated. */
export function serverSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

export const CollectionIndex = z.object({
  servers: z.array(z.object({ name: z.string(), version: z.string(), path: z.string() })),
});
export type CollectionIndex = z.infer<typeof CollectionIndex>;

type IndexLine = CollectionIndex["servers"][number];

/** `base` with this server's line put in: replaced in place when the name is there, appended otherwise. */
export function withIndexLine(base: CollectionIndex, line: IndexLine): CollectionIndex {
  const at = base.servers.findIndex((item) => item.name === line.name);
  const servers = at < 0 ? [...base.servers, line] : base.servers.map((item, position) => (position === at ? line : item));
  return { servers };
}

/**
 * Reads the collection from `origin/main` after a fetch, nowhere else.
 * Installation may only use an entry whose `serverJsonSha256` matches its server.json.
 */
export interface CollectionPort {
  readIndex(): Promise<CollectionIndex>;
  readFile(path: string): Promise<string>;
  /** True when `commit` (an accept commit this catalog recorded) is an ancestor of `origin/main`. */
  isAccepted(commit: string): Promise<boolean>;
  /** Forget any cached read so that the next `readIndex` sees the remote again. */
  invalidate?(): void;
}

/** JSON with object keys sorted at every depth: two equal values give the same text. */
export function canonicalJson(value: unknown): string {
  const sort = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(sort);
    if (item !== null && typeof item === "object") {
      return Object.fromEntries(
        Object.keys(item)
          .sort()
          .map((key) => [key, sort((item as Record<string, unknown>)[key])]),
      );
    }
    return item;
  };
  return JSON.stringify(sort(value));
}

export async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function loadAcceptedEntry(
  port: CollectionPort,
  name: string,
  /** An index the caller has already read, so that listing many entries reads it once. */
  knownIndex?: CollectionIndex,
): Promise<{ server: RegistryServer; entry: CollectionEntry; review: string }> {
  const index = knownIndex ?? CollectionIndex.parse(await port.readIndex());
  const found = index.servers.find((item) => item.name === name);
  if (found === undefined) throw new Error("сервера нет в коллекции");
  if (found.path !== `mcp-collection/${serverSlug(found.name)}`) {
    throw new Error("запись коллекции повреждена: неверный путь");
  }
  const serverText = await port.readFile(`${found.path}/server.json`);
  const review = await port.readFile(`${found.path}/review.md`);
  const entry = CollectionEntry.parse(JSON.parse(await port.readFile(`${found.path}/entry.json`)));
  if (entry.name !== found.name || entry.version !== found.version) {
    throw new Error("запись коллекции повреждена: entry.json не совпадает с индексом");
  }
  if ((await sha256Hex(serverText)) !== entry.serverJsonSha256) {
    throw new Error("запись коллекции повреждена: хэш server.json не совпадает");
  }
  const server = RegistryServer.parse(JSON.parse(serverText));
  if (server.name !== entry.name || server.version !== entry.version) {
    throw new Error("запись коллекции повреждена: server.json не совпадает с entry.json");
  }
  return { server, entry, review };
}
