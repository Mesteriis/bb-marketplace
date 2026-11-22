// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { EmbedOverlay } from "./embed-overlay";
import { CallAnchor } from "../../ui/call-anchor";
import { WindowCalls } from "../../ui/window-calls";

const ref = "12345678-1234-4123-8123-123456789abc";
const address = { version: "chertog.embed.v1", provider: "zoom-call", instanceId: "view-1", generation: 1 };
const meeting = {
  id: "1111111111",
  topic: "Проверка",
  startTime: null,
  durationMinutes: 30,
  passcode: "secret",
  joinUrl: "https://zoom.us/j/1111111111?pwd=secret",
};
afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});
function fixture(calls = new WindowCalls()) {
  document.body.innerHTML =
    '<section data-chertog-embed-layer="v1"><div data-live-host="view-1"><div data-chertog-embed-target="v1" data-provider="zoom-call" data-instance-id="view-1" data-generation="1"></div></div></section>';
  const target = document.querySelector<HTMLDivElement>("[data-chertog-embed-target]")!;
  const messages: unknown[] = [];
  target.addEventListener("chertog.embed.v1.owner", (e) => messages.push((e as CustomEvent).detail));
  document.addEventListener("chertog.embed.v1.query", (e) => messages.push((e as CustomEvent).detail), { once: true });
  const api = {
    list: vi.fn(async () => [meeting]),
    select: vi.fn(async () => ref),
    resolve: vi.fn(async () => ({ id: meeting.id, topic: meeting.topic })),
    prepare: vi.fn(async () => ({
      meetingNumber: meeting.id,
      passcode: "secret",
      signature: "signature",
      zak: "zak",
      userName: "Test",
      fallbackUrl: meeting.joinUrl,
    })),
  };
  const view = render(<EmbedOverlay api={api} calls={calls} url="http://localhost:38886/call" openExternal={() => {}} />);
  const host = (fields: Record<string, unknown>, node = target) =>
    act(() => {
      node.dispatchEvent(new CustomEvent("chertog.embed.v1.host", { bubbles: true, detail: { ...address, ...fields } }));
    });
  return { target, messages, api, view, host };
}

it("confirms selection on the same generation; restores only an invitation", async () => {
  const { target, messages, api, host, view } = fixture();
  expect(messages).toEqual([{ version: "chertog.embed.v1", provider: "zoom-call", kind: "query" }]);
  host({ kind: "announce", mode: "choose" });
  expect(messages.at(-1)).toEqual({ ...address, kind: "choosing" });
  fireEvent.click(await screen.findByRole("button", { name: "Проверка" }));
  await waitFor(() => expect(messages.at(-1)).toEqual({ ...address, kind: "selected", resourceRef: ref }));
  host({ kind: "announce", generation: 2, resourceRef: ref });
  host({ kind: "announce", resourceRef: "12345678-1234-4123-8123-123456789abd" });
  expect(api.resolve).not.toHaveBeenCalled();
  host({ kind: "announce", resourceRef: ref });
  expect(await screen.findByRole("button", { name: "Войти в звонок" })).toBeTruthy();
  expect(messages.at(-1)).toEqual({ ...address, kind: "ready" });
  host({ kind: "announce", resourceRef: ref });
  expect(api.resolve).toHaveBeenCalledTimes(1);
  expect(api.prepare).not.toHaveBeenCalled();
  host({ kind: "release" });
  host({ kind: "announce", resourceRef: ref });
  expect(screen.queryByRole("button")).toBeNull();
  target.dataset.generation = "2";
  host({ kind: "announce", generation: 2, resourceRef: ref });
  await screen.findByRole("button", { name: "Войти в звонок" });
  expect(api.prepare).not.toHaveBeenCalled();
  view.unmount();
  expect(messages.at(-1)).toEqual({ ...address, generation: 2, kind: "revoked" });
});

