import { execFile } from "node:child_process";
import { describe, expect, it } from "vitest";
import { execCli } from "./exec-cli.ts";

const run = execCli(execFile as never);
const node = process.execPath;

describe("execCli", () => {
  it("returns the output of a successful run", async () => {
    expect(await run(node, ["-e", "process.stdout.write('out'); process.stderr.write('err')"], { env: process.env, timeoutMs: 10_000 })).toEqual({ code: 0, stdout: "out", stderr: "err", timedOut: false });
  });

  it("returns the exit code instead of throwing", async () => {
    expect(await run(node, ["-e", "process.stdout.write('partial'); process.exit(3)"], { env: process.env, timeoutMs: 10_000 })).toEqual({ code: 3, stdout: "partial", stderr: "", timedOut: false });
  });

  it("passes the given environment only", async () => {
    const r = await run(node, ["-e", "process.stdout.write(String(process.env.GW_PROBE) + ',' + String(process.env.HOME))"], { env: { GW_PROBE: "yes" }, timeoutMs: 10_000 });
    expect(r.stdout).toBe("yes,undefined");
  });

  it("stops a run that takes too long", async () => {
    const r = await run(node, ["-e", "setTimeout(() => {}, 10000)"], { env: process.env, timeoutMs: 200 });
    expect(r.timedOut).toBe(true);
    expect(r.code).not.toBe(0);
  });

  it("reports a missing program as a failed run", async () => {
    expect(await run("/nonexistent/gw-cli", [], { env: process.env, timeoutMs: 1000 })).toEqual({ code: 127, stdout: "", stderr: "", timedOut: false });
  });
});
