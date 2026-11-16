// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor } from "@testing-library/react";
import {
  loadPluginApp,
  renderSlot,
  type PluginRpcTestHandlers,
} from "@get-bb/plugin-sdk/testing/app";
import type { rpcContract } from "@/contract";
import type { SkillStatus, Status } from "./model";

type Contract = typeof rpcContract;

function skill(name: string, bucket: SkillStatus["bucket"]): SkillStatus {
  return {
    name,
    bucket,
    upstreamBucket: "",
    substantiveFiles: [],
    cosmeticFiles: [],
    localEditedFiles: [],
  };
}

function status(overrides: Partial<Status> = {}): Status {
  return {
    sourceId: "matt",
    pinned: "aaaaaaa",
    head: "bbbbbbb",
    commits: [],
    skills: [],
    foreign: [],
    catalogue: [],
    fetchedAt: null,
    autoFetchHours: 0,
    ...overrides,
  };
}

function source(id: string) {
  return {
    id,
    url: "https://example.test/skills.git",
    ref: "HEAD",
    skillsDir: "skills",
    nested: true,
    skipBuckets: [],
    installRoot: `/tmp/${id}`,
    marker: ".pin",
  };
}

function handlers(
  overrides: Partial<PluginRpcTestHandlers<Contract>> = {},
): PluginRpcTestHandlers<Contract> {
  return {
    listSources: () => ({ sources: [source("matt")] }),
    status: () => status(),
    diff: () => ({ patch: "" }),
    apply: () => ({ applied: [], failed: [], markerRefusal: null, marker: null }),
    ...overrides,
  } as PluginRpcTestHandlers<Contract>;
}

async function mountAccessory(
  rpc: PluginRpcTestHandlers<Contract>,
  options: { realtimeConnectionState?: "connected" | "connecting" } = {},
) {
  const app = await loadPluginApp(() => import("@/app"));
  const accessory = app.navPanels[0].experimental_sidebarAccessory;
  expect(accessory).toBeDefined();
  return renderSlot<Record<string, never>, Contract>(
    { component: accessory! },
    {},
    { rpc, ...options },
  );
}

/** Wait until the accessory has made, and settled, the calls it makes. */
async function settled(
  rendered: { rpcCalls: { method: string }[] },
  calls: number,
) {
  await waitFor(() => expect(rendered.rpcCalls).toHaveLength(calls));
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("sidebar accessory", () => {
  it("counts the skills that still need a decision", async () => {
    const rendered = await mountAccessory(
      handlers({
        status: () =>
          status({
            skills: [
              skill("a", "new"),
              skill("b", "clean"),
              skill("c", "dirty-only"),
              skill("d", "dirty-conflict"),
              skill("e", "deprecated"),
            ],
          }),
      }),
    );
    expect(await screen.findByLabelText("3 skills to apply")).toBeTruthy();
    expect(rendered.container.textContent).toBe("3");
  });

  it("renders nothing rather than a zero", async () => {
    const rendered = await mountAccessory(
      handlers({
        status: () =>
          status({
            skills: [skill("c", "dirty-only"), skill("e", "deprecated")],
            catalogue: [
              { name: "x", upstreamBucket: "", description: "", offered: false },
            ],
          }),
      }),
    );
    await settled(rendered, 2);
    expect(rendered.container.textContent).toBe("");
  });

  it("reads the cache and never asks for a network fetch", async () => {
    const rendered = await mountAccessory(handlers());
    await settled(rendered, 2);
    expect(rendered.rpcCalls).toEqual([
      { method: "listSources", input: null },
      { method: "status", input: { sourceId: "matt", refresh: false } },
    ]);
  });

  it("adds up every configured source", async () => {
    await mountAccessory(
      handlers({
        listSources: () => ({ sources: [source("matt"), source("other")] }),
        status: ({ sourceId }) =>
          status({
            skills:
              sourceId === "matt" ? [skill("a", "new")] : [skill("b", "clean")],
          }),
      }),
    );
    expect(await screen.findByLabelText("2 skills to apply")).toBeTruthy();
  });

  it("shows nothing at all when the status cannot be read", async () => {
    const rendered = await mountAccessory(
      handlers({
        status: () => {
          throw new Error("cache is missing");
        },
      }),
    );
    await settled(rendered, 2);
    expect(rendered.container.textContent).toBe("");
  });

  it("shows nothing when no source is configured", async () => {
    const rendered = await mountAccessory(
      handlers({ listSources: () => ({ sources: [] }) }),
    );
    await settled(rendered, 1);
    expect(rendered.container.textContent).toBe("");
  });

  it("recounts when the backend says skills changed", async () => {
    let count = 1;
    const rendered = await mountAccessory(
      handlers({
        status: () =>
          status({
            skills: Array.from({ length: count }, (_, index) =>
              skill(`s${index}`, "new"),
            ),
          }),
      }),
    );
    expect(await screen.findByLabelText("1 skill to apply")).toBeTruthy();

    count = 3;
    await rendered.emitRealtime("skills-applied", null);
    expect(await screen.findByLabelText("3 skills to apply")).toBeTruthy();
  });

  it("recounts after the realtime connection comes back", async () => {
    let count = 1;
    const rendered = await mountAccessory(
      handlers({
        status: () =>
          status({
            skills: Array.from({ length: count }, (_, index) =>
              skill(`s${index}`, "new"),
            ),
          }),
      }),
    );
    expect(await screen.findByLabelText("1 skill to apply")).toBeTruthy();
    const before = rendered.rpcCalls.length;

    // Still connected: nothing to catch up on.
    await rendered.setRealtimeConnectionState("connected");
    expect(rendered.rpcCalls).toHaveLength(before);

    count = 4;
    await rendered.setRealtimeConnectionState("reconnecting");
    await rendered.setRealtimeConnectionState("connected");
    expect(await screen.findByLabelText("4 skills to apply")).toBeTruthy();
  });
});
