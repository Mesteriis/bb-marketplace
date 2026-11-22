// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ZoomMeeting } from "../core/model.ts";
import type { AccountStatus, ZoomPageApi } from "./api.ts";
import { WindowCalls } from "./window-calls";
import { WindowCallLayer } from "../adapters/bb/window-call-layer";
import { ZoomPage } from "./zoom-page.tsx";

afterEach(cleanup);

const ORIGIN = "http://127.0.0.1:38886";
const NOW = Date.parse("2026-11-23T09:00:00Z"); // Monday

const meeting = (id: string, topic: string, startTime: string): ZoomMeeting => ({
  id,
  topic,
  startTime,
  durationMinutes: 30,
  joinUrl: `https://us02web.zoom.us/j/${id}?pwd=p${id}`,
  passcode: `p${id}`,
});

const PREPARED = {
  meetingNumber: "1111111111",
  passcode: "p1",
  userName: "Иван",
  signature: "sig",
  zak: "zak",
  fallbackUrl: "https://zoom.us/j/1111111111?pwd=p1",
};

function setup(status: AccountStatus, meetings: ZoomMeeting[] = []) {
  const api = {
    status: vi.fn(async () => status),
    redirectUri: vi.fn(async (origin: string) => `${origin}/api/v1/plugins/makosh-zoom/http/oauth/callback`),
    beginLogin: vi.fn(async () => ({ authorizeUrl: "https://zoom.us/oauth/authorize?x=1" })),
    disconnect: vi.fn(async () => undefined),
    listMeetings: vi.fn(async () => meetings),
    createMeeting: vi.fn(async () => meeting("9999999999", "Новая", "2026-11-24T10:00:00Z")),
    prepareCall: vi.fn(async () => PREPARED),
    openCallInBrowser: vi.fn(async () => ({ url: "http://127.0.0.1:38886/call?ticket=t", opened: true })),
  } satisfies ZoomPageApi;
  const openExternal = vi.fn();
  const calls = new WindowCalls();
  const view = render(
    <><WindowCallLayer calls={calls} /><ZoomPage calls={calls} api={api} origin={ORIGIN} callPageUrl="/call-page" openExternal={openExternal} refreshKey={0} now={() => NOW} timeZone="UTC" /></>,
  );
  return { api, openExternal, view };
}

const CONNECTED: AccountStatus = { configured: true, connected: true, displayName: "Иван" };

