import { execFile } from "node:child_process";
import { z } from "zod";
import type { ThreadInfo, ThreadsPort } from "../../core/review";

const Show = z.object({
  thread: z.object({
    status: z.string(),
    error: z.unknown().optional(),
    lastError: z.unknown().optional(),
  }),
  environment: z
    .object({ path: z.string().nullable().optional(), branchName: z.string().nullable().optional() })
    .nullable()
    .optional(),
});

const Spawned = z.union([
  z.object({ id: z.string().min(1) }),
  z.object({ thread: z.object({ id: z.string().min(1) }) }),
]);

export function spawnArgs(projectId: string, title: string): string[] {
  return [
    "thread", "spawn",
    "--project", projectId,
    "--new-environment", "worktree",
    "--base-branch", "main",
    "--provider", "claude-code",
    "--model", "sonnet",
    // The reviewer runs shell steps with nobody at the keyboard; "auto", not "full" (ruling R8).
    "--permission-mode", "auto",
    "--title", title,
    "--prompt-file", "-",
    "--json",
  ];
}

export function parseThreadInfo(json: unknown): ThreadInfo {
  const show = Show.parse(json);
  const raw = show.thread.status;
  const hasError = [show.thread.error, show.thread.lastError].some((value) => value !== undefined && value !== null && value !== "");
  // Only a terminal error status or an error field fails a thread; unknown statuses keep waiting
  // (the 6-hour timeout in advanceReview bounds that).
  const status: ThreadInfo["status"] =
    hasError || raw === "error" || raw === "failed" ? "failed" : raw === "idle" ? "done" : "running";
  const env = show.environment;
  return {
    status,
    ...(env?.path ? { worktree: env.path } : {}),
    ...(env?.branchName ? { branch: env.branchName } : {}),
  };
}

/** Review threads driven through the `bb thread` CLI; the prompt goes over stdin, never argv. */
export class ReviewThreads implements ThreadsPort {
  constructor(
    private readonly marketplaceProjectId: string,
    private readonly bbPath: string = "bb",
    private readonly env?: NodeJS.ProcessEnv,
  ) {}

  private run(args: string[], stdin?: string): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const child = execFile(
        this.bbPath,
        args,
        { maxBuffer: 16 * 1024 * 1024, timeout: 120_000, ...(this.env === undefined ? {} : { env: this.env }) },
        (error, stdout, stderr) => {
          if (error !== null) {
            const text = String(stderr).trim();
            reject(new Error(text.length > 0 ? text : error.message));
            return;
          }
          try {
            resolve(JSON.parse(String(stdout)));
          } catch {
            reject(new Error("bb вернул не JSON"));
          }
        },
      );
      if (stdin !== undefined) child.stdin?.end(stdin);
    });
  }

  async spawnReview(prompt: string, title: string): Promise<{ threadId: string }> {
    const out = Spawned.parse(await this.run(spawnArgs(this.marketplaceProjectId, title), prompt));
    return { threadId: "id" in out ? out.id : out.thread.id };
  }

  async info(threadId: string): Promise<ThreadInfo> {
    return parseThreadInfo(await this.run(["thread", "show", threadId, "--json"]));
  }
}
