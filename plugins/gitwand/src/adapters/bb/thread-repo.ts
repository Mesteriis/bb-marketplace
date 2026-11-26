// The repository a thread's GitWand tab opens: the thread's own workspace,
// when it is a git repository on this machine.
import type { z } from "zod";
import type { repoSchema } from "../../core/contract.ts";

export interface ThreadSdk {
  threads: { get(input: { threadId: string }): Promise<{ environmentId: string | null }> };
  environments: { get(input: { environmentId: string }): Promise<{ status: string; path: string | null; isGitRepo: boolean }> };
}

export async function repoForThread(sdk: ThreadSdk, threadId: string, exists: (path: string) => boolean): Promise<z.infer<typeof repoSchema>> {
  const thread = await sdk.threads.get({ threadId });
  if (thread.environmentId === null) return { path: null, problem: "У треда ещё нет рабочего каталога." };
  const env = await sdk.environments.get({ environmentId: thread.environmentId });
  if (env.status === "destroyed" || env.path === null) return { path: null, problem: "Рабочий каталог треда удалён." };
  if (!env.isGitRepo) return { path: null, problem: "Рабочий каталог треда — не git-репозиторий." };
  if (!exists(env.path)) return { path: null, problem: "Рабочий каталог треда на другом компьютере, а GitWand открывает только локальные." };
  return { path: env.path, problem: null };
}
