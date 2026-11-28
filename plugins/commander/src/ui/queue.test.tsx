// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { OperationJob } from "../core/model.ts";
import { parentSkipNote } from "../core/retry-note.ts";
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

test("offers retry for a completed or cancelled job and not for a running one", () => {
  const ids = ["223e4567-e89b-42d3-a456-000000000003", "223e4567-e89b-42d3-a456-000000000006"];
  render(<Queue id="queue" open selection={selection}
    jobs={[job("completed", ids[0]), job("cancelled", ids[1]), job("running", "223e4567-e89b-42d3-a456-000000000007")]}
    endpoints={[]} error={null} loading={false} {...handlers} onRetry={vi.fn()} />);
  expect(screen.getAllByRole("button", { name: "Повторить невыполненное" })).toHaveLength(2);
});

test("hides retry when the host does not wire it", () => {
  render(<Queue id="queue" open selection={selection} jobs={[job("failed", "223e4567-e89b-42d3-a456-000000000004")]}
    endpoints={[]} error={null} loading={false} {...handlers} />);
  expect(screen.queryByRole("button", { name: "Повторить невыполненное" })).toBeNull();
});

test("says how many files wait for a directory check on a failed job", () => {
  const failed = job("failed", "223e4567-e89b-42d3-a456-000000000005");
  render(<Queue id="queue" open selection={selection} jobs={[failed]} endpoints={[]} error={null} loading={false}
    {...handlers} onRetry={vi.fn()} retryNotes={{ [failed.id]: { kind: "waiting", count: 2 } }} />);
  expect(screen.getByText("2 элемента ждут сверки каталога")).toBeDefined();
});

test("says that nothing is left to retry when the plan is empty", () => {
  const failed = job("completed", "223e4567-e89b-42d3-a456-000000000008");
  render(<Queue id="queue" open selection={selection} jobs={[failed]} endpoints={[]} error={null} loading={false}
    {...handlers} onRetry={vi.fn()} retryNotes={{ [failed.id]: { kind: "nothing" } }} />);
  expect(screen.getByText("Повторять нечего")).toBeDefined();
});

test("hides retry on a finished job with nothing unfinished in its items", () => {
  const finished = { ...job("completed", "223e4567-e89b-42d3-a456-000000000009"),
    items: [{ outcome: "done", error: null }, { outcome: "skipped", error: "Skipped by the owner" }] } as JobView;
  render(<Queue id="queue" open selection={selection} jobs={[finished]} endpoints={[]} error={null} loading={false}
    {...handlers} onRetry={vi.fn()} />);
  expect(screen.queryByRole("button", { name: "Повторить невыполненное" })).toBeNull();
});

test("offers retry on a finished job whose skipped item waits on a parent directory", () => {
  const finished = { ...job("failed", "223e4567-e89b-42d3-a456-00000000000a"),
    items: [{ outcome: "done", error: null }, { outcome: "skipped", error: parentSkipNote }] } as JobView;
  render(<Queue id="queue" open selection={selection} jobs={[finished]} endpoints={[]} error={null} loading={false}
    {...handlers} onRetry={vi.fn()} />);
  expect(screen.getByRole("button", { name: "Повторить невыполненное" })).toBeDefined();
});

