import { expect, it } from "vitest";
import { WindowClient } from "../../../src/adapters/bb/app/window-handoff.ts";

it("retires a cached permission immediately on an uncertain RPC result", async () => {
  const client = new WindowClient();
  const snapshot = { instanceId: "source", windows: ["source"], placements: [] };
  await client.start(async () => snapshot);
  expect(client.read().snapshot).toEqual(snapshot);
  await client.start(async () => {
    throw new Error("offline");
  });
  expect(client.read().snapshot).toBeNull();
  expect(client.read().error).toContain("offline");
  client.stop();
});

import { initialDocument } from "../../../src/core/workspace/index.ts";
import { windowLayoutPort } from "../../../src/adapters/bb/app/window-workspace.ts";

it("a returning window restores its own selection when another window saved a different one", async () => {
  const initial = initialDocument("main", "Основная");
  const document = { ...initial, layouts: [...initial.layouts, { ...initial.layouts[0], id: "other", name: "Другая" }] };
  let local = "other";
  const port = windowLayoutPort(
    {
      load: async () => ({ status: "ok", document, dropped: [], migratedFrom: null }),
      save: async (next) => {
        return { status: "saved", document: { ...next, revision: 1 } };
      },
    },
    {
      get: () => local,
      set: (id) => {
        local = id;
      },
    },
  );
  const read = await port.load();
  expect(read.status === "ok" && read.document.activeLayoutId).toBe("other");
  const result = await port.save({ ...document, activeLayoutId: "other" }, 0);
  expect(local).toBe("other");
  expect(result.status === "saved" && result.document.activeLayoutId).toBe("other");
});

it("grants input only to the unfenced owner and issues a fresh identity in another document", async () => {
  const client = new WindowClient();
  const other = new WindowClient();
  const credentials: unknown[] = [];
  let phase: "prepared" | "ready" = "prepared";
  const read = async (_: string, input: Record<string, unknown>) => {
    credentials.push(input.credential);
    return {
      instanceId: "source",
      windows: ["source", "target"],
      placements: [
        {
          threadId: "thr_a",
          placement: { owner: "source", generation: 2, transfer: { source: "source", target: "target", phase, expires: 10000 } },
        },
      ],
    };
  };
  try {
    await client.start(read);
    expect(client.canInput("thr_a")).toBe(true);
    phase = "ready";
    await client.sync();
    expect(client.canInput("thr_a")).toBe(false);
    await other.start(read);
    expect(credentials[0]).toBe(credentials[1]);
    expect(credentials[0]).not.toBe(credentials[2]);
  } finally {
    client.stop();
    other.stop();
  }
});
