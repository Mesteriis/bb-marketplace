// @vitest-environment jsdom
import { installTestPluginRuntime } from "@get-bb/plugin-sdk/testing/app";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { SearchPanel, type SearchActions } from "./search-panel.tsx";
import { parsePosix } from "../core/path.ts";

installTestPluginRuntime();
afterEach(cleanup);

it("starts SFTP content search only after the user sees and confirms the estimate", async () => {
  const id = "00000000-0000-4000-8000-000000000001";
  const root = { endpoint: "sftp:test", path: parsePosix("/docs") };
  const start = vi.fn<SearchActions["start"]>().mockResolvedValueOnce({
    estimateId: id, bytesPlanned: "181", bytesByEndpoint: [{ endpoint: root.endpoint, bytesPlanned: "181" }],
  }).mockResolvedValueOnce({
    id, kind: "search", initiator: { kind: "owner" }, endpoints: [root.endpoint], state: "running",
    progress: { items: 0, bytes: "0", bytesPlanned: "181" }, partial: false, error: null,
  });
  render(<SearchPanel side="left" active root={root} label="test" api={{ start, get: async () => null, cancel: async () => {} }}
    onFocus={() => {}} onClose={() => {}} onSave={() => {}} onOpen={() => {}} />);
  fireEvent.change(screen.getByLabelText("Содержимое"), { target: { value: "needle" } });
  fireEvent.change(screen.getByLabelText("Лимит чтения, байт"), { target: { value: "1024" } });
  fireEvent.click(screen.getByRole("button", { name: "Оценить чтение" }));
  const confirm = await screen.findByRole("button", { name: "Подтвердить и искать" });
  expect(start.mock.calls).toEqual([[expect.objectContaining({ estimateOnly: true,
    content: { text: "needle", caseSensitive: false } }), expect.any(AbortSignal)]]);
  expect(screen.getByText(/181/)).toBeTruthy();
  fireEvent.click(confirm);
  expect(start.mock.calls[1][0]).toMatchObject({ kind: "search", root, estimateId: id });
  await screen.findByText("Результаты устарели. Запустите поиск снова.");
});

const root = { endpoint: "sftp:test", path: parsePosix("/docs") };
const savedId = "00000000-0000-4000-8000-000000000002";
const savedJob: NonNullable<Awaited<ReturnType<SearchActions["get"]>>>["job"] = {
  id: savedId, kind: "search", initiator: { kind: "owner" }, endpoints: [root.endpoint], state: "done",
  progress: { items: 1, bytes: "0", bytesPlanned: null }, partial: false, error: null,
};

it.each<{ state: string; reply: Awaited<ReturnType<SearchActions["get"]>> }>([
  { state: "missing scan", reply: null },
  { state: "expired result", reply: { job: savedJob, result: null, reason: "result_expired" } },
])("explains how to recover a saved panel with a $state", async ({ reply }) => {
  const get = vi.fn<SearchActions["get"]>().mockResolvedValue(reply);
  render(<SearchPanel side="left" active root={root} label="test" savedId={savedId}
    api={{ start: vi.fn(), get, cancel: vi.fn() }} onFocus={() => {}} onClose={() => {}} onSave={() => {}} onOpen={() => {}} />);
  expect(await screen.findByText("Результаты устарели. Запустите поиск снова.")).toBeTruthy();
  expect(get.mock.calls).toEqual([[savedId]]);
});

it.each(["Отменить поиск", "Закрыть поиск"])("aborts pending SFTP estimate through «%s»", async (button) => {
  const start = vi.fn((..._args: unknown[]) => new Promise<never>(() => {}));
  const onClose = vi.fn();
  render(<SearchPanel side="left" active root={root} label="test"
    api={{ start, get: vi.fn(), cancel: vi.fn() }} onFocus={() => {}} onClose={onClose} onSave={() => {}} onOpen={() => {}} />);
  fireEvent.change(screen.getByLabelText("Содержимое"), { target: { value: "needle" } });
  fireEvent.change(screen.getByLabelText("Лимит чтения, байт"), { target: { value: "1024" } });
  fireEvent.click(screen.getByRole("button", { name: "Оценить чтение" }));
  fireEvent.click(screen.getByRole("button", { name: button }));
  expect(start.mock.calls[0][1]).toMatchObject({ aborted: true });
  expect(onClose).toHaveBeenCalledTimes(button === "Закрыть поиск" ? 1 : 0);
});