test("the temporary-name hint gives each unknown item its own path: root, nested, and none for other outcomes", async () => {
  const { tempNameHint } = await import("./queue.tsx");
  const { parsePosix } = await import("../core/path.ts");
  const id = "323e4567-e89b-42d3-a456-426614174000";
  const batch = (paths: string[], outcomes: string[], kind: "rename" | "copy" = "rename") => ({
    id,
    plan: {
      kind,
      items: paths.map((path, index) => ({
        source: { endpoint: "host:x", path: parsePosix(path) },
        target: { endpoint: "host:x", path: parsePosix("/t" + index) },
        kind: "file",
      })),
    },
    items: outcomes.map((outcome) => ({ outcome, error: null })),
  } as unknown as Parameters<typeof tempNameHint>[0]);
  // Index 0 sits in the root, index 1 in /d: the joined paths have no double slash.
  expect(tempNameHint(batch(["/a.txt", "/d/b.txt"], ["unknown", "unknown"]))).toBe(
    "Файлы могли остаться под временными именами: /.commander-323e4567-e89b-42d3-a456-426614174000-0.part, /d/.commander-323e4567-e89b-42d3-a456-426614174000-1.part. Проверьте каталоги: если исходного имени нет, переименуйте файл вручную.",
  );
  expect(tempNameHint(batch(["/a.txt", "/d/b.txt"], ["done", "unknown"]))).toBe(
    "Файлы могли остаться под временными именами: /d/.commander-323e4567-e89b-42d3-a456-426614174000-1.part. Проверьте каталоги: если исходного имени нет, переименуйте файл вручную.",
  );
  expect(tempNameHint(batch(["/a.txt", "/d/b.txt"], ["done", "failed"]))).toBeNull();
  expect(tempNameHint(batch(["/a.txt"], ["unknown"]))).toBeNull();
});

test("a finished batch with pending items says they were returned, not renamed; a running or single rename does not", async () => {
  const { returnedPendingNote } = await import("./queue.tsx");
  const job = (state: string, outcomes: string[], kind: "rename" | "copy" = "rename", count = outcomes.length) => ({
    state,
    plan: { kind, items: Array.from({ length: count }, () => ({})) },
    items: outcomes.map((outcome) => ({ outcome, error: null })),
  } as unknown as Parameters<typeof returnedPendingNote>[0]);
  expect(returnedPendingNote(job("failed", ["failed", "pending"]))).toBe(true);
  expect(returnedPendingNote(job("cancelled", ["pending", "pending"]))).toBe(true);
  expect(returnedPendingNote(job("running", ["done", "pending"]))).toBe(false);
  expect(returnedPendingNote(job("completed", ["done", "done"]))).toBe(false);
  expect(returnedPendingNote(job("failed", ["pending"], "rename", 1))).toBe(false);
});

// --- S14a: a job that waits for the owner to confirm the copy of its archive ---

function archiveJob(state: string, withArchive = true): JobView {
  const base = job(state, "323e4567-e89b-42d3-a456-426614174000") as OperationJob & JobView;
  return {
    ...base,
    error: { code: "consent_required", reason: "archive_copy", message: "The archive must be estimated again", retryable: false },
    plan: { ...base.plan, sourceEndpoint: withArchive ? "archive:123e4567-e89b-42d3-a456-426614174000" : "host:from" },
  } as JobView;
}
const queueProps = { endpoints: [], error: null, loading: false, onInspect: vi.fn(), onSkip: vi.fn(), onCancel: vi.fn(), open: true, id: "q",
  selection: { count: 0, size: "0 Б", destination: "", fullDestination: "" } };

test("an interrupted or pending archive job says the copy needs confirming and offers the button", () => {
  for (const state of ["interrupted", "pending"]) {
    const onConfirmArchive = vi.fn();
    const view = render(<Queue {...queueProps} jobs={[archiveJob(state)]} onConfirmArchive={onConfirmArchive} />);
    expect(screen.getByText("Нужно подтверждение копии архива")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Подтвердить копию" }));
    expect(onConfirmArchive).toHaveBeenCalledTimes(1);
    expect(onConfirmArchive.mock.calls[0]![0]).toMatchObject({ state });
    view.unmount();
  }
});

test("the confirm button is absent without the wiring, and for an ordinary job with another error", () => {
  render(<Queue {...queueProps} jobs={[archiveJob("interrupted")]} />);
  expect(screen.queryByRole("button", { name: "Подтвердить копию" })).toBeNull();
  cleanup();
  const failed = { ...job("failed", "423e4567-e89b-42d3-a456-426614174000"), error: { code: "internal", message: "x", retryable: false } } as JobView;
  render(<Queue {...queueProps} jobs={[failed]} onConfirmArchive={vi.fn()} />);
  expect(screen.queryByRole("button", { name: "Подтвердить копию" })).toBeNull();
});
