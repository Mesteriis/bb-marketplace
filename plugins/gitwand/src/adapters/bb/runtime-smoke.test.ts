import { describe, expect, it } from "vitest";
import type { SpawnBridge } from "./bridge-process.ts";
import { smokeRuntime } from "./runtime-smoke.ts";
import { FakeChild } from "./testing/fake-child.ts";

const RT = { dir: "/rt", version: "3.14.0+bb2", commit: "c".repeat(40), bin: "/rt/bin/gitwand-bridge", uiDir: "/rt/ui" };

function bridge(answer: (cmd: string, args: Record<string, unknown>) => unknown, children: FakeChild[] = []): SpawnBridge {
  return () => {
    const child = new FakeChild();
    child.onRequest = (req) => child.reply({ id: req.id, ...(answer(req.cmd, req.args) as object) });
    child.on("stdin-closed", () => child.exit(0));
    children.push(child);
    return child as never;
  };
}

const hello = (runtime: string) => ({ ok: { protocol: 1, version: "3.14.0", runtime, commit: "c".repeat(40), generated: 336, adapted: [] } });

describe("smokeRuntime", () => {
  it("starts the candidate, checks its version and reads a temporary repository's status", async () => {
    const children: FakeChild[] = [];
    let statusCwd = "";
    const spawn = bridge((cmd, args) => {
      if (cmd === "__hello") return hello("3.14.0+bb2");
      statusCwd = String(args.cwd);
      return { ok: { branch: "main", unstaged: [{ path: "smoke.txt", status: "modified" }] } };
    }, children);
    await smokeRuntime(RT, { spawn, env: { HOME: "/h" } });
    expect(children[0].requests.map((r) => r.cmd)).toEqual(["__hello", "git_status"]);
    expect(statusCwd).toMatch(/gitwand-smoke-/);
    expect(children[0].stdinClosed).toBe(true);
  });

  it("refuses a candidate that reports another version", async () => {
    await expect(smokeRuntime(RT, { spawn: bridge(() => hello("3.14.0+bb1")), env: { HOME: "/h" } })).rejects.toThrow("candidate answered 3.14.0+bb1, expected 3.14.0+bb2");
  });

  it("refuses a candidate whose git_status fails or misses the change", async () => {
    const spawn = bridge((cmd) => (cmd === "__hello" ? hello("3.14.0+bb2") : { ok: { branch: "main", unstaged: [] } }));
    await expect(smokeRuntime(RT, { spawn, env: { HOME: "/h" } })).rejects.toThrow("git_status did not report smoke.txt");
  });
});
