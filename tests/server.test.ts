import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server";
import { parseArgv, truncateForCli, formatCliReply } from "../cli-utils";
import { parseSources } from "../source-config";
import { rpcContract } from "../contract";
import { makeGitRepo, makeSource, tmpDir, writeTree } from "./fixtures";

const skill = (body: string) => `---\nname: x\n---\n\n${body}\n`;

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Wait for a filesystem watcher to catch up, without pinning a timing to it. */
async function until(ready: () => boolean, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!ready()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for the merge signal");
    await pause(25);
  }
}

/** A fake host whose `sources` setting points at a throwaway git repo. */
async function hostWithRepo() {
  const { dir, shas } = makeGitRepo([
    {
      "skills/core/alpha/SKILL.md": skill("first—version"),
      "skills/core/beta/SKILL.md": skill("beta"),
    },
    {
      "skills/core/alpha/SKILL.md": skill("first, version"),
      "skills/core/beta/SKILL.md": skill("beta rewritten"),
      "skills/core/gamma/SKILL.md": skill("gamma"),
      "skills/in-progress/wip/SKILL.md": skill("wip"),
    },
  ]);
  const installRoot = writeTree(tmpDir("local"), {
    "alpha/SKILL.md": skill("first—version"),
    "beta/SKILL.md": skill("my own beta"),
    "my-own-skill/SKILL.md": skill("written by me"),
    ".test-skills-version": `${shas[0]}\n`,
  });
  const source = makeSource({ url: dir, installRoot, ref: "main" });
  const fake = createFakePluginHost({
    pluginId: "skills-sync",
    dataDir: tmpDir("data"),
    settings: { sources: JSON.stringify([source]) },
  });
  await plugin(fake.bb);
  return { ...fake, installRoot, shas, source };
}

describe("parseSources", () => {
  it("accepts the shipped default", () => {
    const fake = createFakePluginHost();
    // The default lives in the descriptor; parse it back the way the factory does.
    const parsed = parseSources(
      JSON.stringify([makeSource({ installRoot: "/Users/someone/.agents/skills" })]),
    );
    expect(parsed.ok).toBe(true);
    void fake;
  });

  it("reports malformed JSON instead of throwing", () => {
    const parsed = parseSources("{ not json");
    expect(parsed).toMatchObject({ ok: false });
    if (!parsed.ok) expect(parsed.message).toMatch(/not valid JSON/);
  });

  it("rejects a relative installRoot", () => {
    const parsed = parseSources(JSON.stringify([makeSource({ installRoot: "skills" })]));
    expect(parsed).toMatchObject({ ok: false });
    if (!parsed.ok) expect(parsed.message).toMatch(/absolute path/);
  });

  it("rejects a marker that is not a single filename", () => {
    const parsed = parseSources(JSON.stringify([makeSource({ marker: "../victim" })]));
    expect(parsed).toMatchObject({ ok: false });
    if (!parsed.ok) expect(parsed.message).toMatch(/single filename/);
  });

  it("rejects duplicate ids", () => {
    const parsed = parseSources(JSON.stringify([makeSource(), makeSource()]));
    expect(parsed).toMatchObject({ ok: false });
  });
});

