import { describe, expect, it } from "vitest";
import { CollectionEntry, serverSlug } from "./collection";
import { generatePackage, pluginName } from "./package-gen";
import { LEGACY_STDIO_SHIM } from "./shim";
import type { RegistryServer } from "./registry";

const paths = { envFile: "/home/u/.config/bb-mcp/time.env" };

function server(extra: Partial<RegistryServer>): RegistryServer {
  return { name: "io.github.Acme/Time-Server", description: "Time", version: "1.2.3", ...extra };
}

function entry(extra: Partial<CollectionEntry> = {}): CollectionEntry {
  return {
    name: "io.github.Acme/Time-Server",
    version: "1.2.3",
    serverJsonSha256: "a".repeat(64),
    choice: { kind: "package", index: 0 },
    acceptedAt: "2026-11-26T00:00:00Z",
    ...extra,
  };
}

const npm = server({
  packages: [{ registryType: "npm", identifier: "@acme/time", version: "1.2.3", transport: { type: "stdio" } }],
});

describe("serverSlug", () => {
  it("normalizes a registry name", () => {
    expect(serverSlug("io.github.Acme/Time-Server")).toBe("io-github-acme-time-server");
  });
});

const SANDBOX =
  "'--network' 'none' '--read-only' '--tmpfs' '/tmp:rw,noexec,nosuid,size=64m' '--user' '65534:65534' '--cap-drop' 'ALL' '--security-opt' 'no-new-privileges' '-e' 'HOME=/tmp'";

describe("generatePackage docker sandbox", () => {
  const image = server({ packages: [{ registryType: "oci", identifier: "ghcr.io/acme/time", transport: { type: "stdio" } }] });
  const digest = `sha256:${"b".repeat(64)}`;
  const run = (docker?: CollectionEntry["docker"]) => generatePackage(image, entry({ ociDigest: digest, docker }), paths)["bin/run.sh"];

  it("launches with every strict flag by default", () => {
    expect(run()).toBe(
      `#!/bin/sh\nset -eu\nset -a; . '/home/u/.config/bb-mcp/time.env'; set +a\nexec python3 "$(dirname "$0")/shim.py" 'docker' 'run' '--rm' '-i' ${SANDBOX} 'ghcr.io/acme/time@${digest}'\n`,
    );
    expect(run({})).toBe(run());
    expect(run({ network: "none", user: "nobody" })).toBe(run());
  });

  it("docker.network bridge swaps the network flag", () => {
    expect(run({ network: "bridge" })).toContain(`'--rm' '-i' '--network' 'bridge' '--read-only'`);
  });

  it("docker.user image drops --user", () => {
    const text = run({ user: "image" }) ?? "";
    expect(text).not.toContain("--user");
    expect(text).toContain(`'--tmpfs' '/tmp:rw,noexec,nosuid,size=64m' '--cap-drop' 'ALL'`);
  });

  it.each(["DOCKER_HOST", "HOME", "DYLD_INSERT_LIBRARIES", "PATH", "LD_PRELOAD", "PYTHONPATH", "DOCKER_CONFIG"])(
    "refuses a declared %s for an OCI package",
    (name) => {
      const bad = server({ packages: [{ registryType: "oci", identifier: "ghcr.io/acme/time", transport: { type: "stdio" }, environmentVariables: [{ name, default: "x" }] }] });
      expect(() => generatePackage(bad, entry({ ociDigest: digest }), paths)).toThrow(`переменная «${name}» запрещена для образа OCI: она меняет запуск docker`);
    },
  );

  it("always passes -e HOME=/tmp and allows ordinary declared variables", () => {
    const ok = server({ packages: [{ registryType: "oci", identifier: "ghcr.io/acme/time", transport: { type: "stdio" }, environmentVariables: [{ name: "HOMEDIR" }] }] });
    expect(generatePackage(ok, entry({ ociDigest: digest }), paths)["bin/run.sh"]).toContain(`'-e' 'HOME=/tmp' '-e' 'HOMEDIR' 'ghcr.io/acme/time@`);
  });

  it("does not apply the OCI variable rule to npm", () => {
    const n = server({ packages: [{ registryType: "npm", identifier: "@acme/time", version: "1.2.3", transport: { type: "stdio" }, environmentVariables: [{ name: "HOME" }] }] });
    expect(generatePackage(n, entry(), paths)["bin/run.sh"]).toContain("'npx'");
  });

  it("refuses docker on a non-OCI choice", () => {
    expect(() => generatePackage(npm, entry({ docker: { network: "bridge" } }), paths)).toThrow("поле docker допустимо только для образа OCI");
  });
});

