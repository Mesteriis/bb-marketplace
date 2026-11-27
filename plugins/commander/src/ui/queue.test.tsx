// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { OperationJob } from "../core/model.ts";
import type { JobView } from "./model.ts";
import { Queue } from "./queue.tsx";

// The same icon stand-in as app.test.tsx: the plugin runtime is not available here.
vi.mock("@get-bb/plugin-sdk/app", () => ({
  experimental_Icon: ({ name }: { name: string }) => <svg aria-hidden="true" data-test-icon={name} />,
}));

afterEach(cleanup);

function job(state: string, id: string): JobView {
  return {
    id,
    state,
    awaitsOwner: false,
    pendingConflict: null,
    currentItem: null,
    error: null,
    createdAt: "2026-11-27T00:00:00.000Z",
    updatedAt: "2026-11-27T00:00:00.000Z",
    progress: { itemsDone: 2, itemsTotal: 3, bytesDone: "0", bytesTotal: "3" },
    items: [{ outcome: "done", error: null }, { outcome: "failed", error: "Denied" }, { outcome: "unknown", error: null }],
    plan: {
      id: "123e4567-e89b-42d3-a456-426614174000",
      kind: "copy",
      createdAt: "2026-11-27T00:00:00.000Z",
      initiator: { kind: "owner" },
      sourceEndpoint: "host:from",
      targetEndpoint: "host:to",
      targetDir: { endpoint: "host:to", path: { segments: [] } },
      items: [],
      conflictPolicy: "ask",
      route: "relay-server",
      verify: "size",
      totalBytes: "3",
      digest: "0".repeat(64),
    },
  } as unknown as JobView;
}

const selection = { count: 0, size: "0", destination: "—", fullDestination: "—" };
const handlers = { onInspect: vi.fn(), onSkip: vi.fn(), onCancel: vi.fn() };

test("offers retry of unfinished items on a failed job and passes the job to it", () => {
  const onRetry = vi.fn();
  const failed = job("failed", "223e4567-e89b-42d3-a456-000000000001");
  render(<Queue id="queue" open selection={selection} jobs={[failed]} endpoints={[]} error={null} loading={false}
    {...handlers} onRetry={onRetry} />);
  fireEvent.click(screen.getByRole("button", { name: "Повторить невыполненное" }));
  expect(onRetry).toHaveBeenCalledTimes(1);
  expect((onRetry.mock.calls[0][0] as OperationJob).id).toBe("223e4567-e89b-42d3-a456-000000000001");
});

test("offers retry for an unknown job", () => {
  render(<Queue id="queue" open selection={selection} jobs={[job("unknown", "223e4567-e89b-42d3-a456-000000000002")]}
    endpoints={[]} error={null} loading={false} {...handlers} onRetry={vi.fn()} />);
  expect(screen.getByRole("button", { name: "Повторить невыполненное" })).toBeDefined();
});

test("hides retry for a completed job", () => {
  render(<Queue id="queue" open selection={selection} jobs={[job("completed", "223e4567-e89b-42d3-a456-000000000003")]}
    endpoints={[]} error={null} loading={false} {...handlers} onRetry={vi.fn()} />);
  expect(screen.queryByRole("button", { name: "Повторить невыполненное" })).toBeNull();
});

test("hides retry when the host does not wire it", () => {
  render(<Queue id="queue" open selection={selection} jobs={[job("failed", "223e4567-e89b-42d3-a456-000000000004")]}
    endpoints={[]} error={null} loading={false} {...handlers} />);
  expect(screen.queryByRole("button", { name: "Повторить невыполненное" })).toBeNull();
});

test("says how many files wait for a directory check on a failed job", () => {
  const failed = job("failed", "223e4567-e89b-42d3-a456-000000000005");
  render(<Queue id="queue" open selection={selection} jobs={[failed]} endpoints={[]} error={null} loading={false}
    {...handlers} onRetry={vi.fn()} unconfirmedChildren={{ [failed.id]: 2 }} />);
  expect(screen.getByText("2 элемента ждут сверки каталога")).toBeDefined();
});
