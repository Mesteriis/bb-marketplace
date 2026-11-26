import { readFileSync } from "node:fs";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ReviewThreads, parseThreadInfo, spawnArgs } from "./review-threads";

describe("review threads adapter", () => {
  it("builds the spawn argv with auto permissions and the prompt read from stdin", () => {
    const args = spawnArgs("proj_x", "mcp-catalog: проверка a 1");
    expect(args).toEqual([
      "thread", "spawn", "--project", "proj_x", "--new-environment", "worktree",
      "--base-branch", "main", "--provider", "claude-code", "--model", "sonnet",
      "--permission-mode", "auto",
      "--title", "mcp-catalog: проверка a 1", "--prompt-file", "-", "--json",
    ]);
  });
  it("maps a captured thread show output", () => {
    const json = JSON.parse(readFileSync(new URL("./fixtures/thread-show-worktree.json", import.meta.url), "utf8"));
    expect(parseThreadInfo(json)).toEqual({
      status: "done",
      worktree: "/Users/test/.bb/thread-storage/thr_review1/bb-main",
      branch: "bb/review-demo",
    });
  });
  it("fails only on an error status or an error field, unknown statuses keep running", () => {
    expect(parseThreadInfo({ thread: { status: "weird" }, environment: null }).status).toBe("running");
    expect(parseThreadInfo({ thread: { status: "idle", error: "boom" }, environment: null }).status).toBe("failed");
  });
  it("maps active to running and error to failed", () => {
    const mk = (status: string) => ({ thread: { status }, environment: null });
    expect(parseThreadInfo(mk("active")).status).toBe("running");
    expect(parseThreadInfo(mk("error")).status).toBe("failed");
  });
  it("passes only the tail of a long stderr and never an env value", async () => {
    const bb = join(await mkdtemp(join(tmpdir(), "review-threads-")), "bb");
    await writeFile(bb, `#!/bin/sh\ni=1; while [ $i -le 60 ]; do echo "noise $i $BB_TEST_TOKEN" >&2; i=$((i+1)); done; echo "real reason" >&2; exit 1\n`);
    await chmod(bb, 0o755);
    const threads = new ReviewThreads("proj", bb, { ...process.env, BB_TEST_TOKEN: "s3cr3t-value" });
    const error = await threads.info("thr").then(() => null, (e: Error) => e);
    expect((error?.message ?? "").split("\n")).toHaveLength(21);
    expect(error?.message.endsWith("real reason")).toBe(true);
    expect(error?.message).not.toContain("s3cr3t-value");
  });
});