it("retains one iframe and its parent through visibility, keep and hide; waits for the one confirmed leave", async () => {
  const { messages, api, host } = fixture();
  host({ kind: "announce", resourceRef: ref });
  fireEvent.click(await screen.findByRole("button", { name: "Войти в звонок" }));
  const frame = (await screen.findByTitle("Звонок Zoom")) as HTMLIFrameElement;
  fireEvent.load(frame);
  const parent = frame.parentElement;
  const posted = vi.spyOn(frame.contentWindow!, "postMessage").mockImplementation(() => {});
  const say = (type: string) =>
    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          data: { type },
          source: frame.contentWindow,
          origin: "http://localhost:38886",
        }),
      );
    });
  say("zoom-call:ready");
  say("zoom-call:ready");
  say("zoom-call:joined");
  host({ kind: "visibility", visible: false });
  host({ kind: "visibility", visible: true });
  host({ kind: "close" });
  fireEvent.click(screen.getByRole("button", { name: "Оставить" }));
  expect(messages.at(-1)).toEqual({ ...address, kind: "keep" });
  host({ kind: "close" });
  fireEvent.click(screen.getByRole("button", { name: "Скрыть" }));
  expect(messages.at(-1)).toEqual({ ...address, kind: "hide" });
  host({ kind: "visibility", visible: false });
  host({ kind: "visibility", visible: true });
  expect(screen.getByTitle("Звонок Zoom")).toBe(frame);
  expect(frame.parentElement).toBe(parent);
  expect(api.prepare).toHaveBeenCalledTimes(1);
  host({ kind: "close" });
  host({ kind: "close" });
  fireEvent.click(screen.getByRole("button", { name: "Выйти из встречи" }));
  host({ kind: "close" });
  expect(posted.mock.calls.map((c) => c[0].type)).toEqual(["zoom-call:theme", "zoom-call:join", "zoom-call:leave"]);
  expect(messages).not.toContainEqual({ ...address, kind: "ended" });
  say("zoom-call:ended");
  expect(messages.at(-1)).toEqual({ ...address, kind: "ended" });
  host({ kind: "release" });
  expect(screen.queryByTitle("Звонок Zoom")).toBeNull();
});

it("discards a late selection after cancellation or replacement of the target", async () => {
  const { api, target, host, messages } = fixture();
  let done!: (ref: string) => void;
  api.select.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        done = resolve;
      }),
  );
  host({ kind: "announce", mode: "choose" });
  fireEvent.click(await screen.findByRole("button", { name: "Проверка" }));
  fireEvent.click(screen.getByRole("button", { name: "Отмена" }));
  expect(messages.at(-1)).toEqual({ ...address, kind: "cancelled" });
  host({ kind: "release" });
  const copy = target.cloneNode(false) as HTMLDivElement;
  target.replaceWith(copy);
  host({ kind: "announce", resourceRef: ref }, copy);
  await act(async () => done(ref));
  expect(api.resolve).not.toHaveBeenCalled();
  expect(messages.at(-1)).toEqual({ ...address, kind: "cancelled" });
});

it("refuses an inaccessible restored reference and reports an uncertain call without closing it", async () => {
  const { api, host, target, messages } = fixture();
  api.resolve.mockRejectedValueOnce({ code: "not_found" });
  host({ kind: "announce", resourceRef: ref });
  await waitFor(() => expect(messages.at(-1)).toEqual({ ...address, kind: "denied" }));
  expect(api.prepare).not.toHaveBeenCalled();
  host({ kind: "release" });
  target.dataset.generation = "2";
  host({ kind: "announce", generation: 2, resourceRef: ref });
  fireEvent.click(await screen.findByRole("button", { name: "Войти в звонок" }));
  const frame = (await screen.findByTitle("Звонок Zoom")) as HTMLIFrameElement;
  act(() => {
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { type: "zoom-call:failed" },
        source: frame.contentWindow,
        origin: "http://localhost:38886",
      }),
    );
  });
  expect(messages.at(-1)).toEqual({ ...address, generation: 2, kind: "lost" });
  host({ kind: "close", generation: 2 });
  expect(screen.getByRole("alertdialog")).toBeTruthy();
  host({ kind: "release", generation: 2 });
  expect(messages).not.toContainEqual({ ...address, generation: 2, kind: "ended" });
});

