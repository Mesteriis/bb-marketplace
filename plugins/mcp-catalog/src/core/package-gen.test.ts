import { describe, expect, it } from "vitest";
import { CollectionEntry, serverSlug } from "./collection";
import { generatePackage } from "./package-gen";
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

describe("generatePackage", () => {
  it("generates npm launcher pinned to version", () => {
    const files = generatePackage(npm, entry(), paths);
    expect(Object.keys(files).sort()).toEqual(["bin/run.sh", "bin/shim.py", "mcp.json", "plugin.json"]);
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
    expect(run).toContain(`'docker' 'run' '--rm' '-i' 'ghcr.io/acme/time@${digest}'`);
  });

  it("remote without secret headers has no launcher", () => {
    const s = server({ remotes: [{ type: "streamable-http", url: "https://x.example/mcp", headers: [{ name: "X-Id" }] }] });
    const files = generatePackage(s, entry({ choice: { kind: "remote", index: 0 } }), paths);
    expect(Object.keys(files).sort()).toEqual(["mcp.json", "plugin.json"]);
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
    expect(run).toContain(`'docker' 'run' '--rm' '-i' '-e' 'API_KEY' 'ghcr.io/acme/time@${digest}'`);
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

    it("puts docker runtime arguments before the image and package arguments after it", () => {
      const s = withArgs({ runtimeArguments: [{ type: "named", name: "--network", value: "none" }], packageArguments: [{ type: "positional", value: "serve" }] }, "oci");
      expect(generatePackage(s, oci, paths)["bin/run.sh"]).toContain(
        `'docker' 'run' '--rm' '-i' '--network' 'none' 'ghcr.io/acme/time@sha256:${"c".repeat(64)}' 'serve'\n`,
      );
    });

    it("refuses a named argument whose name is not a flag", () => {
      const s = withArgs({ packageArguments: [{ type: "named", name: "x; rm -rf /", value: "1" }] });
      expect(() => generatePackage(s, entry(), paths)).toThrow("недопустимое имя аргумента");
    });
  });
});