describe("ZoomPage", () => {
  it("explains the setup and blocks sign-in until the app is configured", async () => {
    setup({ configured: false, connected: false, displayName: null });
    expect(await screen.findByText("Подключите аккаунт Zoom")).toBeTruthy();
    expect(await screen.findByText("http://127.0.0.1:38886/api/v1/plugins/makosh-zoom/http/oauth/callback")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Войти через Zoom" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("opens Zoom's consent page when the app is configured", async () => {
    const { api, openExternal } = setup({ configured: true, connected: false, displayName: null });
    const button = await screen.findByRole("button", { name: "Войти через Zoom" });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(button);
    await waitFor(() => expect(openExternal).toHaveBeenCalledWith("https://zoom.us/oauth/authorize?x=1"));
    expect(api.beginLogin).toHaveBeenCalledWith(ORIGIN);
  });

  it("reloads the account when the host signals a change", async () => {
    const { api, view } = setup({ configured: true, connected: false, displayName: null });
    await screen.findByText("Подключите аккаунт Zoom");
    api.status.mockResolvedValue(CONNECTED);
    view.rerender(
      <ZoomPage calls={new WindowCalls()} api={api} origin={ORIGIN} callPageUrl="/call-page" openExternal={() => undefined} refreshKey={1} now={() => NOW} timeZone="UTC" />,
    );
    expect(await screen.findByRole("button", { name: "Новая встреча" })).toBeTruthy();
  });

  it("shows this week's meetings and moves to the next week", async () => {
    setup(CONNECTED, [meeting("1111111111", "Планёрка", "2026-11-23T10:00:00Z"), meeting("2222222222", "Ретро", "2026-12-01T10:00:00Z")]);
    expect(await screen.findByText("Планёрка")).toBeTruthy();
    expect(screen.getByText("23–29 ноября 2026")).toBeTruthy();
    expect(screen.queryByText("Ретро")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Следующая неделя" }));
    expect(await screen.findByText("Ретро")).toBeTruthy();
    expect(screen.getByText("30 ноября – 6 декабря 2026")).toBeTruthy();
    expect(screen.queryByText("Планёрка")).toBeNull();
  });

  it("starts the owner's meeting as host inside the call panel", async () => {
    const { api } = setup(CONNECTED, [meeting("1111111111", "Планёрка", "2026-11-23T10:00:00Z")]);
    fireEvent.click(await screen.findByRole("button", { name: "Войти: Планёрка" }));
    const frame = (await screen.findByTitle("Звонок Zoom")) as HTMLIFrameElement;
    expect(frame.getAttribute("src")).toBe("/call-page");
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts allow-same-origin allow-forms allow-popups allow-modals");
    expect(api.prepareCall).toHaveBeenCalledWith({ link: "https://us02web.zoom.us/j/1111111111?pwd=p1111111111", asHost: true });
  });

  it("opens the meeting in the Zoom app when BB has no separate origin for the call page", async () => {
    const api = {
      status: vi.fn(async () => CONNECTED),
      redirectUri: vi.fn(async () => ""),
      beginLogin: vi.fn(async () => ({ authorizeUrl: "" })),
      disconnect: vi.fn(async () => undefined),
      listMeetings: vi.fn(async () => [meeting("1111111111", "Планёрка", "2026-11-23T10:00:00Z")]),
      createMeeting: vi.fn(),
      prepareCall: vi.fn(async () => PREPARED),
    } as unknown as ZoomPageApi;
    const openExternal = vi.fn();
    render(<ZoomPage calls={new WindowCalls()} api={api} origin="https://bb.example.net" callPageUrl={null} openExternal={openExternal} refreshKey={0} now={() => NOW} timeZone="UTC" />);
    fireEvent.click(await screen.findByRole("button", { name: "Войти: Планёрка" }));
    await waitFor(() => expect(openExternal).toHaveBeenCalledWith("https://zoom.us/j/1111111111?pwd=p1"));
    expect(screen.queryByTitle("Звонок Zoom")).toBeNull();
  });

  it("joins a pasted link as a participant and refuses a foreign link", async () => {
    const { api } = setup(CONNECTED);
    const field = await screen.findByLabelText("Ссылка или номер встречи");
    fireEvent.change(field, { target: { value: "https://example.com/j/1234567890" } });
    fireEvent.submit(field.closest("form")!);
    expect((await screen.findByRole("alert")).textContent).toBe("Нужна ссылка Zoom или номер встречи из 9–11 цифр");
    expect(api.prepareCall).not.toHaveBeenCalled();

    fireEvent.change(field, { target: { value: "123 456 7890" } });
    fireEvent.submit(field.closest("form")!);
    await screen.findByTitle("Звонок Zoom");
    expect(api.prepareCall).toHaveBeenCalledWith({ link: "123 456 7890", asHost: false });
  });

  it("moves the call to the system browser and closes the embedded one", async () => {
    const { api, openExternal } = setup(CONNECTED, [meeting("1111111111", "Планёрка", "2026-11-23T10:00:00Z")]);
    fireEvent.click(await screen.findByRole("button", { name: "Войти: Планёрка" }));
    await screen.findByTitle("Звонок Zoom");
    fireEvent.click(await screen.findByRole("button", { name: "В браузере" }));
    await waitFor(() => expect(api.openCallInBrowser).toHaveBeenCalledWith({ link: "https://us02web.zoom.us/j/1111111111?pwd=p1111111111", asHost: true }));
    await waitFor(() => expect(screen.queryByTitle("Звонок Zoom")).toBeNull());
    expect(openExternal).not.toHaveBeenCalled();
  });

  it("opens the link itself when the server could not start a browser", async () => {
    const { api, openExternal } = setup(CONNECTED, [meeting("1111111111", "Планёрка", "2026-11-23T10:00:00Z")]);
    api.openCallInBrowser.mockResolvedValue({ url: "http://127.0.0.1:38886/call?ticket=t", opened: false });
    fireEvent.click(await screen.findByRole("button", { name: "Войти: Планёрка" }));
    await screen.findByTitle("Звонок Zoom");
    fireEvent.click(await screen.findByRole("button", { name: "В браузере" }));
    await waitFor(() => expect(openExternal).toHaveBeenCalledWith("http://127.0.0.1:38886/call?ticket=t"));
  });

  it("shows why joining failed and stays on the calendar", async () => {
    const { api } = setup(CONNECTED, [meeting("1111111111", "Планёрка", "2026-11-23T10:00:00Z")]);
    api.prepareCall.mockRejectedValue(new Error("Нет связи с Zoom"));
    fireEvent.click(await screen.findByRole("button", { name: "Войти: Планёрка" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Нет связи с Zoom");
    expect(screen.queryByTitle("Звонок Zoom")).toBeNull();
  });

  it("offers a retry when the account cannot be loaded", async () => {
    const { api } = setup(CONNECTED);
    api.status.mockRejectedValueOnce(new Error("offline"));
    cleanup();
    render(<ZoomPage calls={new WindowCalls()} api={api} origin={ORIGIN} callPageUrl="/call-page" openExternal={() => undefined} refreshKey={0} now={() => NOW} timeZone="UTC" />);
    fireEvent.click(await screen.findByRole("button", { name: "Повторить" }));
    expect(await screen.findByRole("button", { name: "Новая встреча" })).toBeTruthy();
  });

  it("says so when the week has no meetings", async () => {
    setup(CONNECTED, []);
    expect(await screen.findByText("На этой неделе встреч нет")).toBeTruthy();
  });
});
