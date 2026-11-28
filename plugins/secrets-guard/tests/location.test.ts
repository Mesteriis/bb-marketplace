import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLocatedStore, locateStateFile } from "../src/adapters/bb/location.ts";
import { StoreUnavailable, type LogEvent } from "../src/core/ports.ts";
import type { GuardState } from "../src/core/state.ts";

const OPEN_A: LogEvent = { event: "open", scope: "thread", root: "a", until: 1600 };
const openA = (state: GuardState): GuardState => ({
  ...state,
  threads: { ...state.threads, a: { until: 1600, root: "a", tree: false } },
});
const OPENED = { threads: { a: { until: 1600, root: "a", tree: false } } };

/** A temporary directory stands in for the home folder. */
let home: string;
let pointer: string;
let fromHook: string;
let fromSetting: string;
let setting: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "guard-home-"));
  await mkdir(join(home, ".claude", "hooks"), { recursive: true });
  await mkdir(join(home, "state"));
  await mkdir(join(home, "override"));
  pointer = join(home, ".claude", "hooks", "guard-location.json");
  fromHook = join(home, "state", "marker.json");
  fromSetting = join(home, "override", "marker.json");
  setting = "";
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

const publish = (stateFile: unknown) => writeFile(pointer, JSON.stringify({ stateFile }));
const locate = () => locateStateFile({ setting, homeDir: home });
const store = () => createLocatedStore({ locate, now: () => 1000, lockWaitMs: 150 });
const json = async (path: string) => JSON.parse(await readFile(path, "utf8")) as unknown;

async function reasonOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof StoreUnavailable) return error.reason;
    throw error;
  }
  return "resolved";
}

describe("locateStateFile", () => {
  it("takes the path the hook published when the setting is empty", async () => {
    await publish(fromHook);
    expect(await locate()).toBe(fromHook);
  });
  it("treats a setting of blanks as empty", async () => {
    await publish(fromHook);
    setting = "   ";
    expect(await locate()).toBe(fromHook);
  });
  it("prefers a setting over the pointer", async () => {
    await publish(fromHook);
    setting = fromSetting;
    expect(await locate()).toBe(fromSetting);
  });
  it("does not fall back to the pointer when the setting is not an absolute path", async () => {
    await publish(fromHook);
    setting = "marker.json";
    expect(await locate()).toBeNull();
  });
  it("is null without a pointer", async () => {
    expect(await locate()).toBeNull();
  });
  it.each([
    ["a relative path", '{"stateFile":"state/marker.json"}'],
    ["a number", '{"stateFile":5}'],
    ["an empty string", '{"stateFile":""}'],
    ["no stateFile", '{"other":"/tmp/x"}'],
    ["an array", '["/tmp/x"]'],
    ["broken JSON", '{"stateFile":"/tmp'],
    ["an empty file", ""],
  ])("is null for a pointer with %s", async (_name, text) => {
    await writeFile(pointer, text);
    expect(await locate()).toBeNull();
  });
  it("is null when the pointer is a directory", async () => {
    await mkdir(pointer);
    expect(await locate()).toBeNull();
  });
});

describe("a store that finds its marker on every access", () => {
  it("works at the path from the pointer when the setting is empty", async () => {
    await publish(fromHook);
    const located = store();
    expect(await located.writable()).toBe(true);
    expect(await located.update(openA, OPEN_A)).toEqual(OPENED);
    expect(await json(fromHook)).toEqual(OPENED);
    expect(await located.read()).toEqual(OPENED);
  });
  it("ignores the pointer when the setting is given", async () => {
    await publish(fromHook);
    setting = fromSetting;
    await store().update(openA, OPEN_A);
    expect(await json(fromSetting)).toEqual(OPENED);
    await expect(stat(fromHook)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("is not configured without a pointer", async () => {
    const located = store();
    expect(await located.writable()).toBe(false);
    expect(await located.read()).toEqual({ threads: {} });
    expect(await reasonOf(located.update(openA, OPEN_A))).toBe("not_configured");
  });
  it.each([
    ["a relative path", '{"stateFile":"state/marker.json"}'],
    ["a number", '{"stateFile":5}'],
    ["broken JSON", '{"stateFile":"/tmp'],
  ])("is not configured for a pointer with %s", async (_name, text) => {
    await writeFile(pointer, text);
    const located = store();
    expect(await located.writable()).toBe(false);
    expect(await reasonOf(located.update(openA, OPEN_A))).toBe("not_configured");
  });
  it("sees a pointer that appears after the start", async () => {
    const located = store();
    expect(await located.writable()).toBe(false);
    await publish(fromHook);
    expect(await located.writable()).toBe(true);
    await located.update(openA, OPEN_A);
    expect(await json(fromHook)).toEqual(OPENED);
  });
  it("closes what is open in the old file when the pointer moves", async () => {
    await publish(fromHook);
    const located = store();
    await located.update(openA, OPEN_A);
    await publish(fromSetting);
    expect(await located.read()).toEqual({ threads: {} });
    expect(await json(fromHook)).toEqual({ threads: {} });
  });
  it("leaves the marker alone while the pointer is unreadable, and goes on when it is back", async () => {
    await publish(fromHook);
    const located = store();
    await located.update(openA, OPEN_A);
    await writeFile(pointer, "{");
    expect(await located.writable()).toBe(false);
    expect(await located.read()).toEqual({ threads: {} });
    expect(await json(fromHook)).toEqual(OPENED);
    await publish(fromHook);
    expect(await located.read()).toEqual(OPENED);
  });
  it("closes the last file on leave", async () => {
    await publish(fromHook);
    const located = store();
    await located.update(openA, OPEN_A);
    await located.leave();
    expect(await json(fromHook)).toEqual({ threads: {} });
  });
});
