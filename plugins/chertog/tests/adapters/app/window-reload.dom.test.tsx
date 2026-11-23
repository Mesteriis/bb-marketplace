// A reloaded BB window gets a new identity. The panel its previous document
// owned must come back without a click, while a panel of a live window stays put.
import { act, cleanup, render, screen } from "@testing-library/react";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { threadRef } from "../../../src/adapters/bb/app/thread-source.ts";
import { WindowOverlay, WindowThread } from "../../../src/adapters/bb/app/window-handoff.ts";
import { createWindowWorkspace } from "../../../src/adapters/bb/app/window-workspace.ts";
import { createWindowsStore } from "../../../src/adapters/bb/server/windows-store.ts";
import { PRESENCE_MS } from "../../../src/core/windows/ownership.ts";
import { windowSchemas } from "../../../src/core/windows/wire.ts";

afterEach(cleanup);

function server(clock: { now: number }) {
  const db = new DatabaseSync(":memory:");
  const store = createWindowsStore(db, () => clock.now);
  const rpc = async (method: "window_sync" | "window_change", input: Record<string, unknown>) => {
    if (method === "window_sync") {
      const { credential, close, suspended } = windowSchemas.window_sync.input.parse(input);
      return store(credential, close, undefined, !suspended).snapshot;
    }
    const { credential, ...mutation } = windowSchemas.window_change.input.parse(input);
    return store(credential, false, mutation).snapshot;
  };
  return { store, rpc };
}

/** One BB document: a fresh workspace, hence a fresh window identity. */
function openDocument(rpc: ReturnType<typeof server>["rpc"]) {
  const workspace = createWindowWorkspace({ renderChat: () => null, randomId: () => crypto.randomUUID(), diagnostics: { failure: () => {} } });
  workspace.threads.set({ status: "ready", threads: [{ id: "thr_a", title: "Тред", projectName: null }] });
  workspace.session.registry.open(threadRef("thr_a"));
  const view = render(
    <WindowOverlay workspace={workspace} call={rpc}>
      <WindowThread threadId="thr_a">
        <p>Чат треда</p>
      </WindowThread>
    </WindowOverlay>,
  );
  return { workspace, view };
}

it("keeps the thread after a reload of the owning window, without a click", async () => {
  const { rpc } = server({ now: 1_000_000 });
  const first = openDocument(rpc);
  expect(await screen.findByText("Чат треда")).toBeTruthy();
  // pagehide, then the new document of the same window
  await act(async () => {
    window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: false }));
  });
  first.view.unmount();
  openDocument(rpc);
  expect(await screen.findByText("Чат треда")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Вернуть панель в это окно" })).toBeNull();
});

it("takes over the panel of a window that stopped answering", async () => {
  const clock = { now: 1_000_000 };
  const { rpc } = server(clock);
  const first = openDocument(rpc);
  expect(await screen.findByText("Чат треда")).toBeTruthy();
  // killed without pagehide: no leave is sent, the heartbeat just stops
  first.view.unmount();
  clock.now += PRESENCE_MS + 1000;
  openDocument(rpc);
  expect(await screen.findByText("Чат треда")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Вернуть панель в это окно" })).toBeNull();
});

it("does not take the panel of a live window", async () => {
  const clock = { now: 1_000_000 };
  const { rpc, store } = server(clock);
  // another live window owns the thread
  const other = store("other", false);
  store("other", false, { threadId: "thr_a", generation: 0, command: { action: "claim" } });
  openDocument(rpc);
  expect(await screen.findByText(/Панель в окне/)).toBeTruthy();
  expect(screen.queryByText("Чат треда")).toBeNull();
  expect(store("other", false).snapshot.placements[0].placement.owner).toBe(other.snapshot.instanceId);
});
