// Handing a thread over to another window is an item of the tile menu. The
// thread content carries no row for it.
import { act, render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { handoffMenuItems, WindowOverlay, WindowThread, WindowClient } from "../../../src/adapters/bb/app/window-handoff.ts";
import { createWindowWorkspace } from "../../../src/adapters/bb/app/window-workspace.ts";

type Placement = { owner: string | null; generation: number; transfer: null | { source: string; target: string; phase: "prepared" | "ready" | "switched"; expires: number } };

function snapshot(windows: string[], placement: Placement | null) {
  return {
    instanceId: "me",
    windows,
    placements: placement === null ? [] : [{ threadId: "thr_a", placement }],
  };
}

async function clientWith(windows: string[], placement: Placement | null) {
  const client = new WindowClient();
  const sent: Record<string, unknown>[] = [];
  await client.start(async (method, input) => {
    if (method === "window_change") sent.push(input);
    return snapshot(windows, placement);
  });
  return { client, sent };
}

it("offers one item per other window, and a prepare command for it", async () => {
  const { client, sent } = await clientWith(["me", "634b078f51300", "aaaaaaaa11"], { owner: "me", generation: 3, transfer: null });
  const items = handoffMenuItems(client, "thr_a");
  expect(items.map((item) => item.label)).toEqual(["Передать в окно 634b078f", "Передать в окно aaaaaaaa"]);
  await act(async () => items[0].onSelect?.());
  expect(sent).toEqual([expect.objectContaining({ threadId: "thr_a", generation: 3, command: { action: "prepare", target: "634b078f51300" } })]);
});

it("explains that a second window is needed when there is none", async () => {
  const { client } = await clientWith(["me"], { owner: "me", generation: 1, transfer: null });
  const [item] = handoffMenuItems(client, "thr_a");
  expect(item.label).toBe("Передать в другое окно");
  expect(item.onSelect).toBeUndefined();
  expect(item.reason).toContain("New Window");
});

it("offers to cancel a prepared handover this window started, and nothing while it runs on", async () => {
  const transfer = { source: "me", target: "other", expires: 10000 };
  const prepared = await clientWith(["me", "other"], { owner: "me", generation: 2, transfer: { ...transfer, phase: "prepared" } });
  expect(handoffMenuItems(prepared.client, "thr_a").map((item) => item.label)).toEqual(["Отменить передачу"]);
  const ready = await clientWith(["me", "other"], { owner: "me", generation: 2, transfer: { ...transfer, phase: "ready" } });
  expect(handoffMenuItems(ready.client, "thr_a")).toEqual([]);
});

it("offers nothing to a window that does not own the thread, or before the first answer", async () => {
  const foreign = await clientWith(["me", "other"], { owner: "other", generation: 2, transfer: null });
  expect(handoffMenuItems(foreign.client, "thr_a")).toEqual([]);
  expect(handoffMenuItems(new WindowClient(), "thr_a")).toEqual([]);
});

it("draws no handover row over the thread of the owning window", async () => {
  const workspace = createWindowWorkspace({ renderChat: () => null, randomId: () => crypto.randomUUID(), diagnostics: { failure: () => {} } });
  const rpc = async () => snapshot(["me", "other"], { owner: "me", generation: 1, transfer: null });
  render(
    <WindowOverlay workspace={workspace} call={rpc}>
      <WindowThread threadId="thr_a">
        <p>Чат треда</p>
      </WindowThread>
    </WindowOverlay>,
  );
  expect(await screen.findByText("Чат треда")).toBeTruthy();
  expect(screen.queryByText("Передать в другое окно")).toBeNull();
  expect(screen.queryAllByRole("button")).toEqual([]);
});
