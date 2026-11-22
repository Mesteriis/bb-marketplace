import { act, render } from "@testing-library/react";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { WindowOverlay } from "../../../src/adapters/bb/app/window-handoff.ts";
import { threadRef } from "../../../src/adapters/bb/app/thread-source.ts";
import { createWindowWorkspace } from "../../../src/adapters/bb/app/window-workspace.ts";
import { createWindowsStore } from "../../../src/adapters/bb/server/windows-store.ts";
import { windowSchemas } from "../../../src/core/windows/wire.ts";

function setup() {
  const db = new DatabaseSync(":memory:");
  const store = createWindowsStore(db);
  const workspace = createWindowWorkspace({
    renderChat: () => null,
    randomId: () => crypto.randomUUID(),
    diagnostics: { failure: () => {} },
  });
  workspace.threads.set({ status: "ready", threads: [{ id: "thr_one", title: "Тред", projectName: null }] });
  workspace.session.registry.open(threadRef("thr_one"));
  const rpc = async (method: "window_sync" | "window_change", input: Record<string, unknown>) => {
    if (method === "window_sync") {
      const { credential, close } = windowSchemas.window_sync.input.parse(input);
      return store(credential, close).snapshot;
    }
    const { credential, ...mutation } = windowSchemas.window_change.input.parse(input);
    return store(credential, false, mutation).snapshot;
  };
  const view = render(
    <WindowOverlay workspace={workspace} call={rpc}>
      {null}
    </WindowOverlay>,
  );
  return {
    client: workspace.handoff,
    store,
    dispose: () => {
      view.unmount();
      db.close();
    },
  };
}

async function navigate(name: "pagehide" | "pageshow", persisted: boolean) {
  await act(async () => {
    window.dispatchEvent(new PageTransitionEvent(name, { persisted }));
  });
}

it("reads current ownership with a new window identity on persisted pageshow", async () => {
  const { client, store, dispose } = setup();
  try {
    await act(() => client.change("thr_one", 0, { action: "claim" }));
    const before = client.read().snapshot!.instanceId;
    expect(client.canInput("thr_one")).toBe(true);
    await navigate("pagehide", true);
    expect(client.canInput("thr_one")).toBe(false);
    const other = store("other", false, { threadId: "thr_one", generation: 1, command: { action: "claim" } }).snapshot;
    await navigate("pageshow", true);
    const restored = client.read().snapshot;
    expect(restored).not.toBeNull();
    expect(restored!.instanceId).not.toBe(before);
    expect(restored!.placements).toEqual([
      { threadId: "thr_one", placement: { owner: other.instanceId, generation: 2, transfer: null } },
    ]);
    expect(client.canInput("thr_one")).toBe(false);
  } finally {
    dispose();
  }
});

it("permanently leaves on ordinary pagehide", async () => {
  const { client, store, dispose } = setup();
  try {
    await act(() => client.sync());
    const id = client.read().snapshot!.instanceId;
    await navigate("pagehide", false);
    await navigate("pageshow", false);
    await client.sync();
    expect(client.read().snapshot).toBeNull();
    expect(store("observer", false).snapshot.windows).not.toContain(id);
  } finally {
    dispose();
  }
});
