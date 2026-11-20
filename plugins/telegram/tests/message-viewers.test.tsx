// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { MessageViewers, MessageViewerScope } from "../src/ui/message-viewers.tsx";

afterEach(cleanup);

function mockViewerDialog(trigger: HTMLElement) {
  const dialog = document.getElementById(trigger.getAttribute("aria-controls")!) as HTMLDialogElement;
  dialog.showModal = () => { dialog.open = true; };
  dialog.close = () => { dialog.open = false; };
}

test("opens the viewer list on demand and re-queries on reopen", async () => {
  const load = vi.fn(() => Promise.resolve([{ id: "7", name: "Fixture Viewer", viewedAt: 1700000001 }]));
  render(<MessageViewers chatId="-42" messageId="127" load={load} />);
  const trigger = screen.getByRole("button", { name: "Who viewed this message" });
  mockViewerDialog(trigger);
  expect(load).not.toHaveBeenCalled();
  fireEvent.click(trigger);
  const list = await screen.findByRole("list", { name: "Message viewers" });
  expect(within(list).getByText(/^Fixture Viewer/)).toBeTruthy();
  expect(list.querySelector("time")?.dateTime).toBe("2023-11-14T22:13:21.000Z");
  fireEvent.click(screen.getByRole("button", { name: "Close viewers" }));
  expect(screen.queryByRole("list", { name: "Message viewers" })).toBeNull();
  fireEvent.click(trigger);
  await screen.findByRole("list", { name: "Message viewers" });
  expect(load.mock.calls).toEqual([["-42", "127"], ["-42", "127"]]);
});

test("keeps a single viewer button and the open list across history updates", async () => {
  const load = vi.fn(() => Promise.resolve([{ id: "7", name: "Fixture Viewer", viewedAt: 1700000001 }]));
  const history = (ids: string[]) => <ol>{ids.map((id) => <li key={id} data-testid={`message-${id}`}>
    <div className="mtg-message-viewer-slot"><MessageViewers chatId="-42" messageId={id} load={load} /></div>
  </li>)}</ol>;
  const { rerender } = render(history(["127", "128"]));
  const target = within(screen.getByTestId("message-127"));
  const button = target.getByRole("button", { name: "Who viewed this message" });
  mockViewerDialog(button);
  fireEvent.click(button);
  await target.findByRole("list", { name: "Message viewers" });

  rerender(history(["126", "127", "128", "129"]));
  expect(target.getAllByRole("button", { name: "Who viewed this message" })).toEqual([button]);
  expect(target.getByRole("list", { name: "Message viewers" })).toBeTruthy();
  expect(load.mock.calls).toEqual([["-42", "127"]]);
});

test("keeps a stale viewer profile in the dialog and cancels a pending open on close", async () => {
  let finish!: (opened: boolean) => void;
  const openViewer = vi.fn<(chatId: string, messageId: string, userId: string, signal: AbortSignal) => Promise<boolean>>()
    .mockResolvedValueOnce(false).mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
  render(<MessageViewerScope openViewer={openViewer}><MessageViewers chatId="-42" messageId="127"
    load={async () => [{ id: "7", name: "Fixture Viewer", viewedAt: 1700000001 }]} /></MessageViewerScope>);
  const trigger = screen.getByRole("button", { name: "Who viewed this message" });
  mockViewerDialog(trigger);
  fireEvent.click(trigger);
  const profile = await screen.findByRole("button", { name: "Open profile of Fixture Viewer" });
  fireEvent.click(profile);
  await screen.findByText(/The read receipt or profile may no longer be available/);
  expect(openViewer.mock.calls[0]?.slice(0, 3)).toEqual(["-42", "127", "7"]);
  fireEvent.click(profile);
  fireEvent.click(screen.getByRole("button", { name: "Close viewers" }));
  expect(openViewer.mock.calls[1]?.[3].aborted).toBe(true);
  expect(document.activeElement).toBe(trigger);
  await act(async () => finish(true));
  expect(screen.queryByRole("dialog")).toBeNull();
});
