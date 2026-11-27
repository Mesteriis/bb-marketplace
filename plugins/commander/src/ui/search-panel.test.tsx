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
    content: { text: "needle", caseSensitive: false } })]]);
  expect(screen.getByText(/181/)).toBeTruthy();
  fireEvent.click(confirm);
  expect(start.mock.calls[1][0]).toMatchObject({ kind: "search", root, estimateId: id });
  await screen.findByText("Результаты устарели. Запустите поиск снова.");
});
