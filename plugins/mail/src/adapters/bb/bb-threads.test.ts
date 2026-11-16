import { createFakeSdk, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { createBbThreads, projectDefaultEnvironment, worktreeEnvironment } from "./bb-threads.ts";

function listed(id: string, overrides: Record<string, unknown> = {}) {
  return { id, title: `Title ${id}`, titleFallback: null, projectId: "p_api", archivedAt: null, updatedAt: Date.UTC(2026, 10, 16), ...overrides };
}

describe("createBbThreads", () => {
  it("spawns with a text item carrying mentions, the extra input, metadata and the permission mode", async () => {
    const { sdk, harness } = createFakeSdk({
      pluginId: "mail",
      overrides: { threads: { spawn: async () => makeThreadResponse({ id: "bb_1" }) } },
    });
    const threads = createBbThreads(sdk);
    const upload = { type: "localFile" as const, path: "/att/x.patch", name: "x.patch", mimeType: "text/x-patch" };
    const result = await threads.spawn({
      projectId: "p_api",
      environment: worktreeEnvironment({ hostId: "host_1", path: "/work/api" }),
      title: "Apply patch",
      prompt: "Apply the attached patch.",
      extraInput: [upload],
      pluginMetadata: { mail: { v: 1, accountId: "a", messageId: "m", threadId: "t", kind: "patch", origin: "owner" } },
      permissionMode: "accept-edits",
    });
    expect(result).toEqual({ threadId: "bb_1" });
    const args = harness.callsTo("threads.spawn")[0]![0] as Record<string, unknown>;
    expect(args).toMatchObject({
      projectId: "p_api",
      environment: { type: "host", hostId: "host_1", workspace: { type: "managed-worktree", baseBranch: { kind: "default" } } },
      title: "Apply patch",
      input: [{ type: "text", text: "Apply the attached patch.", mentions: [] }, upload],
      permissionMode: "accept-edits",
    });
    expect(JSON.stringify(args)).toContain('"kind":"patch"');

    await threads.spawn({ projectId: "p", environment: projectDefaultEnvironment(), title: "T", prompt: "P", pluginMetadata: {} });
    const plain = harness.callsTo("threads.spawn")[1]![0] as Record<string, unknown>;
    expect(plain.environment).toEqual({ type: "project-default" });
    expect(plain).not.toHaveProperty("permissionMode");
    expect(plain.input).toEqual([{ type: "text", text: "P", mentions: [] }]);
  });

  it("sends with mode queue-if-active and reads the output", async () => {
    const { sdk, harness } = createFakeSdk({
      pluginId: "mail",
      overrides: { threads: { send: async () => ({}), output: async () => ({ output: "Done." }) } },
    });
    const threads = createBbThreads(sdk);
    await threads.send("bb_1", "The alert resolved.");
    expect(harness.callsTo("threads.send")[0]![0]).toEqual({
      threadId: "bb_1",
      input: [{ type: "text", text: "The alert resolved.", mentions: [] }],
      mode: "queue-if-active",
    });
    expect(await threads.output("bb_1")).toBe("Done.");
  });

  it("lists threads by id, live and archived, and by project", async () => {
    const { sdk, harness } = createFakeSdk({
      pluginId: "mail",
      overrides: {
        threads: {
          list: async (args?: { archived?: boolean; projectId?: string }) =>
            args?.archived === true
              ? [listed("bb_2", { archivedAt: 5, title: null, titleFallback: "Fallback" })]
              : args?.projectId !== undefined
                ? [listed("bb_9")]
                : [listed("bb_1")],
        },
      },
    });
    const threads = createBbThreads(sdk);
    expect(await threads.list({ threadIds: ["bb_1", "bb_2", "bb_gone"] })).toEqual([
      { id: "bb_1", title: "Title bb_1", projectId: "p_api", archived: false, updatedAt: "2026-11-16T00:00:00.000Z" },
      { id: "bb_2", title: "Fallback", projectId: "p_api", archived: true, updatedAt: "2026-11-16T00:00:00.000Z" },
    ]);
    expect(await threads.list({ threadIds: [] })).toEqual([]);
    expect((await threads.list({ projectId: "p_api", limit: 30 })).map((t) => t.id)).toEqual(["bb_9"]);
    expect(harness.callsTo("threads.list").at(-1)![0]).toMatchObject({ projectId: "p_api", limit: 30 });
  });

  it("lists storage files with a string limit and reads only inside the storage root", async () => {
    const { sdk, harness } = createFakeSdk({
      pluginId: "mail",
      overrides: {
        threads: {
          storageFiles: async () => ({ files: [{ name: "out.md", path: "out.md" }, { name: "HEAD", path: ".git/HEAD" }], storageRootPath: "/store/bb_1", truncated: false }),
          storageLocation: async () => ({ hostId: "host_1", storageRootPath: "/store/bb_1" }),
        },
        files: {
          read: async (args: { path: string }) => ({ content: "aGk=", contentEncoding: "base64", mimeType: "text/markdown", path: args.path, sha256: "a".repeat(64), sizeBytes: 2 }),
        },
      },
    });
    const threads = createBbThreads(sdk);
    expect(await threads.storageFiles("bb_1", "out", 10)).toEqual({ files: [{ name: "out.md", path: "out.md" }], truncated: false });
    expect(harness.callsTo("threads.storageFiles")[0]![0]).toMatchObject({ threadId: "bb_1", query: "out", limit: "10" });
    const file = await threads.readStorageFile("bb_1", "out.md");
    expect(new TextDecoder().decode(file.bytes)).toBe("hi");
    expect(harness.callsTo("files.read")[0]![0]).toMatchObject({ hostId: "host_1", rootPath: "/store/bb_1", path: "/store/bb_1/out.md" });
    for (const path of ["../other/secret.txt", "/etc/hosts", "/store/bb_10/x", ".git/config"]) {
      await expect(threads.readStorageFile("bb_1", path), path).rejects.toMatchObject({ code: "refused" });
    }
    expect(harness.callsTo("files.read")).toHaveLength(1);
  });

  it("uploads an attachment as a localFile item", async () => {
    const { sdk, harness } = createFakeSdk({
      pluginId: "mail",
      overrides: {
        projects: {
          attachments: { upload: async () => ({ type: "localFile", path: "/att/2026-11-16-fix.patch", name: "2026-11-16-fix.patch", sizeBytes: 3 }) },
        },
      },
    });
    const item = await createBbThreads(sdk).uploadAttachment("p_api", new Uint8Array([1, 2, 3]), "2026-11-16-fix.patch", "text/x-patch");
    expect(item).toEqual({ type: "localFile", path: "/att/2026-11-16-fix.patch", name: "2026-11-16-fix.patch", mimeType: "text/x-patch" });
    expect(harness.callsTo("projects.attachments.upload")[0]![0]).toMatchObject({
      projectId: "p_api",
      filename: "2026-11-16-fix.patch",
      mimeType: "text/x-patch",
    });
  });

  it("reads the project's default permission mode, null when none is set", async () => {
    let defaults: unknown = null;
    const { sdk } = createFakeSdk({ pluginId: "mail", overrides: { projects: { defaultExecutionOptions: async () => defaults } } });
    const threads = createBbThreads(sdk);
    expect(await threads.defaultPermissionMode("p_api")).toBeNull();
    defaults = { model: "m", permissionMode: "full", providerId: "x", reasoningLevel: "r", serviceTier: "s" };
    expect(await threads.defaultPermissionMode("p_api")).toBe("full");
  });
});