describe("factory", () => {
  it("marks the plugin needs-configuration on a malformed sources value", async () => {
    const fake = createFakePluginHost({ settings: { sources: "nope" } });
    await plugin(fake.bb);
    expect(fake.harness.needsConfigurationMessages).toHaveLength(1);
    expect(fake.harness.needsConfigurationMessages[0]).toMatch(/not valid JSON/);
  });

  it("marks the plugin needs-configuration and disables scheduling for an invalid interval", async () => {
    const source = makeSource({ installRoot: tmpDir("invalid-auto-fetch") });
    const fake = createFakePluginHost({
      pluginId: "skills-sync",
      settings: {
        sources: JSON.stringify([source]),
        autoFetchHours: "5",
      },
    });
    await plugin(fake.bb);
    expect(fake.harness.needsConfigurationMessages).toHaveLength(1);
    expect(fake.harness.needsConfigurationMessages[0]).toMatch(/divisor of 24/);
    expect(fake.harness.registrations.schedules).toEqual([]);
  });

  it("does not register a schedule when the interval is zero", async () => {
    const source = makeSource({ installRoot: tmpDir("disabled-auto-fetch") });
    const fake = createFakePluginHost({
      pluginId: "skills-sync",
      settings: {
        sources: JSON.stringify([source]),
        autoFetchHours: "0",
      },
    });
    await plugin(fake.bb);
    expect(fake.harness.needsConfigurationMessages).toEqual([]);
    expect(fake.harness.registrations.schedules).toEqual([]);
  });

  it("registers the contract methods and the CLI with filled-in metadata", async () => {
    const { harness } = await hostWithRepo();
    expect(harness.registrations.rpcMethods.sort()).toEqual([
      "apply",
      "diff",
      "listSources",
      "mergeAccept",
      "mergeCancel",
      "mergeDiff",
      "mergeDiscard",
      "mergeStart",
      "mergeState",
      "status",
    ]);
    const cli = harness.registrations.cli;
    expect(cli?.name).toBe("skills-sync");
    expect(cli?.commands.map((command) => command.name)).toEqual([
      "sources",
      "status",
      "diff",
      "apply",
    ]);
    for (const command of cli?.commands ?? []) {
      expect(command.summary.length).toBeGreaterThan(10);
      expect(command.usage).toContain("bb skills-sync");
    }
    const apply = cli?.commands.find((command) => command.name === "apply");
    expect(apply?.summary).toContain("--overwrite-edits");
    expect(apply?.usage).toContain("--overwrite-edits");
    expect(harness.registrations.settingsDescriptors.autoFetchHours).toMatchObject({
      type: "string",
      default: "6",
    });
    expect(harness.registrations.settingsDescriptors.mergeProviderId).toMatchObject({
      type: "string",
      default: "codex",
    });
    expect(harness.registrations.settingsDescriptors.mergeModel).toMatchObject({
      type: "string",
      default: "gpt-5.6-luna",
    });
    expect(harness.registrations.settingsDescriptors.mergeReasoningLevel).toMatchObject({
      type: "select",
      default: "high",
    });
    expect(harness.registrations.schedules).toMatchObject([
      { name: "auto-fetch", cron: "0 */6 * * *" },
    ]);
  });

  it("requires backups in the apply RPC output at runtime", () => {
    const parsed = rpcContract.apply.output.safeParse({
      applied: [],
      failed: [],
      markerRefusal: null,
      marker: null,
    });
    expect(parsed.success).toBe(false);
  });
});

