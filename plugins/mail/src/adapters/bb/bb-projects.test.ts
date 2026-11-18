import { createFakeSdk } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { BbPortError } from "../../core/ports.ts";
import { PROJECT_CACHE_MS, SAVED_FILE_MODE, SAVE_TO_PROJECT_ENABLED, createProjectDirectory, isNotFound } from "./bb-projects.ts";

const TREE = { hostId: "host_1", path: "/work/api" };
const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

function project(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    name: `Project ${id}`,
    kind: "standard",
    gitRemoteUrl: "git@github.com:example-org/demo.git",
    sources: [{ id: `s_${id}`, projectId: id, hostId: "host_1", path: `/work/${id}`, isDefault: true, type: "local_path", createdAt: 1, updatedAt: 1 }],
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

const notFound = () => Object.assign(new Error("File not found"), { status: 404 });

function readAnswer(path: string, sha256 = SHA_A) {
  return { content: "aGk=", contentEncoding: "base64", path, sha256, sizeBytes: 2 };
}

describe("createProjectDirectory", () => {
  it("lists projects with their remote and working tree, cached for a minute", async () => {
    let now = 0;
    const { sdk, harness } = createFakeSdk({
      pluginId: "mail",
      overrides: {
        projects: {
          list: async () => [
            project("api"),
            project("two", {
              gitRemoteUrl: null,
              sources: [
                { id: "x", projectId: "two", hostId: "h", path: "/a", isDefault: false, type: "local_path", createdAt: 1, updatedAt: 1 },
                { id: "y", projectId: "two", hostId: "h", path: "/b", isDefault: false, type: "local_path", createdAt: 1, updatedAt: 1 },
              ],
            }),
          ],
        },
      },
    });
    const directory = createProjectDirectory(sdk, { now: () => now });
    expect(await directory.list()).toEqual([
      { id: "api", name: "Project api", kind: "standard", remote: { host: "github.com", path: "example-org/demo" }, tree: { hostId: "host_1", path: "/work/api" } },
      { id: "two", name: "Project two", kind: "standard", remote: null, tree: null },
    ]);
    now = PROJECT_CACHE_MS - 1;
    await directory.list();
    expect(harness.callsTo("projects.list")).toHaveLength(1);
    now = PROJECT_CACHE_MS;
    await directory.list();
    expect(harness.callsTo("projects.list")).toHaveLength(2);
  });

  it("passes limit as a string, drops .git entries and offers only folders Mail may save into", async () => {
    const { sdk, harness } = createFakeSdk({
      pluginId: "mail",
      overrides: {
        projects: {
          files: async () => ({
            files: [
              { name: "a.ts", path: "src/a.ts" },
              { name: "HEAD", path: ".git/HEAD" },
              { name: "config", path: "sub/.GIT/config" },
            ],
            truncated: true,
          }),
          paths: async () => ({
            paths: [
              { kind: "directory", name: "docs", path: "docs", positions: [], score: 1 },
              { kind: "directory", name: "workflows", path: ".github/workflows", positions: [], score: 1 },
              { kind: "directory", name: ".git", path: ".git", positions: [], score: 1 },
              { kind: "file", name: "x", path: "docs/x", positions: [], score: 1 },
            ],
            truncated: false,
          }),
        },
      },
    });
    const directory = createProjectDirectory(sdk);
    expect(await directory.files("api", "a", 20)).toEqual({ files: [{ name: "a.ts", path: "src/a.ts" }], truncated: true });
    expect(harness.callsTo("projects.files")[0]![0]).toMatchObject({ projectId: "api", query: "a", limit: "20" });
    expect(await directory.folders("api", "", 5)).toEqual({ folders: [{ name: "docs", path: "docs" }], truncated: false });
    expect(harness.callsTo("projects.paths")[0]![0]).toMatchObject({ limit: "5", includeDirectories: "true", includeFiles: "false" });
  });

  it("reads a project file's bytes and refuses .git paths before any call", async () => {
    const { sdk, harness } = createFakeSdk({
      pluginId: "mail",
      overrides: { projects: { fileContent: async () => ({ content: "aGk=", contentEncoding: "base64", mimeType: "text/plain", sizeBytes: 2 }) } },
    });
    const directory = createProjectDirectory(sdk);
    const file = await directory.fileContent("api", "src/a.txt");
    expect(new TextDecoder().decode(file.bytes)).toBe("hi");
    expect(file).toMatchObject({ mimeType: "text/plain", sizeBytes: 2 });
    await expect(directory.fileContent("api", ".git/config")).rejects.toBeInstanceOf(BbPortError);
    expect(harness.callsTo("projects.fileContent")).toHaveLength(1);
  });

  describe("create-only writes", () => {
    function writer(read: () => Promise<unknown>, write: () => Promise<unknown> = async () => ({ outcome: "written", sha256: SHA_B, sizeBytes: 2 })) {
      const { sdk, harness } = createFakeSdk({ pluginId: "mail", overrides: { files: { read, write } } });
      return { directory: createProjectDirectory(sdk), harness };
    }

    it("a file with any content is exists, and nothing is written", async () => {
      const { directory, harness } = writer(async () => readAnswer("/work/api/mail-attachments/a.pdf"));
      expect(await directory.write(TREE, "mail-attachments/a.pdf", new Uint8Array([1]), { replaceSha: null })).toEqual({
        outcome: "exists",
        currentSha: SHA_A,
      });
      expect(harness.callsTo("files.read")[0]![0]).toMatchObject({ hostId: "host_1", rootPath: "/work/api", path: "/work/api/mail-attachments/a.pdf" });
      expect(harness.callsTo("files.write")).toHaveLength(0);
    });

    it("a not-found read writes base64 with expectedSha256 null, createParents and mode 0644", async () => {
      const { directory, harness } = writer(async () => {
        throw notFound();
      });
      expect(await directory.write(TREE, "mail-attachments/a.pdf", new Uint8Array([104, 105]), { replaceSha: null })).toEqual({
        outcome: "written",
        sha256: SHA_B,
        sizeBytes: 2,
      });
      expect(harness.callsTo("files.write")[0]![0]).toEqual({
        hostId: "host_1",
        rootPath: "/work/api",
        path: "/work/api/mail-attachments/a.pdf",
        content: "aGk=",
        contentEncoding: "base64",
        createParents: true,
        mode: SAVED_FILE_MODE,
        expectedSha256: null,
      });
      expect(SAVED_FILE_MODE).toBe(0o644);
    });

    it("a write conflict is exists", async () => {
      const { directory } = writer(
        async () => {
          throw notFound();
        },
        async () => ({ outcome: "conflict", currentSha256: SHA_A }),
      );
      expect(await directory.write(TREE, "a.pdf", new Uint8Array([1]), { replaceSha: null })).toEqual({ outcome: "exists", currentSha: SHA_A });
    });

    it("another read error fails without writing", async () => {
      const { directory, harness } = writer(async () => {
        throw new Error("daemon offline");
      });
      await expect(directory.write(TREE, "a.pdf", new Uint8Array([1]), { replaceSha: null })).rejects.toMatchObject({ code: "failed" });
      expect(harness.callsTo("files.write")).toHaveLength(0);
    });

    it("Replace passes the shown sha, and a changed file is exists", async () => {
      const { directory, harness } = writer(async () => readAnswer("/work/api/a.pdf", SHA_A));
      expect(await directory.write(TREE, "a.pdf", new Uint8Array([1]), { replaceSha: SHA_A })).toMatchObject({ outcome: "written" });
      expect(harness.callsTo("files.write")[0]![0]).toMatchObject({ expectedSha256: SHA_A });
      expect(await directory.write(TREE, "a.pdf", new Uint8Array([1]), { replaceSha: "c".repeat(64) })).toEqual({ outcome: "exists", currentSha: SHA_A });
      expect(harness.callsTo("files.write")).toHaveLength(1);
    });

    it("refuses paths outside the tree or under .git before any call, and a reported link", async () => {
      const { directory, harness } = writer(async () => readAnswer("/elsewhere/a.pdf"));
      for (const path of ["../outside.txt", "/etc/passwd", "a/../../x", ".git/hooks/pre-commit", "a\\b", ""]) {
        await expect(directory.write(TREE, path, new Uint8Array([1]), { replaceSha: null }), path).rejects.toMatchObject({ code: "refused" });
      }
      expect(harness.callsTo("files.read")).toHaveLength(0);
      await expect(directory.write(TREE, "linked/a.pdf", new Uint8Array([1]), { replaceSha: null })).rejects.toMatchObject({ code: "refused" });
      expect(harness.callsTo("files.write")).toHaveLength(0);
    });

    it("exists answers the sha or null", async () => {
      expect(await writer(async () => readAnswer("/work/api/a.pdf")).directory.exists(TREE, "a.pdf")).toEqual({ sha256: SHA_A });
      expect(
        await writer(async () => {
          throw notFound();
        }).directory.exists(TREE, "a.pdf"),
      ).toBeNull();
    });
  });

  it("saving is on in this version", () => {
    expect(SAVE_TO_PROJECT_ENABLED).toBe(true);
  });

  it("recognises not-found answers defensively", () => {
    expect(isNotFound(Object.assign(new Error("x"), { status: 404 }))).toBe(true);
    expect(isNotFound(Object.assign(new Error("x"), { code: "ENOENT" }))).toBe(true);
    expect(isNotFound(new Error("Not found"))).toBe(true);
    expect(isNotFound(new Error("permission denied"))).toBe(false);
    expect(isNotFound(null)).toBe(false);
  });
});
