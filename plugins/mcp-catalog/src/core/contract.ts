import { z } from "zod";
import { SETTING_NAMES } from "./settings";

/** Wire contract of the plugin's RPC: plain schemas; `server.ts` wraps them for BB. No response carries a secret value. */

export const Origin = z.enum(["catalog", "infra", "other"]);

export const InventoryRowSchema = z.object({
  pluginId: z.string(),
  pluginName: z.string(),
  serverId: z.string(),
  status: z.string(),
  enabled: z.boolean(),
  approved: z.boolean(),
  origin: Origin,
  lastError: z.string().nullable(),
  updateAvailable: z.string().nullable(),
  /** Null when the bridge could not list tools. */
  toolCount: z.number().int().nonnegative().nullable(),
});
export type InventoryRowDto = z.infer<typeof InventoryRowSchema>;

export const InventoryResult = z.object({
  rows: z.array(InventoryRowSchema),
  /** Non-fatal problems: a plugin the bridge could not describe, an unreachable collection. */
  warnings: z.array(z.string()),
});
export type InventoryResult = z.infer<typeof InventoryResult>;

export const CollectionItemSchema = z.object({
  name: z.string(),
  version: z.string(),
  /** Short extract of the review report; empty when the entry could not be read. */
  summary: z.string(),
  /** Set when the entry is damaged: the item stays visible but cannot be installed. */
  error: z.string().nullable(),
  installed: z.boolean(),
});
export type CollectionItem = z.infer<typeof CollectionItemSchema>;

export const CollectionResult = z.object({ items: z.array(CollectionItemSchema) });
export type CollectionResult = z.infer<typeof CollectionResult>;

export const CatalogIdSchema = z.enum(["official", "github", "docker"]);
export type CatalogId = z.infer<typeof CatalogIdSchema>;

export const SearchSource = z.enum(["npm", "pypi", "docker", "remote"]);
export type SearchSource = z.infer<typeof SearchSource>;

export const SearchVersionSchema = z.object({
  version: z.string(),
  publishedAt: z.string().nullable(),
  description: z.string(),
  sources: z.array(SearchSource),
  /** Why this version cannot be reviewed here, or null. */
  unsupported: z.string().nullable(),
  /** A review of exactly this version is in progress. */
  reviewing: z.boolean(),
});
export type SearchVersion = z.infer<typeof SearchVersionSchema>;

/** One server with all the versions the registry listed, newest first. */
export const SearchItemSchema = z.object({
  name: z.string(),
  latestVersion: z.string(),
  versions: z.array(SearchVersionSchema).min(1),
  installed: z.boolean(),
  inCollection: z.boolean(),
  /** A review of any version of this server is in progress. */
  reviewing: z.boolean(),
  /** Catalogs that list this server. */
  catalogs: z.array(CatalogIdSchema),
  /** Why the latest version cannot be reviewed here, or null. */
  unsupported: z.string().nullable(),
});
export type SearchItem = z.infer<typeof SearchItemSchema>;

export const SearchResult = z.object({
  items: z.array(SearchItemSchema),
  nextCursor: z.string().nullable(),
  warning: z.string().nullable(),
});
export type SearchResult = z.infer<typeof SearchResult>;

export const ReviewStateSchema = z.enum(["reviewing", "ready", "failed", "accepted", "rejected"]);

export const ReviewItemSchema = z.object({
  name: z.string(),
  version: z.string(),
  state: ReviewStateSchema,
  error: z.string().nullable(),
  threadId: z.string(),
});
export type ReviewItem = z.infer<typeof ReviewItemSchema>;

export const ReviewsResult = z.object({ items: z.array(ReviewItemSchema) });
export type ReviewsResult = z.infer<typeof ReviewsResult>;

export const VariableStateSchema = z.object({
  name: z.string(),
  description: z.string().nullable(),
  isRequired: z.boolean(),
  isSecret: z.boolean(),
  /** Only whether a value exists; the value itself never leaves the server. */
  state: z.enum(["set", "missing"]),
});
export type VariableState = z.infer<typeof VariableStateSchema>;

export const SecretsStateResult = z.object({ variables: z.array(VariableStateSchema) });
export type SecretsStateResult = z.infer<typeof SecretsStateResult>;

export const InstallResult = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), pluginId: z.string(), needsApproval: z.literal(true) }),
  z.object({ ok: z.literal(false), message: z.string() }),
]);
export type InstallResult = z.infer<typeof InstallResult>;

export const ConfigResult = z.object({
  /** The id `bb plugin config <id>` takes. */
  pluginId: z.string(),
  /** Settings left empty; actions that need them are refused. */
  missing: z.array(z.enum(SETTING_NAMES)),
});
export type ConfigResult = z.infer<typeof ConfigResult>;

const PluginRef = z.object({ pluginId: z.string().min(1) });
const ServerRef = z.object({ pluginId: z.string().min(1), serverId: z.string().min(1) });
const NameRef = z.object({ name: z.string().min(1).max(200) });
/** A review of a server; the version tells apart reviews of several versions of the same name. */
const ReviewRef = NameRef.extend({ version: z.string().min(1).max(64).optional() });

export const MAX_VALUE_KEYS = 50;
export const MAX_VALUE_BYTES = 8 * 1024;

/** Variable name -> typed value; the count and size are capped before anything reaches a file. */
export const ValuesSchema = z
  .record(z.string().max(200), z.string().refine((value) => new TextEncoder().encode(value).length <= MAX_VALUE_BYTES, "значение длиннее 8 КиБ"))
  .refine((values) => Object.keys(values).length <= MAX_VALUE_KEYS, "слишком много переменных");

export const rpcSchemas = {
  config: { input: z.null(), output: ConfigResult },
  inventory: { input: z.null(), output: InventoryResult },
  setEnabled: { input: ServerRef.extend({ enabled: z.boolean() }), output: z.null() },
  approve: { input: ServerRef, output: z.null() },
  auth: { input: ServerRef, output: z.object({ url: z.string().nullable() }) },
  setSecrets: {
    input: PluginRef.extend({ values: ValuesSchema, clear: z.array(z.string().max(200)).max(MAX_VALUE_KEYS) }),
    output: z.null(),
  },
  remove: { input: PluginRef, output: z.null() },
  update: { input: PluginRef, output: z.null() },
  collection: { input: z.null(), output: CollectionResult },
  search: {
    input: z.object({
      query: z.string().trim().min(1).max(200),
      cursor: z.string().max(2000).optional(),
      catalogs: z.array(CatalogIdSchema).max(3).optional(),
    }),
    output: SearchResult,
  },
  startReview: {
    input: z.object({ name: z.string().min(1).max(200), version: z.string().min(1).max(64) }),
    output: ReviewItemSchema,
  },
  reviews: { input: z.null(), output: ReviewsResult },
  accept: { input: ReviewRef, output: z.null() },
  reject: { input: ReviewRef, output: z.null() },
  install: { input: NameRef.extend({ values: ValuesSchema }), output: InstallResult },
  secretsState: { input: z.union([NameRef, PluginRef]), output: SecretsStateResult },
} as const;