describe("generatePackage", () => {
  it("generates npm launcher pinned to version", () => {
    const files = generatePackage(npm, entry(), paths);
    expect(Object.keys(files).sort()).toEqual(["bin/run.sh", "bin/shim.py", "mcp.json", "plugin.json", "variables.json"]);
    const run = files["bin/run.sh"] ?? "";
    expect(run.startsWith("#!/bin/sh\nset -eu\n")).toBe(true);
    expect(run).toContain(`set -a; . '/home/u/.config/bb-mcp/time.env'; set +a`);
    expect(run).toContain(`exec python3 "$(dirname "$0")/shim.py" 'npx' '-y' '@acme/time@1.2.3'`);
    expect(files["bin/shim.py"]).toBe(LEGACY_STDIO_SHIM);
    const plugin = JSON.parse(files["plugin.json"] ?? "");
    expect(plugin.name).toBe("mcp-io-github-acme-time-server");
    expect(plugin.version).toBe("1.2.3");
    expect(JSON.parse(files["mcp.json"] ?? "").mcpServers).toEqual({
      "io-github-acme-time-server": { type: "stdio", command: "./bin/run.sh" },
    });
  });

  it("generates uvx launcher", () => {
    const s = server({
      packages: [{ registryType: "pypi", identifier: "mcp-time", version: "0.4.0", transport: { type: "stdio" } }],
    });
    expect(generatePackage(s, entry(), paths)["bin/run.sh"]).toContain("'uvx' 'mcp-time==0.4.0'");
  });

  it("generates docker launcher pinned to digest", () => {
    const s = server({
      packages: [{ registryType: "oci", identifier: "ghcr.io/acme/time", transport: { type: "stdio" } }],
    });
    const digest = `sha256:${"b".repeat(64)}`;
    const run = generatePackage(s, entry({ ociDigest: digest }), paths)["bin/run.sh"];
    expect(run).toContain(`'docker' 'run' '--rm' '-i' '--network' 'none' '--read-only' '--tmpfs' '/tmp:rw,noexec,nosuid,size=64m' '--user' '65534:65534' '--cap-drop' 'ALL' '--security-opt' 'no-new-privileges' '-e' 'HOME=/tmp' 'ghcr.io/acme/time@${digest}'\n`);
  });

  it("docker launcher passes positional arguments after the image, never before it", () => {
    const s = server({
      packages: [
        {
          registryType: "oci",
          identifier: "ghcr.io/acme/time",
          transport: { type: "stdio" },
          packageArguments: [
            { type: "positional", value: "--transport=stdio" },
            { type: "positional", value: "-v" },
          ],
        },
      ],
    });
    const digest = `sha256:${"b".repeat(64)}`;
    const run = generatePackage(s, entry({ ociDigest: digest }), paths)["bin/run.sh"];
    expect(run).toContain(`'ghcr.io/acme/time@${digest}' '--transport=stdio' '-v'`);
    expect(run).not.toContain(`'--transport=stdio' 'ghcr.io`);
  });

  it("remote without secret headers has no launcher", () => {
    const s = server({ remotes: [{ type: "streamable-http", url: "https://x.example/mcp", headers: [{ name: "X-Id" }] }] });
    const files = generatePackage(s, entry({ choice: { kind: "remote", index: 0 } }), paths);
    expect(Object.keys(files).sort()).toEqual(["mcp.json", "plugin.json", "variables.json"]);
    expect(JSON.parse(files["mcp.json"] ?? "").mcpServers["io-github-acme-time-server"]).toEqual({
      type: "streamable-http",
      url: "https://x.example/mcp",
    });
  });

  it("rejects latest and ranges", () => {
    for (const version of ["", "latest", "^1.0.0", "~1.0", "*", ">=1", "1 2", "1|2", "<2", "1", "1.x", "next", "beta", "1.2"]) {
      expect(() => generatePackage(npm, entry({ version }), paths)).toThrow(/не закреплена/);
    }
    const py = server({
      packages: [{ registryType: "pypi", identifier: "mcp-time", version: ">=1.0", transport: { type: "stdio" } }],
    });
    expect(() => generatePackage(py, entry({ version: "1.0.0" }), paths)).toThrow(/не закреплена/);
    for (const version of [">=1.0", "1.*", "1,2", "!1", "==1.0", "~1.0", "a1", "1 0"]) {
      expect(() => generatePackage(py, entry({ version }), paths)).toThrow(/не закреплена/);
    }
    expect(() => generatePackage(npm, entry({ version: "1.2.3-beta.1+build.5" }), paths)).not.toThrow();
  });

  it("pins a PyPI version to PEP 440 characters: no shell or separator characters", () => {
    const py = (version: string) => server({ packages: [{ registryType: "pypi", identifier: "mcp-time", version, transport: { type: "stdio" } }] });
    for (const version of ["1.0.0", "2024.1.2", "1.0.0rc1", "1.0.0.post1", "1.0.0.dev2", "1.0+local.1", "1.0.0a1"]) {
      expect(() => generatePackage(py(version), entry({ version }), paths)).not.toThrow();
    }
    for (const version of ["1.0;touch x", "1.0.0;", "1.0&&id", "1.0'x", "1.0#x", "1.0$(id)", "1.0\nx", "1.0.0/x", "1.0`x`"]) {
      expect(() => generatePackage(py("1.0.0"), entry({ version }), paths), version).toThrow(/не закреплена/);
      expect(() => generatePackage(py(version), entry({ version: "1.0.0" }), paths), version).toThrow(/не закреплена/);
    }
  });

  it("pins an OCI image by digest: a tag in the identifier is dropped, a registry port is kept, an `@` is refused", () => {
    const oci = (identifier: string) => server({ packages: [{ registryType: "oci", identifier, transport: { type: "stdio" } }] });
    const hex = "b".repeat(64);
    const withDigest = entry({ ociDigest: `sha256:${hex}` });
    const image = (identifier: string) => generatePackage(oci(identifier), withDigest, paths)["bin/run.sh"] ?? "";
    expect(image("ghcr.io/x/y:1.2.3")).toContain(`'ghcr.io/x/y@sha256:${hex}'`);
    expect(image("ghcr.io/x/y:1.2.3")).not.toContain("1.2.3");
    expect(image("localhost:5000/x")).toContain(`'localhost:5000/x@sha256:${hex}'`);
    expect(image("localhost:5000/x:v2")).toContain(`'localhost:5000/x@sha256:${hex}'`);
    for (const identifier of [`x@sha256:${"a".repeat(64)}`, `ghcr.io/x/y:1.2@sha256:${"a".repeat(64)}`]) {
      expect(() => generatePackage(oci(identifier), withDigest, paths), identifier).toThrow(/digest/);
    }
  });

  it("rejects an empty slug before building a plugin name", () => {
    expect(() => pluginName("")).toThrow("не удалось получить имя пакета");
    expect(pluginName("a".repeat(80)).length).toBeLessThanOrEqual(64);
  });

  it("rejects an identifier that could be read as a flag or break quoting", () => {
    for (const identifier of ["--privileged", "--from=git+https://x", "-y", "x'; touch /tmp/p; '", "a b", "a;b"]) {
      for (const registryType of ["npm", "pypi"] as const) {
        const s = server({ packages: [{ registryType, identifier, version: "1.0.0", transport: { type: "stdio" } }] });
        expect(() => generatePackage(s, entry({ version: "1.0.0" }), paths)).toThrow(/недопустимый идентификатор/);
      }
    }
    const oci = server({ packages: [{ registryType: "oci", identifier: "--privileged", transport: { type: "stdio" } }] });
    expect(() => generatePackage(oci, entry({ ociDigest: `sha256:${"b".repeat(64)}` }), paths)).toThrow(/недопустимый идентификатор/);
  });

  it("rejects a non-stdio package transport", () => {
    const s = server({
      packages: [{ registryType: "npm", identifier: "@acme/time", version: "1.2.3", transport: { type: "streamable-http" } }],
    });
    expect(() => generatePackage(s, entry(), paths)).toThrow(/stdio/);
  });

  it("passes declared environment variables into docker by name only", () => {
    const s = server({
      packages: [{
        registryType: "oci",
        identifier: "ghcr.io/acme/time",
        transport: { type: "stdio" },
        environmentVariables: [{ name: "API_KEY", isSecret: true, default: "hunter2" }],
      }],
    });
    const digest = `sha256:${"b".repeat(64)}`;
    const run = generatePackage(s, entry({ ociDigest: digest }), paths)["bin/run.sh"] ?? "";
    expect(run).toContain(`'docker' 'run' '--rm' '-i' '--network' 'none' '--read-only' '--tmpfs' '/tmp:rw,noexec,nosuid,size=64m' '--user' '65534:65534' '--cap-drop' 'ALL' '--security-opt' 'no-new-privileges' '-e' 'HOME=/tmp' '-e' 'API_KEY' 'ghcr.io/acme/time@${digest}'`);
    expect(run).not.toContain("hunter2");
    expect(run).not.toContain("API_KEY=");
  });

  it("rejects oci without digest", () => {
    const s = server({
      packages: [{ registryType: "oci", identifier: "ghcr.io/acme/time", transport: { type: "stdio" } }],
    });
    expect(() => generatePackage(s, entry(), paths)).toThrow(/ociDigest/);
  });

  it("rejects remote with secret header", () => {
    const s = server({
      remotes: [{ type: "streamable-http", url: "https://x.example/mcp", headers: [{ name: "Authorization", isSecret: true }] }],
    });
    expect(() => generatePackage(s, entry({ choice: { kind: "remote", index: 0 } }), paths)).toThrow(
      "удалённые адреса с секретными заголовками пока не поддерживаются",
    );
  });

  it("cannot be broken out of quoting by the env file path", () => {
    const run = generatePackage(npm, entry(), { envFile: "/e'v;x" })["bin/run.sh"] ?? "";
    expect(run).toContain(`'/e'\\''v;x'`);
  });

  describe("package and runtime arguments", () => {
    const withArgs = (extra: Record<string, unknown>, registryType: "npm" | "pypi" | "oci" = "npm") =>
      server({
        packages: [{ registryType, identifier: registryType === "oci" ? "ghcr.io/acme/time" : "@acme/time", version: "1.2.3", transport: { type: "stdio" }, ...extra }],
      });
    const oci = entry({ ociDigest: `sha256:${"c".repeat(64)}` });

    it.each([
      [{ packageArguments: [{ type: "positional", valueHint: "dir", isRequired: true }] }],
      [{ runtimeArguments: [{ type: "named", name: "--mount", isRequired: true }] }],
      [{ packageArguments: [{ type: "positional", value: "{dir}", isRequired: true, variables: { dir: { isRequired: true } } }] }],
    ])("refuses a required argument without a fixed value: %j", (extra) => {
      expect(() => generatePackage(withArgs(extra), entry(), paths)).toThrow("аргументы пакета пока не поддерживаются");
    });

    it("passes fixed values and required defaults, skips optional arguments without a value", () => {
      const s = withArgs({
        runtimeArguments: [{ type: "named", name: "--quiet", value: "true" }],
        packageArguments: [
          { type: "positional", value: "stdio" },
          { type: "named", name: "--tz", default: "UTC", isRequired: true },
          { type: "named", name: "--verbose", valueHint: "level" },
          { type: "positional", default: "x" },
        ],
      });
      expect(generatePackage(s, entry(), paths)["bin/run.sh"]).toContain(
        `'npx' '--quiet' 'true' '-y' '@acme/time@1.2.3' 'stdio' '--tz' 'UTC'\n`,
      );
    });

    it("puts allowed docker runtime arguments after the sandbox flags and before the image, package arguments after it", () => {
      const s = withArgs({ runtimeArguments: [{ type: "named", name: "-e", value: "FOO" }], packageArguments: [{ type: "positional", value: "serve" }] }, "oci");
      expect(generatePackage(s, oci, paths)["bin/run.sh"]).toContain(
        `exec python3 "$(dirname "$0")/shim.py" 'docker' 'run' '--rm' '-i' ${SANDBOX} '-e' 'FOO' 'ghcr.io/acme/time@sha256:${"c".repeat(64)}' 'serve'\n`,
      );
    });

    it("accepts --env NAME and --env=NAME as -e NAME", () => {
      const s = withArgs({ runtimeArguments: [{ type: "named", name: "--env", value: "A" }, { type: "positional", value: "--env=B" }] }, "oci");
      expect(generatePackage(s, oci, paths)["bin/run.sh"]).toContain(`${SANDBOX} '-e' 'A' '-e' 'B' 'ghcr.io/acme/time@`);
    });

    it.each([
      [[{ type: "named", name: "--network", value: "host" }], "--network"],
      [[{ type: "named", name: "-v", value: "/:/host" }], "-v"],
      [[{ type: "positional", value: "--privileged" }], "--privileged"],
      [[{ type: "positional", value: "--env=FOO=bar" }], "--env=FOO=bar"],
      [[{ type: "named", name: "--user", value: "0" }], "--user"],
      [[{ type: "named", name: "-e", value: "FOO=bar" }], "-e"],
      [[{ type: "positional", value: `--${"x".repeat(80)}` }], `--${"x".repeat(58)}`],
    ])("refuses docker runtime arguments %j", (runtimeArguments, shown) => {
      expect(() => generatePackage(withArgs({ runtimeArguments }, "oci"), oci, paths)).toThrow(
        `аргумент запуска «${shown}» не разрешён: ограничения Docker задаёт каталог`,
      );
    });

    it.each([
      [[{ type: "named", name: "-e", value: "DOCKER_HOST" }], "DOCKER_HOST"],
      [[{ type: "named", name: "--env", value: "HOME" }], "HOME"],
      [[{ type: "positional", value: "--env=DYLD_INSERT_LIBRARIES" }], "DYLD_INSERT_LIBRARIES"],
    ])("refuses runtime env pass-through of a forbidden name %j", (runtimeArguments, name) => {
      expect(() => generatePackage(withArgs({ runtimeArguments }, "oci"), oci, paths)).toThrow(
        `переменная «${name}» запрещена для образа OCI: она меняет запуск docker`,
      );
    });

    it("leaves npm and pypi runtime arguments alone", () => {
      const runtimeArguments = [{ type: "named", name: "--network", value: "host" }];
      expect(generatePackage(withArgs({ runtimeArguments }), entry(), paths)["bin/run.sh"]).toContain(`'npx' '--network' 'host' '-y'`);
    });
    it("refuses a named argument whose name is not a flag", () => {
      const s = withArgs({ packageArguments: [{ type: "named", name: "x; rm -rf /", value: "1" }] });
      expect(() => generatePackage(s, entry(), paths)).toThrow("недопустимое имя аргумента");
    });
  });
});