it("uses the calendar's live meeting and closes only the tile while the calendar view exists", async () => {
  const calls = new WindowCalls();
  const { api, host, messages } = fixture(calls);
  act(() =>
    calls.show(
      {
        call: {
          meetingNumber: meeting.id,
          userName: "Test",
          signature: "sig",
          zak: "zak",
          passcode: null,
          fallbackUrl: meeting.joinUrl,
        },
        title: meeting.topic,
        callPageUrl: "http://localhost:38886/call",
        openExternal: () => {},
      },
      true,
    ),
  );
  const calendar = render(<CallAnchor calls={calls} id={meeting.id} />);
  const frame = screen.getByTitle("Звонок Zoom");
  host({ kind: "announce", resourceRef: ref });
  await waitFor(() => expect(messages.at(-1)).toEqual({ ...address, kind: "ready" }));
  expect(screen.getAllByTitle("Звонок Zoom")).toEqual([frame]);
  host({ kind: "close" });
  expect(messages.at(-1)).toEqual({ ...address, kind: "ended" });
  host({ kind: "release" });
  expect(screen.getByTitle("Звонок Zoom")).toBe(frame);
  expect(api.prepare).not.toHaveBeenCalled();
  calendar.unmount();
  expect(screen.getByTitle("Звонок Zoom")).toBe(frame);
});

it("remembers a release received before the announce and requires a later generation", async () => {
  const { api, host, target } = fixture();
  host({ kind: "release" });
  host({ kind: "announce", resourceRef: ref });
  expect(api.resolve).not.toHaveBeenCalled();
  target.dataset.generation = "2";
  host({ kind: "announce", generation: 2, resourceRef: ref });
  await screen.findByRole("button", { name: "Войти в звонок" });
  expect(api.resolve).toHaveBeenCalledTimes(1);
});

it.each([
  { phase: "before SDK ready", events: [], joins: 0 },
  { phase: "while joining", events: ["zoom-call:ready"], joins: 1 },
  { phase: "after joining", events: ["zoom-call:ready", "zoom-call:joined"], joins: 1 },
])("reports a document replaced $phase as lost and waits for a fresh explicit join", async ({ events, joins }) => {
  const { messages, api, host, target } = fixture();
  host({ kind: "announce", resourceRef: ref });
  fireEvent.click(await screen.findByRole("button", { name: "Войти в звонок" }));
  const frame = (await screen.findByTitle("Звонок Zoom")) as HTMLIFrameElement;
  const source = frame.contentWindow!;
  const posted = vi.spyOn(source, "postMessage").mockImplementation(() => {});
  const say = (type: string) => act(() => {
    window.dispatchEvent(new MessageEvent("message", { data: { type }, source, origin: "http://localhost:38886" }));
  });
  fireEvent.load(frame);
  for (const event of events) say(event);
  fireEvent.load(frame);
  say("zoom-call:ready");
  say("zoom-call:joined");
  expect(posted.mock.calls.filter(([m]) => m.type === "zoom-call:join")).toHaveLength(joins);
  expect(messages.at(-1)).toEqual({ ...address, kind: "lost" });
  expect(screen.queryByText("В звонке")).toBeNull();
  expect(screen.getByText(/войти снова/i)).toBeTruthy();
  host({ kind: "release" });
  target.dataset.generation = "2";
  host({ kind: "announce", generation: 2, resourceRef: ref });
  const rejoin = await screen.findByRole("button", { name: "Войти в звонок" });
  expect(api.prepare).toHaveBeenCalledTimes(1);
  expect(screen.queryByTitle("Звонок Zoom")).toBeNull();
  fireEvent.click(rejoin);
  expect(await screen.findByTitle("Звонок Zoom")).not.toBe(frame);
  expect(api.prepare).toHaveBeenCalledTimes(2);
});

it("adds the calendar browser action to a tile call without replacing its iframe", async () => {
  const calls = new WindowCalls();
  const { host } = fixture(calls);
  host({ kind: "announce", resourceRef: ref });
  fireEvent.click(await screen.findByRole("button", { name: "Войти в звонок" }));
  const frame = await screen.findByTitle("Звонок Zoom");
  const existing = calls.snapshot().get(meeting.id)!;
  expect(screen.queryByRole("button", { name: "В браузере" })).toBeNull();
  const openInBrowser = vi.fn();
  act(() => calls.show({ ...existing, call: { ...existing.call, signature: "fresh" }, openInBrowser }, true));
  render(<CallAnchor calls={calls} id={meeting.id} />);
  expect(screen.getByTitle("Звонок Zoom")).toBe(frame);
  fireEvent.click(await screen.findByRole("button", { name: "В браузере" }));
  await waitFor(() => expect(openInBrowser).toHaveBeenCalledTimes(1));
});
