import { canonicalJson } from "./collection";
import type { RegistryMeta, RegistryPage, RegistryServer } from "./registry";

export const DOCKER_PREFIX = "com.docker.mcp/";
export const DOCKER_PAGE_SIZE = 30;

/** Why a Docker entry is listed but cannot be reviewed. Shown to the user, so Russian. */
export const UNSUPPORTED = {
  poci: "тип poci не поддерживается",
  volumes: "нужны тома (volumes)",
  commandTemplate: "шаблоны в command не поддерживаются",
  noDigest: "образ без закреплённого digest",
  oauth: "нужен вход OAuth",
} as const;
const BROKEN = "запись каталога повреждена";
const NO_RUNTIME = "нет ни образа, ни удалённого адреса";
const mixedTemplate = (name: string) => `переменная ${name}: смешанный шаблон`;

const badVariable = (name: string) => `некорректное имя переменной ${name}`;
const BAD_IMAGE = "некорректный образ";
const REMOTE_HEADERS = "удалённый адрес с заголовками пока не поддерживается";
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const OCI_IDENTIFIER = /^[@A-Za-z0-9][A-Za-z0-9@/._:-]*$/;
const HOST = /^[A-Za-z0-9*.-]{1,253}(:\d{1,5})?$/;
const KEY = /^[A-Za-z0-9._-]{1,100}$/;
const IMAGE = /^([^@]+)@sha256:([0-9a-f]{64})$/;
const WHOLE_TEMPLATE = /^\{\{([^.{}|]+)\.([^{}|]+)\}\}$/;
const DIGEST_MISMATCH = "ociDigest в entry.json не совпадает с digest образа из каталога Docker";

/** Lowercase hex SHA-256 of a string; injected because src/core has no crypto. */
export type Hash = (text: string) => string;

type Obj = Record<string, unknown>;
type EnvVar = { name: string; description?: string; isRequired: boolean; isSecret?: boolean; default?: string };

const isObj = (value: unknown): value is Obj => typeof value === "object" && value !== null && !Array.isArray(value);
const str = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined);
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/** Config property descriptions by `<config>.<prop>`, and which of them are required. */
function configProps(config: unknown): Map<string, { description?: string; required: boolean }> {
  const props = new Map<string, { description?: string; required: boolean }>();
  for (const block of list(config)) {
    if (!isObj(block)) continue;
    const owner = str(block.name);
    if (owner === undefined) continue;
    const required = list(block.required).filter((item): item is string => typeof item === "string");
    const add = (prop: string | undefined, schema: unknown) => {
      if (prop === undefined) return;
      const description = isObj(schema) ? str(schema.description) : undefined;
      props.set(`${owner}.${prop}`, { ...(description === undefined ? {} : { description }), required: required.includes(prop) });
    };
    if (Array.isArray(block.properties)) {
      for (const item of block.properties) if (isObj(item)) add(str(item.Name), item.Schema);
    } else if (isObj(block.properties)) {
      for (const [prop, schema] of Object.entries(block.properties)) add(prop, schema);
    }
  }
  return props;
}

function mixedEnvName(entry: Obj): string | undefined {
  for (const item of list(entry.env)) {
    if (!isObj(item)) continue;
    const value = str(item.value);
    if (value !== undefined && value.includes("{{") && !WHOLE_TEMPLATE.test(value)) return str(item.name) ?? "?";
  }
  return undefined;
}

function badEnvName(entry: Obj): string | undefined {
  const names = [...list(entry.secrets), ...list(entry.env)].flatMap((item, at) => {
    if (!isObj(item)) return [];
    const name = at < list(entry.secrets).length ? str(item.env) : str(item.name);
    return name === undefined ? [] : [name];
  });
  return names.find((name) => !ENV_NAME.test(name));
}

function envVariables(entry: Obj): EnvVar[] {
  const vars: EnvVar[] = [];
  const secretEnvs = new Set<string>();
  for (const secret of list(entry.secrets)) {
    if (!isObj(secret)) continue;
    const name = str(secret.env);
    if (name === undefined) continue;
    secretEnvs.add(name);
    const description = str(secret.description);
    vars.push({ name, ...(description === undefined ? {} : { description }), isSecret: true, isRequired: true });
  }
  const props = configProps(entry.config);
  for (const item of list(entry.env)) {
    if (!isObj(item)) continue;
    const name = str(item.name);
    if (name === undefined || secretEnvs.has(name)) continue;
    const value = str(item.value);
    const template = value === undefined ? null : WHOLE_TEMPLATE.exec(value);
    if (template !== null) {
      const prop = props.get(`${template[1]}.${template[2]}`);
      vars.push({ name, ...(prop?.description === undefined ? {} : { description: prop.description }), isRequired: prop?.required ?? false });
    } else if (value !== undefined) {
      vars.push({ name, default: value, isRequired: false });
    }
  }
  return vars;
}

function remoteOf(entry: Obj): { remote: NonNullable<RegistryServer["remotes"]>[number]; hasHeaders: boolean } | undefined {
  const remote = entry.remote;
  if (!isObj(remote)) return undefined;
  const url = str(remote.url);
  const type = remote.transport_type;
  if (url === undefined || (type !== "streamable-http" && type !== "sse")) return undefined;
  const hasHeaders = isObj(remote.headers) && Object.keys(remote.headers).length > 0;
  return { remote: { type, url }, hasHeaders };
}

/** Version of a record that pins no image: a digest of everything that decides how it runs. */
function contentVersion(entry: Obj, hash: Hash): string {
  const text = canonicalJson({ remote: entry.remote ?? null, env: entry.env ?? null, secrets: entry.secrets ?? null, config: entry.config ?? null });
  return `sha256-${hash(text).slice(0, 12)}`;
}

