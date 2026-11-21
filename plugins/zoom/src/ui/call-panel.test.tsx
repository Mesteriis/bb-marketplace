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

function setup() {
  const onClose = vi.fn();
  const openExternal = vi.fn();
  render(<CallPanel call={CALL} callPageUrl="/call" title="Планёрка" onClose={onClose} openExternal={openExternal} />);
  const frame = screen.getByTitle("Звонок Zoom") as HTMLIFrameElement;
  const target = frame.contentWindow!;
  const posted = vi.spyOn(target, "postMessage").mockImplementation(() => undefined);
  const say = (data: unknown, source: Window | null = target) =>
    act(() => {
      window.dispatchEvent(new MessageEvent("message", { data, source }));
    });
  return { onClose, openExternal, posted, say };
}

describe("CallPanel", () => {
  it("hands the meeting to the page once it is ready", () => {
    const { posted, say } = setup();
    say({ type: "zoom-call:ready" });
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
      "Демонстрация экрана недоступна: BB не даёт встроенным страницам захватывать экран (NotSupportedError). Откройте встречу в приложении Zoom.",
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
    ["camera", "NotAllowedError", "Камера недоступна (NotAllowedError). Проверьте доступ: Системные настройки → Конфиденциальность и безопасность → Камера → bb."],
    ["microphone", "NotAllowedError", "Микрофон недоступен (NotAllowedError). Проверьте доступ: Системные настройки → Конфиденциальность и безопасность → Микрофон → bb."],
    ["camera", "NotFoundError", "Камера недоступна (NotFoundError): устройство не найдено."],
    ["camera", "NotReadableError", "Камера недоступна (NotReadableError): её занимает другое приложение."],
    ["microphone", "AbortError", "Микрофон недоступен (AbortError)."],
  ])("describes %s with %s", (kind, name, text) => {
    expect(mediaProblemText(kind, name)).toBe(text);
  });

  it("ignores a report with an unknown kind", () => {
    const { say } = setup();
    say({ type: "zoom-call:media-error", kind: "telepathy", name: "X" });
    expect(screen.queryByRole("status")).toBeNull();
  });
});
