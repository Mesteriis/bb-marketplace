// Structure of ci/bb-runtime.yml, the release workflow copied into the release
// repository. actionlint is not part of this check (not installed here).
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const root = new URL("../", import.meta.url);
const workflow = parse(readFileSync(new URL("ci/bb-runtime.yml", root), "utf8"));
type Step = { name?: string; uses?: string; run?: string; env?: Record<string, string>; with?: Record<string, string> };
const jobs = workflow.jobs as Record<string, { steps: Step[]; permissions?: Record<string, string>; environment?: string; strategy?: { "fail-fast"?: boolean; matrix: { include: { platform: string; runner: string }[] } } }>;
const steps = Object.values(jobs).flatMap((j) => j.steps);

describe("bb-runtime workflow", () => {
  it("builds every runtime platform the plugin knows", () => {
    expect(jobs.build.strategy!.matrix.include.map((m) => m.platform)).toEqual(["darwin-arm64", "darwin-x64", "linux-x64"]);
  });

  it("lets every platform finish when one fails", () => {
    expect(jobs.build.strategy!["fail-fast"]).toBe(false);
  });

  it("runs on runner images GitHub still offers (actionlint's list)", () => {
    expect(jobs.build.strategy!.matrix.include.map((m) => m.runner)).toEqual(["macos-15", "macos-15-intel", "ubuntu-22.04"]);
  });

  it("installs the plugin's dependencies before make-channel.ts, which imports zod", () => {
    const names = jobs.release.steps.map((s) => s.name);
    expect(names.indexOf("Plugin dependencies")).toBeGreaterThan(-1);
    expect(names.indexOf("Plugin dependencies")).toBeLessThan(names.indexOf("Write channel.json"));
  });

  it("pins every action to a full commit", () => {
    const uses = steps.filter((s) => s.uses).map((s) => s.uses!);
    expect(uses.length).toBeGreaterThan(0);
    expect(uses.filter((u) => !/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/.test(u))).toEqual([]);
  });

  it("passes inputs, secrets and variables to shell steps only through env", () => {
    expect(steps.filter((s) => s.run?.includes("${{")).map((s) => s.name)).toEqual([]);
  });

  it("reads the repository only, except the release job, which alone sees the signing key", () => {
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(jobs.release.permissions).toEqual({ contents: "write" });
    expect(jobs.release.environment).toBe("release");
    const withSecrets = Object.entries(jobs).filter(([, j]) => JSON.stringify(j).includes("secrets.")).map(([name]) => name);
    expect(withSecrets).toEqual(["release"]);
  });

  it("calls the plugin's own scripts, which exist", () => {
    const scripts = steps.flatMap((s) => [...(s.run ?? "").matchAll(/(?:plugins\/gitwand\/)?scripts\/([\w-]+\.ts)/g)].map((m) => m[1]));
    expect([...new Set(scripts)].sort()).toEqual(["build-runtime.ts", "make-channel.ts"]);
    for (const s of scripts) expect(existsSync(new URL(`scripts/${s}`, root)), s).toBe(true);
  });

  it("verifies the signature it made before publishing", () => {
    const sign = steps.find((s) => s.name === "Sign channel.json")!.run!;
    expect(sign.indexOf("minisign -V")).toBeGreaterThan(sign.indexOf("minisign -S"));
    expect(sign).toContain('rm -f "$key"');
  });
});
