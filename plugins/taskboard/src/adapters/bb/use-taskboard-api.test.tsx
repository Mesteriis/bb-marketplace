// @vitest-environment jsdom
import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useTaskboardApi, type TaskboardRpc } from "./use-taskboard-api.ts";

afterEach(cleanup);
it("keeps API identity stable when the host supplies a new RPC wrapper and uses the latest transport", async () => {
  const first = vi.fn(async () => ({ boards: [] }));
  const second = vi.fn(async () => ({ boards: [{ id: "new-board" }] }));
  const { result, rerender } = renderHook(({ rpc }) => useTaskboardApi(rpc), { initialProps: { rpc: { call: first } as unknown as TaskboardRpc } });
  const original = result.current;
  await original.listBoards();
  rerender({ rpc: { call: second } as unknown as TaskboardRpc });
  expect(result.current).toBe(original);
  expect(await original.listBoards()).toEqual([{ id: "new-board" }]);
  expect(first).toHaveBeenCalledTimes(1);
  expect(second).toHaveBeenCalledTimes(1);
});
