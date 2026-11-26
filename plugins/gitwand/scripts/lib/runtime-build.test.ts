import { describe, expect, it } from "vitest";
import { archiveName, jsLicenseLines, manifestText, shippedCrates, parseBuildArgs, runtimeVersion, scanPluginCommands, unknownPluginCommands } from "./runtime-build.ts";

const SHA = "436b9684f096e8edd35b6a36e3b4d3af0fd7e084";

describe("runtimeVersion", () => {
  it("joins the GitWand version and the plugin's build number", () => {
    expect(runtimeVersion("v3.14.0", 1)).toBe("3.14.0+bb1");
    expect(runtimeVersion("v3.14.0", 12)).toBe("3.14.0+bb12");
  });

  it.each(["3.14.0", "v3.14", "v3.14.0-beta.1", "main"])("refuses the tag %s", (tag) => {
    expect(() => runtimeVersion(tag, 1)).toThrow(/release tag/);
  });

  it.each([0, -1, 1.5])("refuses build number %s", (n) => {
    expect(() => runtimeVersion("v3.14.0", n)).toThrow(/build number/);
  });
});

describe("archiveName", () => {
  it("names the archive by version and platform", () => {
    expect(archiveName("3.14.0+bb1", "darwin-arm64")).toBe("gitwand-runtime-3.14.0+bb1-darwin-arm64.tar.gz");
  });
});

describe("parseBuildArgs", () => {
  it("reads tag, commit, platform and defaults", () => {
    expect(parseBuildArgs(["--tag", "v3.14.0", "--commit", SHA, "--platform", "darwin-arm64"])).toEqual({
      tag: "v3.14.0",
      commit: SHA,
      platform: "darwin-arm64",
      build: 1,
      out: null,
      cargoHome: null,
    });
  });

  it("reads build number, output and cargo home", () => {
    expect(
      parseBuildArgs(["--tag", "v3.14.0", "--commit", SHA, "--platform", "linux-x64", "--build", "3", "--out", "/tmp/o", "--cargo-home", "/tmp/c"]),
    ).toMatchObject({ platform: "linux-x64", build: 3, out: "/tmp/o", cargoHome: "/tmp/c" });
  });

  it.each([
    [["--commit", SHA, "--platform", "darwin-arm64"], /--tag/],
    [["--tag", "v3.14.0", "--platform", "darwin-arm64"], /--commit/],
    [["--tag", "v3.14.0", "--commit", "436b968", "--platform", "darwin-arm64"], /40 hex/],
    [["--tag", "v3.14.0", "--commit", SHA, "--platform", "windows-x64"], /platform/],
    [["--tag", "v3.14.0", "--commit", SHA, "--platform", "darwin-arm64", "--bogus", "1"], /unknown option --bogus/],
  ])("refuses %j", (argv, message) => {
    expect(() => parseBuildArgs(argv as string[])).toThrow(message);
  });
});

describe("scanPluginCommands", () => {
  it("lists the distinct Tauri plugin commands a bundle names, sorted", () => {
    const js = 'a("plugin:menu|new",x);b("plugin:dialog|open");c("plugin:menu|new");d(`plugin:event|listen`);e("plugin:menu|set_as_app_menu")';
    expect(scanPluginCommands(js)).toEqual(["dialog|open", "event|listen", "menu|new", "menu|set_as_app_menu"]);
  });
});

describe("unknownPluginCommands", () => {
  it("returns what the shim does not know yet", () => {
    expect(unknownPluginCommands(["dialog|open", "fs|read_file", "menu|new"], ["menu|new", "dialog|open"])).toEqual(["fs|read_file"]);
  });
});

describe("manifestText", () => {
  it("writes sha256sum lines sorted by path", () => {
    expect(
      manifestText([
        { path: "ui/index.html", sha256: "bb".repeat(32) },
        { path: "bin/gitwand-bridge", sha256: "aa".repeat(32) },
      ]),
    ).toBe(`${"aa".repeat(32)}  bin/gitwand-bridge\n${"bb".repeat(32)}  ui/index.html\n`);
  });
});

describe("shippedCrates", () => {
  const pkg = (name: string, license: string | null = "MIT") => ({ id: `${name} 1.0.0`, name, version: "1.0.0", license, repository: null });
  const dep = (name: string, kinds: (string | null)[] = [null]) => ({ pkg: `${name} 1.0.0`, dep_kinds: kinds.map((kind) => ({ kind })) });
  const metadata = {
    packages: [pkg("gitwand-desktop"), pkg("serde"), pkg("serde_derive"), pkg("cc"), pkg("tempfile"), pkg("libc", null), pkg("winapi"), pkg("both")],
    resolve: {
      root: "gitwand-desktop 1.0.0",
      nodes: [
        { id: "gitwand-desktop 1.0.0", deps: [dep("serde"), dep("cc", ["build"]), dep("tempfile", ["dev"]), dep("both", ["build", null])] },
        { id: "serde 1.0.0", deps: [dep("serde_derive"), dep("libc")] },
        { id: "serde_derive 1.0.0", deps: [] },
        { id: "libc 1.0.0", deps: [] },
        { id: "cc 1.0.0", deps: [] },
        { id: "tempfile 1.0.0", deps: [] },
        { id: "winapi 1.0.0", deps: [] },
        { id: "both 1.0.0", deps: [] },
      ],
    },
  };

  it("lists the normal dependencies reachable from the root, without the root, build-only and dev crates", () => {
    expect(shippedCrates(metadata)).toEqual(["both 1.0.0 MIT", "libc 1.0.0 UNKNOWN", "serde 1.0.0 MIT", "serde_derive 1.0.0 MIT"]);
  });
});

describe("jsLicenseLines", () => {
  it("lists name, version and license, sorted, without the build machine's paths", () => {
    const json = JSON.stringify({
      MIT: [{ name: "vue", versions: ["3.5.42"], paths: ["/private/tmp/x/node_modules/vue"] }],
      "Apache-2.0": [{ name: "@tauri-apps/api", versions: ["2.12.4", "2.12.3"], paths: ["/tmp/y"] }],
    });
    expect(jsLicenseLines(json)).toEqual(["@tauri-apps/api 2.12.3 Apache-2.0", "@tauri-apps/api 2.12.4 Apache-2.0", "vue 3.5.42 MIT"]);
  });
});
