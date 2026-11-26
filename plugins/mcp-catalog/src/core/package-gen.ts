import { type CollectionEntry, serverSlug } from "./collection";
import type { RegistryServer } from "./registry";
import { LEGACY_STDIO_SHIM } from "./shim";

const PLUGIN_SCHEMA = "https://agent-plugins.org/schemas/1.1.0/plugin.schema.json";
const MCP_SCHEMA = "https://agent-plugins.org/schemas/1.1.0/mcp.schema.json";
const OCI_DIGEST = /^sha256:[0-9a-f]{64}$/;

/** Single-quotes a value for sh; embedded quotes become `'\''`. */
function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;

type Pin = "semver" | "pypi" | "loose";

function requirePinned(version: string, kind: Pin): string {
  const loose = version.trim() !== "" && version.toLowerCase() !== "latest" && !/[\^~*<>|\s]/.test(version);
  const ok =
    kind === "semver" ? SEMVER.test(version) : kind === "pypi" ? /^\d/.test(version) && !/[,!=*<>~^\s]/.test(version) : loose;
  if (!ok || !loose) {
    throw new Error(`версия «${version}» не закреплена: нужна точная версия, без latest и диапазонов`);
  }
  return version;
}

function requireIdentifier(identifier: string, allowColon: boolean): string {
  const pattern = allowColon ? /^[@A-Za-z0-9][A-Za-z0-9@/._:-]*$/ : /^[@A-Za-z0-9][A-Za-z0-9@/._-]*$/;
  if (!pattern.test(identifier)) throw new Error(`недопустимый идентификатор пакета «${identifier}»`);
  return identifier;
}

function requireEnvName(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`недопустимое имя переменной окружения «${name}»`);
  return name;
}

type Argument = NonNullable<NonNullable<RegistryServer["packages"]>[number]["packageArguments"]>[number];

/**
 * The fixed part of a package's arguments: an argument with a `value` is passed, a required one falls back to
 * its `default`; an optional one without a value is left to the server. A required argument with no fixed
 * value (or one built from template variables) would need a form field, which is not supported yet.
 */
function fixedArguments(args: Argument[] | undefined): string[] {
  const out: string[] = [];
  for (const arg of args ?? []) {
    const templated = typeof arg.variables === "object" && arg.variables !== null && Object.keys(arg.variables).length > 0;
    const value = templated ? undefined : (arg.value ?? (arg.isRequired === true ? arg.default : undefined));
    if (value === undefined) {
      if (arg.isRequired === true) throw new Error("аргументы пакета пока не поддерживаются: у обязательного аргумента нет готового значения");
      continue;
    }
    if (arg.type === "named") {
      if (arg.name === undefined || !/^-{1,2}[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(arg.name)) {
        throw new Error(`недопустимое имя аргумента «${arg.name ?? ""}»`);
      }
      out.push(arg.name);
    }
    out.push(value);
  }
  return out;
}

/** Name of the generated bridge plugin for a server slug. */
export function pluginName(slug: string): string {
  const name = `mcp-${slug}`.slice(0, 64).replace(/[-.]+$/, "");
  if (slug === "") throw new Error("не удалось получить имя пакета из имени сервера");
  return name;
}

/** Id of the server the generated `mcp.json` declares (the key of `mcpServers`). */
export function generatedServerId(slug: string): string {
  return slug;
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** Builds the bridge package files (path -> content) for an accepted collection entry. */
export function generatePackage(
  server: RegistryServer,
  entry: CollectionEntry,
  paths: { envFile: string },
): Record<string, string> {
  const slug = serverSlug(entry.name);
  const plugin = json({
    $schema: PLUGIN_SCHEMA,
    name: pluginName(slug),
    version: entry.version,
    description: server.description,
  });

  if (entry.choice.kind === "remote") {
    requirePinned(entry.version, "loose");
    const remote = server.remotes?.[entry.choice.index];
    if (!remote) throw new Error("выбранный удалённый адрес не найден в server.json");
    if (remote.headers?.some((header) => header.isSecret === true)) {
      throw new Error("удалённые адреса с секретными заголовками пока не поддерживаются");
    }
    return {
      "plugin.json": plugin,
      "mcp.json": json({
        $schema: MCP_SCHEMA,
        mcpServers: { [generatedServerId(slug)]: { type: remote.type, url: remote.url } },
      }),
    };
  }

  const pkg = server.packages?.[entry.choice.index];
  if (!pkg) throw new Error("выбранный пакет не найден в server.json");
  if (pkg.transport.type !== "stdio") {
    throw new Error(`транспорт пакета «${pkg.transport.type}» не поддерживается: нужен stdio`);
  }
  const pin: Pin = pkg.registryType === "npm" ? "semver" : pkg.registryType === "pypi" ? "pypi" : "loose";
  requirePinned(entry.version, pin);
  const version = requirePinned(pkg.version ?? entry.version, pin);
  const id = requireIdentifier(pkg.identifier, pkg.registryType === "oci");
  const runtimeArgs = fixedArguments(pkg.runtimeArguments);
  const packageArgs = fixedArguments(pkg.packageArguments);
  let command: string[];
  if (pkg.registryType === "npm") {
    command = ["npx", ...runtimeArgs, "-y", `${id}@${version}`, ...packageArgs];
  } else if (pkg.registryType === "pypi") {
    command = ["uvx", ...runtimeArgs, `${id}==${version}`, ...packageArgs];
  } else {
    if (!entry.ociDigest || !OCI_DIGEST.test(entry.ociDigest)) {
      throw new Error("для образа OCI нужен ociDigest вида sha256:<64 hex>");
    }
    const envArgs = (pkg.environmentVariables ?? []).flatMap((v) => ["-e", requireEnvName(v.name)]);
    command = ["docker", "run", "--rm", "-i", ...envArgs, ...runtimeArgs, `${id}@${entry.ociDigest}`, ...packageArgs];
  }

  const run = [
    "#!/bin/sh",
    "set -eu",
    `set -a; . ${shQuote(paths.envFile)}; set +a`,
    `exec python3 "$(dirname "$0")/shim.py" ${command.map(shQuote).join(" ")}`,
    "",
  ].join("\n");

  return {
    "plugin.json": plugin,
    "mcp.json": json({
      $schema: MCP_SCHEMA,
      mcpServers: { [generatedServerId(slug)]: { type: "stdio", command: "./bin/run.sh" } },
    }),
    "bin/run.sh": run,
    "bin/shim.py": LEGACY_STDIO_SHIM,
  };
}
