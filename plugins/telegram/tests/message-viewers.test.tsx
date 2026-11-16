// @vitest-environment jsdom
import { fireEvent, render, screen, within } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { MessageViewers } from "../src/ui/message-viewers.tsx";

test("opens the viewer list on demand and re-queries on reopen", async () => {
  const load = vi.fn(() => Promise.resolve([{ id: "7", name: "Fixture Viewer", viewedAt: 1700000001 }]));
  render(<MessageViewers chatId="-42" messageId="127" load={load} />);
  const trigger = screen.getByRole("button", { name: "Who viewed this message" });
  expect(load).not.toHaveBeenCalled();
  fireEvent.click(trigger);
  const list = await screen.findByRole("list", { name: "Message viewers" });
  expect(within(list).getByText(/^Fixture Viewer/)).toBeTruthy();
  expect(list.querySelector("time")?.dateTime).toBe("2023-11-14T22:13:21.000Z");
  fireEvent.click(trigger);
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
  fireEvent.click(button);
  await target.findByRole("list", { name: "Message viewers" });

  rerender(history(["126", "127", "128", "129"]));
  expect(target.getAllByRole("button", { name: "Who viewed this message" })).toEqual([button]);
  expect(target.getByRole("list", { name: "Message viewers" })).toBeTruthy();
  expect(load.mock.calls).toEqual([["-42", "127"]]);
});