/**
 * One Docker catalog entry as a registry `server.json` record. An entry this plugin cannot run still yields a
 * minimal record with `meta.unsupported` naming the reason; only an invalid `key` throws.
 */
export function mapDockerEntry(key: string, entry: unknown, hash: Hash): { server: RegistryServer; meta: RegistryMeta } {
  if (!KEY.test(key)) throw new Error("недопустимый ключ записи каталога Docker");
  const name = `${DOCKER_PREFIX}${key}`;
  const data: Obj = isObj(entry) ? entry : {};
  const description = str(data.description) ?? str(data.title) ?? name;
  const image = str(data.image);
  const pinned = image === undefined ? null : IMAGE.exec(image);
  const version = pinned === null ? "latest" : `sha256-${(pinned[2] ?? "").slice(0, 12)}`;
  const minimal = (unsupported: string) => ({ server: { name, description, version }, meta: { unsupported } });

  if (!isObj(entry)) return minimal(BROKEN);
  if (data.type === "poci") return minimal(UNSUPPORTED.poci);
  if (list(data.volumes).length > 0) return minimal(UNSUPPORTED.volumes);
  if (list(data.command).some((part) => typeof part === "string" && part.includes("{{"))) return minimal(UNSUPPORTED.commandTemplate);
  const mixed = mixedEnvName(data);
  if (mixed !== undefined) return minimal(mixedTemplate(mixed));
  const badName = badEnvName(data);
  if (badName !== undefined) return minimal(badVariable(badName));
  if (pinned !== null && !OCI_IDENTIFIER.test(pinned[1] ?? "")) return minimal(BAD_IMAGE);

  const found = remoteOf(data);
  if (pinned === null && found?.hasHeaders === true) return minimal(REMOTE_HEADERS);
  const remote = found === undefined || found.hasHeaders ? undefined : found.remote;
  if (pinned === null && remote === undefined) {
    if (image !== undefined) return minimal(UNSUPPORTED.noDigest);
    return minimal(list(data.oauth).length > 0 ? UNSUPPORTED.oauth : NO_RUNTIME);
  }

  const repoUrl = [str(data.source), str(data.upstream)].find((url) => url !== undefined && /^https:\/\/github\.com\//.test(url));
  const website = str(data.upstream);
  const variables = envVariables(data);
  const commandArgs = list(data.command).filter((part): part is string => typeof part === "string");
  const server: RegistryServer = {
    name,
    description,
    version: pinned === null ? contentVersion(data, hash) : version,
    ...(website === undefined ? {} : { websiteUrl: website }),
    ...(repoUrl === undefined ? {} : { repository: { url: repoUrl, source: "github" } }),
    ...(pinned === null
      ? {}
      : {
          packages: [
            {
              registryType: "oci" as const,
              identifier: pinned[1] ?? "",
              version: `sha256:${pinned[2]}`,
              transport: { type: "stdio" },
              ...(variables.length === 0 ? {} : { environmentVariables: variables }),
              ...(commandArgs.length === 0 ? {} : { packageArguments: commandArgs.map((value) => ({ type: "positional", value })) }),
            },
          ],
        }),
    ...(remote === undefined ? {} : { remotes: [remote] }),
  };
  return { server, meta: {} };
}

/**
 * `run.allowHosts` of an entry: hosts the Docker catalog would allow; this plugin does not enforce them. The text
 * goes into an agent prompt, so only plain host[:port] tokens are kept; `dropped` says some were not.
 */
export function allowHostsOf(entry: unknown): { hosts: string[]; dropped: boolean } {
  if (!isObj(entry) || !isObj(entry.run)) return { hosts: [], dropped: false };
  const all = list(entry.run.allowHosts);
  const hosts = all.filter((host): host is string => typeof host === "string" && HOST.test(host));
  return { hosts, dropped: hosts.length !== all.length };
}

/** The digest an OCI record pins, if any. */
export function ociDigestOf(server: RegistryServer): string | undefined {
  return server.packages?.find((pkg) => pkg.registryType === "oci")?.version;
}

/** Accept guard for Docker records: `entry.json`'s `ociDigest` must be the digest the catalog pins. */
export function checkDockerDigest(server: RegistryServer, ociDigest: string | undefined): void {
  const pinned = ociDigestOf(server);
  if (pinned === undefined) return;
  if (ociDigest !== pinned) throw new Error(DIGEST_MISMATCH);
}

function matches(key: string, entry: unknown, needle: string): boolean {
  if (needle === "") return true;
  const data: Obj = isObj(entry) ? entry : {};
  const tags = isObj(data.metadata) ? list(data.metadata.tags) : [];
  return [key, data.title, data.description, ...tags].some((part) => typeof part === "string" && part.toLowerCase().includes(needle));
}

/** Local search over the whole Docker catalog: substring over key, title, description and tags; cursor is the next offset. */
export function searchDocker(entries: Record<string, unknown>, query: string, offset: number, limit: number, hash: Hash): RegistryPage {
  const needle = query.trim().toLowerCase();
  const hits = Object.entries(entries).filter(([key, entry]) => KEY.test(key) && matches(key, entry, needle));
  const slice = hits.slice(offset, offset + limit);
  const mapped = slice.map(([key, entry]) => mapDockerEntry(key, entry, hash));
  const next = offset + limit;
  return {
    servers: mapped.map((item) => item.server),
    meta: mapped.map((item) => item.meta),
    ...(next < hits.length ? { nextCursor: String(next) } : {}),
  };
}
