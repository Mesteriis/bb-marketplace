import { z } from "zod";

const KeyValueInput = z.looseObject({
  name: z.string(),
  description: z.string().optional(),
  isRequired: z.boolean().optional(),
  isSecret: z.boolean().optional(),
  default: z.string().optional(),
});

const Argument = z.looseObject({
  type: z.string().optional(),
  name: z.string().optional(),
  value: z.string().optional(),
  valueHint: z.string().optional(),
  description: z.string().optional(),
  isRequired: z.boolean().optional(),
  isSecret: z.boolean().optional(),
  default: z.string().optional(),
});

const Package = z.looseObject({
  registryType: z.enum(["npm", "pypi", "oci"]),
  identifier: z.string(),
  version: z.string().optional(),
  transport: z.looseObject({ type: z.string() }),
  environmentVariables: z.array(KeyValueInput).optional(),
  packageArguments: z.array(Argument).optional(),
  runtimeArguments: z.array(Argument).optional(),
});

const Remote = z.looseObject({
  type: z.enum(["streamable-http", "sse"]),
  url: z.string(),
  headers: z.array(KeyValueInput).optional(),
});

/** Subset of the MCP Registry `server.json` (schema 2025-10-17). */
export const RegistryServer = z.looseObject({
  name: z.string(),
  description: z.string(),
  version: z.string(),
  websiteUrl: z.string().optional(),
  repository: z.looseObject({ url: z.string(), source: z.string() }).optional(),
  packages: z.array(Package).optional(),
  remotes: z.array(Remote).optional(),
});
export type RegistryServer = z.infer<typeof RegistryServer>;

/** Registry bookkeeping of one listed server (`_meta`); kept apart from the server so it never enters server.json. */
export interface RegistryMeta {
  publishedAt?: string;
  isLatest?: boolean;
}

export interface RegistryPage {
  servers: RegistryServer[];
  /** Parallel to `servers`; absent when no entry carried `_meta`. */
  meta?: RegistryMeta[];
  nextCursor?: string;
}

export interface RegistryPort {
  search(query: string, cursor?: string): Promise<RegistryPage>;
}

const PageEnvelope = z.object({
  servers: z.array(z.unknown()),
  metadata: z.object({ nextCursor: z.string().min(1).optional() }).optional(),
});

const OFFICIAL_META = z.object({ publishedAt: z.string().optional(), isLatest: z.boolean().optional() });

function metaOf(entry: unknown): RegistryMeta {
  const raw = (entry as { _meta?: Record<string, unknown> } | null)?._meta?.["io.modelcontextprotocol.registry/official"];
  const parsed = OFFICIAL_META.safeParse(raw);
  if (!parsed.success) return {};
  return {
    ...(parsed.data.publishedAt === undefined ? {} : { publishedAt: parsed.data.publishedAt }),
    ...(parsed.data.isLatest === undefined ? {} : { isLatest: parsed.data.isLatest }),
  };
}

/** Reads one `v0/servers` response page; entries that fail validation are skipped. */
export function parseRegistryPage(json: unknown): RegistryPage {
  const envelope = PageEnvelope.safeParse(json);
  if (!envelope.success) return { servers: [] };
  const servers: RegistryServer[] = [];
  const meta: RegistryMeta[] = [];
  for (const entry of envelope.data.servers) {
    const parsed = RegistryServer.safeParse(
      typeof entry === "object" && entry !== null ? (entry as { server?: unknown }).server : undefined,
    );
    if (!parsed.success) continue;
    servers.push(parsed.data);
    meta.push(metaOf(entry));
  }
  const nextCursor = envelope.data.metadata?.nextCursor;
  return {
    servers,
    ...(meta.some((item) => Object.keys(item).length > 0) ? { meta } : {}),
    ...(nextCursor === undefined ? {} : { nextCursor }),
  };
}
