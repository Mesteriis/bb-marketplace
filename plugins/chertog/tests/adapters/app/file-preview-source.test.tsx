import { expect, it, vi } from "vitest";
import { isValidElement } from "react";
import { createFilePreviewSource, WorkspaceFileCatalog } from "../../../src/adapters/bb/app/file-preview-source.tsx";

it("offers only listed files in the selected environment and decodes a saved target exactly once", async () => {
  const env = { id: "e", name: "Test", hostId: "h", path: "/work", status: "ready" };
  const sdk = { environments: {
    list: async () => [env], get: async () => env,
    paths: vi.fn(async () => ({ paths: [{ kind: "file", path: "a b.md" }, { kind: "file", path: "../escape" }] })),
  } };
  const catalog = new WorkspaceFileCatalog(sdk.environments);
  await catalog.select("elsewhere");
  expect(sdk.environments.paths).not.toHaveBeenCalled();
  await catalog.select("e");
  const source = createFilePreviewSource(catalog);
  expect(source.section().items).toHaveLength(1);
  const ref = source.refOf(source.section().items[0].id)!;
  expect(ref).toEqual({ provider: "bb-file-preview", params: { kind: "workspace", environmentId: "e", path: "a%20b.md" } });
  expect(source.refOf("other")).toBeNull();
  expect(source.provider.paramsSchema.safeParse({ ...ref.params, credential: "no" }).success).toBe(false);
  expect(source.provider.paramsSchema.safeParse({ ...ref.params, path: "%2E%2E/b" }).success).toBe(false);
  expect(await source.provider.open({ instanceId: "i", ref })).toEqual({ status: "live", addressee: null });
  const panel = source.render(ref, "i");
  expect(isValidElement(panel) && panel.props).toMatchObject({ target: { kind: "workspace", environmentId: "e", path: "a b.md" }, renderPreview: expect.any(Function) });
});

it("keeps a missing saved file unavailable and distinguishes directory errors", async () => {
  const env = { id: "e", name: null, hostId: "h", path: "/work", status: "ready" };
  const paths = vi.fn(async () => ({ paths: [] }));
  const catalog = new WorkspaceFileCatalog({ list: async () => [env], get: async () => env, paths });
  const source = createFilePreviewSource(catalog);
  const ref = { provider: "bb-file-preview", params: { kind: "workspace", environmentId: "e", path: "gone.txt" } };
  const request = { instanceId: "i", ref };
  expect(await source.provider.open(request)).toEqual({ status: "lost" });
  expect(source.stateText("lost", ref)?.description).toContain("Ссылка сохранена");
  paths.mockRejectedValueOnce(Error("forbidden"));
  expect(await source.provider.open(request)).toEqual({ status: "access-denied" });
});

it("cannot expose files from an earlier slow picker search", async () => {
  const env = { id: "e", name: null, hostId: "h", path: "/work", status: "ready" };
  const paths = vi.fn(async () => ({ paths: [{ kind: "file", path: "new.md" }] }));
  let finish!: (v: { paths: { kind: string; path: string }[] }) => void;
  paths.mockImplementationOnce(() => new Promise(done => { finish = done; }));
  const catalog = new WorkspaceFileCatalog({ list: async () => [env], get: async () => env, paths });
  const slow = catalog.select("e", "old");
  await vi.waitFor(() => expect(paths).toHaveBeenCalledTimes(1));
  await catalog.select("e", "new");
  finish({ paths: [{ kind: "file", path: "old.md" }] });
  await slow;
  expect(catalog.snapshot.items.map(file => file.title)).toEqual(["new.md"]);
});

it("releasing a pending preview cancels its lookup and prevents a late live result", async () => {
  const env = { id: "e", name: null, hostId: "h", path: "/work", status: "ready" };
  let finish!: (v: { paths: { kind: string; path: string }[] }) => void;
  const paths = vi.fn((_input: { signal?: AbortSignal }) => new Promise<{ paths: { kind: string; path: string }[] }>(done => { finish = done; }));
  const catalog = new WorkspaceFileCatalog({ list: async () => [env], get: async () => env, paths });
  const source = createFilePreviewSource(catalog);
  const ref = { provider: "bb-file-preview", params: { kind: "workspace", environmentId: "e", path: "a.md" } };
  const pending = source.provider.open({ instanceId: "i", ref });
  await source.provider.release("i");
  finish({ paths: [{ kind: "file", path: "a.md" }] });
  expect(await pending).toEqual({ status: "lost" });
  expect(paths.mock.calls[0][0].signal?.aborted).toBe(true);
});
