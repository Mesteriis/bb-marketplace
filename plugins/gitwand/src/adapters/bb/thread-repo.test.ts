import { describe, expect, it } from "vitest";
import { repoForThread, type ThreadSdk } from "./thread-repo.ts";

function sdk(env: Record<string, unknown> | null, environmentId: string | null = "env_1"): ThreadSdk {
  return {
    threads: { get: async () => ({ environmentId }) },
    environments: { get: async () => env as never },
  };
}
const exists = (paths: string[]) => (p: string) => paths.includes(p);
const ENV = { status: "ready", path: "/work/repo", isGitRepo: true };

describe("repoForThread", () => {
  it("returns the path of the thread's local git workspace", async () => {
    expect(await repoForThread(sdk(ENV), "thr_1", exists(["/work/repo"]))).toEqual({ path: "/work/repo", problem: null });
  });

  it.each([
    ["no workspace yet", sdk(null, null), "У треда ещё нет рабочего каталога."],
    ["a destroyed workspace", sdk({ ...ENV, status: "destroyed" }), "Рабочий каталог треда удалён."],
    ["no path", sdk({ ...ENV, path: null }), "Рабочий каталог треда удалён."],
    ["not a git repository", sdk({ ...ENV, isGitRepo: false }), "Рабочий каталог треда — не git-репозиторий."],
    ["a workspace on another machine", sdk(ENV), "Рабочий каталог треда на другом компьютере, а GitWand открывает только локальные."],
  ])("explains %s", async (_name, threads, problem) => {
    expect(await repoForThread(threads, "thr_1", exists([]))).toEqual({ path: null, problem });
  });
});