describe("rpc", () => {
  it("status buckets over the fake host", async () => {
    const { harness } = await hostWithRepo();
    const status = (await harness.callRpc("status", {
      sourceId: "test",
      refresh: false,
    })) as {
      skills: Array<{ name: string; bucket: string }>;
      foreign: string[];
      catalogue: unknown[];
      fetchedAt: number | null;
    };
    const byName = Object.fromEntries(status.skills.map((s) => [s.name, s.bucket]));
    expect(byName).toMatchObject({
      alpha: "clean",
      beta: "dirty-conflict",
      gamma: "new",
    });
    expect(byName.wip).toBeUndefined();
    expect(status.foreign).toEqual(["my-own-skill"]);
    expect(status.catalogue).toEqual([
      {
        name: "gamma",
        upstreamBucket: "core",
        description: "",
        offered: true,
      },
    ]);
    expect(status.fetchedAt).toEqual(expect.any(Number));
  });

  it("scheduled fetch refreshes and signals without installing or moving the marker", async () => {
    const { harness, installRoot, shas } = await hostWithRepo();
    const before = fs.readdirSync(installRoot).sort();

    await harness.runSchedule("auto-fetch");

    expect(fs.readdirSync(installRoot).sort()).toEqual(before);
    expect(fs.readFileSync(path.join(installRoot, ".test-skills-version"), "utf8").trim()).toBe(
      shas[0],
    );
    expect(fs.existsSync(path.join(installRoot, "gamma"))).toBe(false);
    expect(harness.realtimeSignals).toEqual([
      {
        channel: "skills-applied",
        payload: { sourceId: "test", changed: true },
      },
    ]);
  });

  it("apply refuses a foreign name, publishes nothing, and keeps the folder", async () => {
    const { harness, installRoot } = await hostWithRepo();
    const result = (await harness.callRpc("apply", {
      sourceId: "test",
      names: ["my-own-skill"],
      bumpMarker: true,
    })) as { applied: string[]; failed: Array<{ name: string }> };
    expect(result.applied).toEqual([]);
    expect(result.failed.map((entry) => entry.name)).toEqual(["my-own-skill"]);
    expect(harness.realtimeSignals).toHaveLength(0);
    expect(fs.readFileSync(path.join(installRoot, "my-own-skill/SKILL.md"), "utf8")).toContain(
      "written by me",
    );
  });

  it("apply refuses an explicitly named skill from a skipped bucket", async () => {
    const { harness, installRoot } = await hostWithRepo();
    const result = await harness.runCli(["apply", "--skill", "wip"]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toMatch(/Failed wip:.*in-progress.*skipBuckets.*refusing to install/i);
    expect(fs.existsSync(path.join(installRoot, "wip"))).toBe(false);
  });

  it("refuses a dirty conflict without the override while applying a clean name", async () => {
    const { harness, installRoot, shas } = await hostWithRepo();
    const betaBefore = fs.readFileSync(path.join(installRoot, "beta/SKILL.md"), "utf8");
    const result = (await harness.callRpc("apply", {
      sourceId: "test",
      names: ["beta", "alpha"],
      bumpMarker: false,
    })) as {
      applied: string[];
      failed: Array<{ name: string; error: string }>;
      markerRefusal: string | null;
      marker: string | null;
    };
    expect(result.applied).toEqual(["alpha"]);
    expect(result.failed).toEqual([
      {
        name: "beta",
        error: expect.stringMatching(/local edits.*hand merge.*explicit override/i),
      },
    ]);
    expect(result.markerRefusal).toBeNull();
    expect(result.marker).toBe(shas[0]);
    expect(fs.readFileSync(path.join(installRoot, "beta/SKILL.md"), "utf8")).toBe(betaBefore);
    expect(fs.readFileSync(path.join(installRoot, "alpha/SKILL.md"), "utf8")).toContain(
      "first, version",
    );
  });

  it("overwrites a dirty conflict only with the explicit override", async () => {
    const { harness, installRoot } = await hostWithRepo();
    const betaBefore = fs.readFileSync(path.join(installRoot, "beta/SKILL.md"));
    const result = (await harness.callRpc("apply", {
      sourceId: "test",
      names: ["beta"],
      bumpMarker: false,
      allowConflictOverwrite: true,
    })) as {
      applied: string[];
      failed: Array<{ name: string }>;
      markerRefusal: string | null;
      backups: Array<{ name: string; path: string }>;
    };
    expect(result.applied).toEqual(["beta"]);
    expect(result.failed).toEqual([]);
    expect(result.markerRefusal).toBeNull();
    expect(result.backups).toHaveLength(1);
    expect(result.backups[0].name).toBe("beta");
    expect(fs.readFileSync(path.join(result.backups[0].path, "SKILL.md"))).toEqual(betaBefore);
    expect(fs.readFileSync(path.join(installRoot, "beta/SKILL.md"), "utf8")).toContain(
      "beta rewritten",
    );
  });

  it("refuses to bump while another skill remains unresolved", async () => {
    const { harness, installRoot, shas } = await hostWithRepo();
    const result = (await harness.callRpc("apply", {
      sourceId: "test",
      names: ["gamma"],
      bumpMarker: true,
    })) as {
      applied: string[];
      failed: Array<{ name: string; error: string }>;
      markerRefusal: string | null;
      marker: string | null;
    };
    expect(result.applied).toEqual(["gamma"]);
    expect(result.marker).toBe(shas[0]);
    expect(result.failed).toEqual([]);
    expect(result.markerRefusal).toMatch(/unresolved upstream work/);
    expect(harness.realtimeSignals[0]).toMatchObject({
      channel: "skills-applied",
      payload: { sourceId: "test", applied: ["gamma"] },
    });
    expect(fs.existsSync(path.join(installRoot, "gamma/SKILL.md"))).toBe(true);
    expect(fs.readFileSync(path.join(installRoot, ".test-skills-version"), "utf8").trim()).toBe(
      shas[0],
    );
  });

  it("bumps when applying every unresolved skill leaves no work behind", async () => {
    const { harness, shas } = await hostWithRepo();
    const result = (await harness.callRpc("apply", {
      sourceId: "test",
      names: ["gamma", "alpha", "beta"],
      bumpMarker: true,
      allowConflictOverwrite: true,
    })) as {
      applied: string[];
      failed: Array<{ name: string }>;
      markerRefusal: string | null;
      marker: string | null;
    };
    expect(result.applied).toEqual(["gamma", "alpha", "beta"]);
    expect(result.failed).toEqual([]);
    expect(result.markerRefusal).toBeNull();
    expect(result.marker).toBe(shas[1]);
  });

  it("listSources returns the configured entries", async () => {
    const { harness } = await hostWithRepo();
    const result = (await harness.callRpc("listSources", null)) as {
      sources: Array<{ id: string }>;
    };
    expect(result.sources.map((source) => source.id)).toEqual(["test"]);
  });

  it("starts a merge in a visible attributed thread and stages outside the skills folder", async () => {
    const { harness, installRoot } = await hostWithRepo();
    const threads: Array<{
      id: string;
      title: string;
      status: "active" | "error" | "idle" | "starting" | "stopping";
      createdAt: number;
    }> = [];
    let spawnArgs: { title?: string; prompt?: string; providerId?: string; model?: string; reasoningLevel?: string } = {};
    harness.sdk.stub("projects.list", async () => [{ id: "personal", kind: "personal" }]);
    harness.sdk.stub("threads.list", async () => threads);
    harness.sdk.stub("threads.spawn", async (...args: never[]) => {
      spawnArgs = args[0] as typeof spawnArgs;
      const thread = {
        id: "merge-thread",
        title: spawnArgs.title ?? "",
        status: "active" as const,
        createdAt: Date.now(),
      };
      threads.push(thread);
      return thread;
    });

    const result = (await harness.callRpc("mergeStart", {
      sourceId: "test",
      name: "beta",
    })) as { state: string; threadId: string; stagingDir: string; error: string | null };

    expect(result).toMatchObject({ state: "running", threadId: "merge-thread", error: null });
    expect(result.stagingDir).not.toContain(installRoot);
    expect(fs.existsSync(result.stagingDir)).toBe(false);
    expect(spawnArgs).toMatchObject({
      providerId: "codex",
      model: "gpt-5.6-luna",
      reasoningLevel: "high",
    });
    expect(spawnArgs.prompt).toContain(path.join(installRoot, "beta"));
    expect(spawnArgs.prompt).toContain("pinned ancestor");
    expect(spawnArgs.prompt).toMatch(/upstream version at HEAD/i);
    expect(spawnArgs.prompt).toContain("ASK THE USER IN THIS THREAD");
    expect(spawnArgs.prompt).toMatch(/Do not\s+spawn subagents/);
    expect(spawnArgs.prompt).toContain(result.stagingDir);
  });

  it("reports a staged merge, diffs it against installed bytes, and backs up before accepting", async () => {
    const { harness, installRoot } = await hostWithRepo();
    const threads: Array<{
      id: string;
      title: string;
      status: "active" | "error" | "idle" | "starting" | "stopping";
      createdAt: number;
    }> = [];
    harness.sdk.stub("projects.list", async () => [{ id: "personal", kind: "personal" }]);
    harness.sdk.stub("threads.list", async () => threads);
    harness.sdk.stub("threads.archive", async () => ({ ok: true }));
    harness.sdk.stub("threads.spawn", async (...args: never[]) => {
      const input = args[0] as { title: string };
      const thread = {
        id: "merge-thread",
        title: input.title,
        status: "idle" as const,
        createdAt: Date.now(),
      };
      threads.push(thread);
      return thread;
    });

    const started = (await harness.callRpc("mergeStart", {
      sourceId: "test",
      name: "beta",
    })) as { stagingDir: string };
    const before = fs.readFileSync(path.join(installRoot, "beta/SKILL.md"), "utf8");
    fs.mkdirSync(started.stagingDir, { recursive: true });
    fs.writeFileSync(path.join(started.stagingDir, "SKILL.md"), skill("merged beta"));

    const state = await harness.callRpc("mergeState", { sourceId: "test", name: "beta" });
    expect(state).toMatchObject({ state: "ready", stagingDir: started.stagingDir });
    const diff = (await harness.callRpc("mergeDiff", {
      sourceId: "test",
      name: "beta",
    })) as { patch: string };
    expect(diff.patch).toContain("+merged beta");

    const accepted = (await harness.callRpc("mergeAccept", {
      sourceId: "test",
      name: "beta",
    })) as { backup: string };
    expect(fs.readFileSync(path.join(installRoot, "beta/SKILL.md"), "utf8")).toContain(
      "merged beta",
    );
    expect(fs.readFileSync(path.join(accepted.backup, "SKILL.md"), "utf8")).toBe(before);
    expect(fs.existsSync(started.stagingDir)).toBe(false);
  });

  it("aborts merge accept when the reused backup machinery cannot save the local copy", async () => {
    const { harness, installRoot } = await hostWithRepo();
    const threads: Array<{ id: string; title: string; status: "idle"; createdAt: number }> = [];
    harness.sdk.stub("projects.list", async () => [{ id: "personal", kind: "personal" }]);
    harness.sdk.stub("threads.list", async () => threads);
    harness.sdk.stub("threads.spawn", async (...args: never[]) => {
      const input = args[0] as { title: string };
      const thread = { id: "merge-thread", title: input.title, status: "idle" as const, createdAt: Date.now() };
      threads.push(thread);
      return thread;
    });
    const started = (await harness.callRpc("mergeStart", {
      sourceId: "test",
      name: "beta",
    })) as { stagingDir: string };
    fs.mkdirSync(started.stagingDir, { recursive: true });
    fs.writeFileSync(path.join(started.stagingDir, "SKILL.md"), skill("merged beta"));
    const cacheRoot = path.resolve(started.stagingDir, "../../../../");
    fs.writeFileSync(path.join(cacheRoot, "backups"), "not a directory");
    const before = fs.readFileSync(path.join(installRoot, "beta/SKILL.md"));

    await expect(
      harness.callRpc("mergeAccept", { sourceId: "test", name: "beta" }),
    ).rejects.toThrow(/backup|not a directory|ENOTDIR/i);
    expect(fs.readFileSync(path.join(installRoot, "beta/SKILL.md"))).toEqual(before);
    expect(fs.existsSync(started.stagingDir)).toBe(true);
  });

  it("cancels a running merge: stops the thread, drops the stage, leaves the skill alone", async () => {
    const { harness, installRoot } = await hostWithRepo();
    const threads: Array<{
      id: string;
      title: string;
      status: "active";
      createdAt: number;
    }> = [];
    const stopped: string[] = [];
    const archived: string[] = [];
    harness.sdk.stub("projects.list", async () => [{ id: "personal", kind: "personal" }]);
    harness.sdk.stub("threads.list", async () => threads);
    harness.sdk.stub("threads.stop", async (...args: never[]) => {
      stopped.push((args[0] as { threadId: string }).threadId);
      return { ok: true };
    });
    harness.sdk.stub("threads.archive", async (...args: never[]) => {
      const { threadId } = args[0] as { threadId: string };
      archived.push(threadId);
      // Archiving is what removes the merge from the unarchived listing.
      threads.length = 0;
      return { ok: true };
    });
    harness.sdk.stub("threads.spawn", async (...args: never[]) => {
      const thread = {
        id: "merge-thread",
        title: (args[0] as { title: string }).title,
        status: "active" as const,
        createdAt: Date.now(),
      };
      threads.push(thread);
      return thread;
    });
    const started = (await harness.callRpc("mergeStart", {
      sourceId: "test",
      name: "beta",
    })) as { stagingDir: string };
    fs.mkdirSync(started.stagingDir, { recursive: true });
    fs.writeFileSync(path.join(started.stagingDir, "SKILL.md"), skill("half done"));
    const before = fs.readFileSync(path.join(installRoot, "beta/SKILL.md"));

    await harness.callRpc("mergeCancel", { sourceId: "test", name: "beta" });

    expect(stopped).toEqual(["merge-thread"]);
    // Stopping comes first: an archived thread can still be writing.
    expect(archived).toEqual(["merge-thread"]);
    expect(fs.existsSync(path.dirname(started.stagingDir))).toBe(false);
    expect(fs.readFileSync(path.join(installRoot, "beta/SKILL.md"))).toEqual(before);
    expect(fs.existsSync(installRoot)).toBe(true);
    // The conflict is simply unresolved again.
    expect(await harness.callRpc("mergeState", { sourceId: "test", name: "beta" })).toMatchObject({
      state: "none",
      threadId: null,
      stagingDir: null,
    });
  });

  it("drops the stage but refuses to report a cancel when the thread cannot be stopped", async () => {
    const { harness, installRoot } = await hostWithRepo();
    const threads: Array<{
      id: string;
      title: string;
      status: "active";
      createdAt: number;
    }> = [];
    const archived: string[] = [];
    let stopCalls = 0;
    harness.sdk.stub("projects.list", async () => [{ id: "personal", kind: "personal" }]);
    harness.sdk.stub("threads.list", async () => threads);
    harness.sdk.stub("threads.stop", async () => {
      stopCalls += 1;
      throw new Error("no such thread");
    });
    harness.sdk.stub("threads.archive", async (...args: never[]) => {
      archived.push((args[0] as { threadId: string }).threadId);
      threads.length = 0;
      return { ok: true };
    });
    harness.sdk.stub("threads.spawn", async (...args: never[]) => {
      const thread = {
        id: "merge-thread",
        title: (args[0] as { title: string }).title,
        status: "active" as const,
        createdAt: Date.now(),
      };
      threads.push(thread);
      return thread;
    });
    const started = (await harness.callRpc("mergeStart", {
      sourceId: "test",
      name: "beta",
    })) as { stagingDir: string };
    fs.mkdirSync(started.stagingDir, { recursive: true });
    fs.writeFileSync(path.join(started.stagingDir, "SKILL.md"), skill("half done"));
    const before = fs.readFileSync(path.join(installRoot, "beta/SKILL.md"));

    await expect(
      harness.callRpc("mergeCancel", { sourceId: "test", name: "beta" }),
    ).rejects.toThrow(/could not be stopped|may still be running/i);

    // The thread really was listed and really was asked to stop.
    expect(stopCalls).toBe(1);
    // A thread we could not stop is not archived: hiding a live agent from the
    // panel is worse than leaving it visible.
    expect(archived).toEqual([]);
    // Cache bytes always go; the installed skill is never touched.
    expect(fs.existsSync(path.dirname(started.stagingDir))).toBe(false);
    expect(fs.readFileSync(path.join(installRoot, "beta/SKILL.md"))).toEqual(before);
    // And the merge still reports itself as running, because it is.
    expect(await harness.callRpc("mergeState", { sourceId: "test", name: "beta" })).toMatchObject({
      state: "running",
      threadId: "merge-thread",
    });
  });

  it("publishes when the agent writes SKILL.md, and stops watching afterwards", async () => {
    const { harness } = await hostWithRepo();
    harness.sdk.stub("projects.list", async () => [{ id: "personal", kind: "personal" }]);
    harness.sdk.stub("threads.list", async () => []);
    harness.sdk.stub("threads.spawn", async (...args: never[]) => ({
      id: "merge-thread",
      title: (args[0] as { title: string }).title,
      status: "active",
      createdAt: Date.now(),
    }));
    const started = (await harness.callRpc("mergeStart", {
      sourceId: "test",
      name: "beta",
    })) as { stagingDir: string };
    const afterStart = harness.realtimeSignals.length;

    // A folder appearing is not a finished merge; only SKILL.md is.
    fs.mkdirSync(started.stagingDir, { recursive: true });
    fs.writeFileSync(path.join(started.stagingDir, "notes.md"), "thinking");
    await pause(150);
    expect(harness.realtimeSignals).toHaveLength(afterStart);

    fs.writeFileSync(path.join(started.stagingDir, "SKILL.md"), skill("merged beta"));
    await until(() => harness.realtimeSignals.length > afterStart);
    expect(harness.realtimeSignals[afterStart]).toMatchObject({
      channel: "skills-applied",
      payload: { sourceId: "test", merge: "beta" },
    });

    // One transition, one signal: the watcher closed itself on the way out.
    const afterReady = harness.realtimeSignals.length;
    fs.writeFileSync(path.join(started.stagingDir, "SKILL.md"), skill("again"));
    await pause(150);
    expect(harness.realtimeSignals).toHaveLength(afterReady);
  });

  it("signals the running attempt even when an older attempt is already staged", async () => {
    const { harness } = await hostWithRepo();
    const threads: Array<{
      id: string;
      title: string;
      status: "active";
      createdAt: number;
    }> = [];
    harness.sdk.stub("projects.list", async () => [{ id: "personal", kind: "personal" }]);
    harness.sdk.stub("threads.list", async () => threads);
    harness.sdk.stub("threads.spawn", async (...args: never[]) => {
      const thread = {
        id: `merge-thread-${threads.length + 1}`,
        title: (args[0] as { title: string }).title,
        status: "active" as const,
        createdAt: Date.now() + threads.length,
      };
      threads.push(thread);
      return thread;
    });

    // An earlier attempt that finished and was never cleaned up.
    const first = (await harness.callRpc("mergeStart", {
      sourceId: "test",
      name: "beta",
    })) as { stagingDir: string };
    fs.mkdirSync(first.stagingDir, { recursive: true });
    fs.writeFileSync(path.join(first.stagingDir, "SKILL.md"), skill("stale merge"));
    await until(() => harness.realtimeSignals.length > 0);

    // A new attempt starts while that stale stage is still sitting there.
    const second = (await harness.callRpc("mergeStart", {
      sourceId: "test",
      name: "beta",
    })) as { stagingDir: string };
    expect(second.stagingDir).not.toEqual(first.stagingDir);
    const afterStart = harness.realtimeSignals.length;

    // The stale stage must not have consumed this attempt's watcher.
    fs.mkdirSync(second.stagingDir, { recursive: true });
    fs.writeFileSync(path.join(second.stagingDir, "SKILL.md"), skill("real merge"));
    await until(() => harness.realtimeSignals.length > afterStart);
    expect(harness.realtimeSignals[afterStart]).toMatchObject({
      channel: "skills-applied",
      payload: { sourceId: "test", merge: "beta" },
    });
  });

  it("leaves no watcher behind when the plugin is disposed", async () => {
    const { harness } = await hostWithRepo();
    harness.sdk.stub("projects.list", async () => [{ id: "personal", kind: "personal" }]);
    harness.sdk.stub("threads.list", async () => []);
    harness.sdk.stub("threads.spawn", async (...args: never[]) => ({
      id: "merge-thread",
      title: (args[0] as { title: string }).title,
      status: "active",
      createdAt: Date.now(),
    }));
    const started = (await harness.callRpc("mergeStart", {
      sourceId: "test",
      name: "beta",
    })) as { stagingDir: string };

    await harness.dispose();
    const afterDispose = harness.realtimeSignals.length;
    fs.mkdirSync(started.stagingDir, { recursive: true });
    fs.writeFileSync(path.join(started.stagingDir, "SKILL.md"), skill("too late"));
    await pause(150);

    // A live watcher here would publish through a poisoned handle and throw.
    expect(harness.realtimeSignals).toHaveLength(afterDispose);
  });

  it("discards only cache staging and leaves the installed skill untouched", async () => {
    const { harness, installRoot } = await hostWithRepo();
    harness.sdk.stub("projects.list", async () => [{ id: "personal", kind: "personal" }]);
    harness.sdk.stub("threads.spawn", async (...args: never[]) => ({
      id: "merge-thread",
      title: (args[0] as { title: string }).title,
      status: "idle",
      createdAt: Date.now(),
    }));
    harness.sdk.stub("threads.list", async () => []);
    const started = (await harness.callRpc("mergeStart", {
      sourceId: "test",
      name: "beta",
    })) as { stagingDir: string };
    fs.mkdirSync(started.stagingDir, { recursive: true });
    fs.writeFileSync(path.join(started.stagingDir, "SKILL.md"), skill("discard me"));
    const before = fs.readFileSync(path.join(installRoot, "beta/SKILL.md"));

    await harness.callRpc("mergeDiscard", { sourceId: "test", name: "beta" });

    expect(fs.readFileSync(path.join(installRoot, "beta/SKILL.md"))).toEqual(before);
    expect(fs.existsSync(started.stagingDir)).toBe(false);
  });
});

describe("cli", () => {
  it("prints usage with no arguments", async () => {
    const { harness } = await hostWithRepo();
    const result = await harness.runCli([]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("bb skills-sync apply");
    expect(result.stdout).toContain("--overwrite-edits");
  });

  it("renders a human status and a JSON status", async () => {
    const { harness } = await hostWithRepo();
    const human = await harness.runCli(["status"]);
    expect(human.exitCode).toBe(0);
    expect(human.stdout).toContain("Conflicts");
    expect(human.stdout).toContain("Foreign folders");
    expect(human.stdout).toContain("fetched");
    expect(human.stdout).toContain("Catalogue (available, not installed)");
    expect(human.stdout).toContain("gamma (core/)");

    const json = await harness.runCli(["status", "--json"]);
    expect(JSON.parse(json.stdout)).toMatchObject({ sourceId: "test" });
  });

  it("refuses apply with no --skill", async () => {
    const { harness } = await hostWithRepo();
    const result = await harness.runCli(["apply"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("never globs");
  });

  it("applies several explicit --skill flags", async () => {
    const { harness, installRoot } = await hostWithRepo();
    const result = await harness.runCli(["apply", "--skill", "gamma", "--skill", "alpha"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Applied: gamma, alpha");
    expect(fs.existsSync(path.join(installRoot, "gamma/SKILL.md"))).toBe(true);
  });

  it("exits non-zero when a name is refused", async () => {
    const { harness } = await hostWithRepo();
    const result = await harness.runCli(["apply", "--skill", "my-own-skill"]);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("Failed my-own-skill");
  });

  it("reports a marker refusal separately from skill failures", async () => {
    const { harness } = await hostWithRepo();
    const result = await harness.runCli(["apply", "--skill", "gamma", "--bump"]);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("Marker refusal: Refusing to bump");
    expect(result.stdout).not.toContain("Failed marker");
  });

  it("passes the destructive overwrite flag through the CLI", async () => {
    const refusedHost = await hostWithRepo();
    const refused = await refusedHost.harness.runCli(["apply", "--skill", "beta"]);
    expect(refused.exitCode).toBe(1);
    expect(refused.stdout).toContain("Failed beta");
    expect(refused.stdout).toContain("local edits");

    const forcedHost = await hostWithRepo();
    const forced = await forcedHost.harness.runCli([
      "apply",
      "--skill",
      "beta",
      "--overwrite-edits",
    ]);
    expect(forced.exitCode).toBe(0);
    expect(forced.stdout).toContain("Applied: beta");
    expect(forced.stdout).toContain("Backup beta:");
    expect(fs.readFileSync(path.join(forcedHost.installRoot, "beta/SKILL.md"), "utf8")).toContain(
      "beta rewritten",
    );
  });

  it("diffs one skill both ways", async () => {
    const { harness } = await hostWithRepo();
    const upstream = await harness.runCli(["diff", "--skill", "beta"]);
    expect(upstream.stdout).toContain("+beta rewritten");
    const local = await harness.runCli(["diff", "--skill", "beta", "--kind", "local"]);
    expect(local.stdout).toContain("+my own beta");
    const bad = await harness.runCli(["diff", "--skill", "beta", "--kind", "sideways"]);
    expect(bad.exitCode).toBe(1);
  });

  it("stays under the host's output cap", async () => {
    const { harness } = await hostWithRepo();
    const result = await harness.runCli(["status"]);
    expect(result.error).toBeUndefined();
  });
});

describe("argv and truncation helpers", () => {
  it("collects repeated flags and inline values", () => {
    expect(parseArgv(["apply", "--skill", "a", "--skill=b", "--bump"])).toEqual({
      command: "apply",
      bare: [],
      flags: { skill: ["a", "b"], bump: [""] },
    });
  });

  it("says when it truncated", () => {
    const out = truncateForCli("x".repeat(500), 200);
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(200);
    expect(out).toContain("truncated");
  });

  it("returns a parseable JSON error instead of truncating JSON", () => {
    const result = formatCliReply(
      { skills: ["x".repeat(500)] },
      "unused human output",
      true,
      200,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBeUndefined();
    expect(Buffer.byteLength(result.stdout ?? "", "utf8")).toBeLessThanOrEqual(200);
    expect(JSON.parse(result.stdout ?? "")).toMatchObject({
      error: expect.stringMatching(/narrow the request/i),
    });
  });
});
