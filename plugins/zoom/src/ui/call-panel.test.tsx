// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CallPanel, mediaProblemText } from "./call-panel.tsx";

afterEach(cleanup);

const CALL = {
  meetingNumber: "1111111111",
  passcode: "p1",
  userName: "Иван",
  signature: "sig",
  zak: "zak",
  fallbackUrl: "https://zoom.us/j/1111111111?pwd=p1",
};

const THEME = { background: "#1e1e2e", foreground: "#cdd6f4" };

function setup() {
  const onClose = vi.fn();
  const openExternal = vi.fn();
  const onOpenInBrowser = vi.fn();
  render(
    <CallPanel call={CALL} callPageUrl="/call" title="Планёрка" onClose={onClose} openExternal={openExternal} onOpenInBrowser={onOpenInBrowser} readTheme={() => THEME} />,
  );
  const frame = screen.getByTitle("Звонок Zoom") as HTMLIFrameElement;
  const target = frame.contentWindow!;
  const posted = vi.spyOn(target, "postMessage").mockImplementation(() => undefined);
  const say = (data: unknown, source: Window | null = target) =>
    act(() => {
      window.dispatchEvent(new MessageEvent("message", { data, source }));
    });
  return { onClose, openExternal, onOpenInBrowser, posted, say };
}

describe("CallPanel", () => {
  it("hands the meeting to the page once it is ready", () => {
    const { posted, say } = setup();
    say({ type: "zoom-call:ready" });
    expect(posted).toHaveBeenNthCalledWith(1, { type: "zoom-call:theme", colors: THEME }, "*");
    expect(posted).toHaveBeenCalledWith(
      { type: "zoom-call:join", call: { signature: "sig", meetingNumber: "1111111111", passcode: "p1", userName: "Иван", zak: "zak" } },
      "*",
    );
    expect(screen.getByText("Подключаюсь…")).toBeTruthy();
  });

  it("ignores messages that do not come from its own frame", () => {
    const { posted, say, onClose } = setup();
    say({ type: "zoom-call:ready" }, window);
    say({ type: "zoom-call:ended" }, window);
    expect(posted).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("shows Zoom's reason with a numeric or text code and offers the Zoom app", () => {
    const { say, openExternal } = setup();
    say({ type: "zoom-call:error", code: 4011, message: "Meeting SDK app is not published" });
    expect(screen.getByRole("alert").textContent).toBe("Meeting SDK app is not published (код 4011)");
    expect(screen.queryByTitle("Звонок Zoom")).toBeNull();
    const open = screen.getAllByRole("button", { name: "Открыть в Zoom" });
    expect(open).toHaveLength(1);
    open[0]!.click();
    expect(openExternal).toHaveBeenCalledWith("https://zoom.us/j/1111111111?pwd=p1");
  });

  it("falls back to its own words when the page sends none", () => {
    const { say } = setup();
    say({ type: "zoom-call:error" });
    expect(screen.getByRole("alert").textContent).toBe("Zoom отклонил вход (код неизвестен)");
  });

  it("asks the page to leave while in the call and closes when it ends", () => {
    const { say, posted, onClose } = setup();
    say({ type: "zoom-call:joined" });
    act(() => screen.getByRole("button", { name: "Выйти" }).click());
    expect(posted).toHaveBeenLastCalledWith({ type: "zoom-call:leave" }, "*");
    expect(onClose).not.toHaveBeenCalled();
    say({ type: "zoom-call:ended" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("gives up when the page stays silent for 30 seconds", () => {
    vi.useFakeTimers();
    try {
      setup();
      act(() => void vi.advanceTimersByTime(29_999));
      expect(screen.queryByRole("alert")).toBeNull();
      act(() => void vi.advanceTimersByTime(1));
      expect(screen.getByRole("alert").textContent).toBe("Страница звонка не ответила. Проверьте связь с zoom.us");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("media problems", () => {
  it("explains a refused screen capture and keeps the call open", () => {
    const { say } = setup();
    say({ type: "zoom-call:joined" });
    say({ type: "zoom-call:media-error", kind: "screen", name: "NotSupportedError", message: "Not supported" });
    expect(screen.getByRole("status").textContent).toBe(
      "Демонстрация экрана внутри BB не работает: приложение BB не умеет захват экрана (NotSupportedError). Откройте звонок в браузере.",
    );
    expect(screen.getByTitle("Звонок Zoom")).toBeTruthy();
  });

  it("can be dismissed", () => {
    const { say } = setup();
    say({ type: "zoom-call:media-error", kind: "camera", name: "NotAllowedError", message: "Permission denied" });
    act(() => screen.getByRole("button", { name: "Скрыть" }).click());
    expect(screen.queryByRole("status")).toBeNull();
  });

  it.each([
    ["camera", "NotAllowedError", "Камера недоступна (NotAllowedError). Разрешите её для bb: Системные настройки → Конфиденциальность и безопасность → Камера. Или откройте звонок в браузере."],
    ["camera", "NotFoundError", "Камера недоступна (NotFoundError): устройство не найдено."],
    ["camera", "NotReadableError", "Камера недоступна (NotReadableError): её занимает другое приложение."],
    ["microphone", "NotAllowedError", "Микрофон недоступен (NotAllowedError). Разрешите его для bb: Системные настройки → Конфиденциальность и безопасность → Микрофон. Или откройте звонок в браузере."],
    ["microphone", "AbortError", "Микрофон недоступен (AbortError)."],
  ])("describes %s with %s", (kind, name, text) => {
    expect(mediaProblemText(kind, name)).toBe(text);
  });

  it("offers the browser from the notice and from the header", () => {
    const { say, onOpenInBrowser } = setup();
    say({ type: "zoom-call:joined" });
    say({ type: "zoom-call:media-error", kind: "camera", name: "NotAllowedError" });
    const buttons = screen.getAllByRole("button", { name: "В браузере" });
    expect(buttons).toHaveLength(2);
    act(() => buttons[0]!.click());
    expect(onOpenInBrowser).toHaveBeenCalledTimes(1);
  });

  it("ignores a report with an unknown kind", () => {
    const { say } = setup();
    say({ type: "zoom-call:media-error", kind: "telepathy", name: "X" });
    expect(screen.queryByRole("status")).toBeNull();
  });
});
