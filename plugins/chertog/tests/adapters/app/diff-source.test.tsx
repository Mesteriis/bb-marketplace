import { expect, it, vi } from "vitest";
import { isValidElement } from "react";
import { WorkspaceFileCatalog } from "../../../src/adapters/bb/app/file-preview-source.tsx";
import { createDiffSource } from "../../../src/adapters/bb/app/diff-source.tsx";

const fromSha = "1".repeat(40);
const toSha = "2".repeat(40);
const ref = { provider: "bb-diff", params: { environmentId: "e", path: "a%20b.md", fromSha, toSha } };
function setup() {
  const env = { id: "e", name: null, status: "ready", hostId: "h", path: "/repo/" };
  const environments = { list: async () => [env], get: async () => env,
    paths: async () => ({ paths: [{ kind: "file", path: "a b.md" }] }) };
  const catalog = new WorkspaceFileCatalog(environments);
  const read = vi.fn(async ({ ref }: { ref?: string }) => ({ content: ref === fromSha ? "a\n" : "b\n", contentEncoding: "utf8" }));
  const source = createDiffSource(catalog, { read }, async () => [fromSha, toSha]);
  return { source, read, catalog };
}

it("offers a file only for a selected pair of catalog revisions", async () => {
  const { source, catalog } = setup();
  await catalog.select("e");
  await source.loadRevisions();
  source.selectRevisions(fromSha, "3".repeat(40));
  expect(source.section().items).toEqual([]);
  source.selectRevisions(fromSha, toSha);
  expect(source.refOf(source.section().items[0].id)).toEqual(ref);
});

it("loads both immutable versions once and releases their patch", async () => {
  const { source, read } = setup();
  expect(await source.provider.open({ instanceId: "i", ref })).toEqual({ status: "live", addressee: null });
  expect(read.mock.calls.map(([args]) => args)).toEqual([
    { hostId: "h", rootPath: "/repo/", path: "/repo/a b.md", ref: fromSha, signal: expect.any(AbortSignal) },
    { hostId: "h", rootPath: "/repo/", path: "/repo/a b.md", ref: toSha, signal: expect.any(AbortSignal) },
  ]);
  const panel = source.render(ref, "i");
  expect(isValidElement(panel) && panel.props).toMatchObject({ path: "a b.md", patch: "@@ -1,1 +1,1 @@\n-a\n+b\n" });
  source.render(ref, "i");
  expect(read).toHaveBeenCalledTimes(2);
  await source.provider.release("i");
  expect(source.render(ref, "i")).toBeNull();
});

it("keeps the reference on read failure and rejects malformed references before SDK reads", async () => {
  const { source, read } = setup();
  for (const params of [{ ...ref.params, path: "%2e%2e/b" }, { ...ref.params, fromSha: "main" }, { ...ref.params, extra: true }]) {
    expect(await source.provider.open({ instanceId: "i", ref: { ...ref, params } })).toEqual({ status: "access-denied" });
  }
  expect(read).not.toHaveBeenCalled();
  read.mockRejectedValueOnce(Error("missing revision"));
  expect(await source.provider.open({ instanceId: "i", ref })).toEqual({ status: "lost" });
  expect(source.stateText("lost", ref)?.description).toContain("Ссылка сохранена");
});

it("invalidates old picker IDs when the revision selection changes", async () => {
  const { source, catalog } = setup();
  await catalog.select("e");
  await source.loadRevisions();
  source.selectRevisions(fromSha, toSha);
  const old = source.section().items[0].id;
  source.selectRevisions(toSha, fromSha);
  expect(source.refOf(old)).toBeNull();
});

it("release during reads cannot publish a live panel", async () => {
  const { source, read } = setup();
  let resolve!: (file: { content: string; contentEncoding: string }) => void;
  read.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  const pending = source.provider.open({ instanceId: "i", ref });
  await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2));
  await source.provider.release("i");
  resolve({ content: "", contentEncoding: "utf8" });
  expect(await pending).toEqual({ status: "lost" });
  expect(source.render(ref, "i")).toBeNull();
});

it("explains binary file rejection and renders identical revisions explicitly", async () => {
  const { source, read } = setup();
  read.mockResolvedValueOnce({ content: "AA==", contentEncoding: "base64" });
  expect(await source.provider.open({ instanceId: "i", ref })).toEqual({ status: "lost" });
  expect(source.stateText("lost", ref)?.description).toContain("текстовые версии");
  read.mockResolvedValue({ content: "same", contentEncoding: "utf8" });
  expect(await source.provider.open({ instanceId: "i", ref })).toEqual({ status: "live", addressee: null });
  const panel = source.render(ref, "i");
  expect(isValidElement(panel) && panel.props).toMatchObject({ children: "В этих ревизиях файл одинаков." });
});
