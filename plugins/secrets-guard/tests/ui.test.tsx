import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { GuardView } from "../src/core/service.ts";
import { GuardButton } from "../src/ui/guard-button.tsx";
import { GuardPopup } from "../src/ui/guard-popup.tsx";

const closed: GuardView = { configured: true, local: true, effective: null };
const openTree: GuardView = {
  configured: true,
  local: true,
  effective: { scope: "tree", until: 2440, rootThreadId: "a" },
};
const noop = () => {};

function button(view: GuardView | null, now = 1000, problem: string | null = null) {
  return renderToStaticMarkup(<GuardButton view={view} now={now} problem={problem} onOpen={noop} />);
}

function popup(view: GuardView | null, extra: { error?: string | null; busy?: boolean } = {}) {
  return renderToStaticMarkup(
    <GuardPopup
      view={view}
      now={1000}
      busy={extra.busy ?? false}
      error={extra.error ?? null}
      onOpen={noop}
      onClose={noop}
    />,
  );
}

describe("GuardButton", () => {
  it("is a closed lock without a timer when nothing is open", () => {
    const html = button(closed);
    expect(html).toContain('aria-label="Секреты: Закрыто"');
    expect(html).toContain('data-state="closed"');
    expect(html).not.toContain('disabled=""');
    expect(html).not.toContain(" м<");
  });
  it("shows the remaining minutes and names the scope when open", () => {
    const html = button(openTree);
    expect(html).toContain('data-state="open"');
    expect(html).toContain("24 м");
    expect(html).toContain('title="Открыто: этот чат и субтреды, осталось 24 мин"');
  });
  it("falls back to closed once the deadline has passed", () => {
    expect(button(openTree, 2440)).toContain('data-state="closed"');
  });
  it("is inactive with an explanation when the marker location is missing", () => {
    const html = button({ configured: false, local: true, effective: null });
    expect(html).toContain('disabled=""');
    expect(html).toContain('title="Укажите файл отметки в настройках плагина"');
  });
  it("is inactive on a thread that runs on another machine", () => {
    const html = button({ configured: true, local: false, effective: null });
    expect(html).toContain('disabled=""');
    expect(html).toContain('title="Охрана настраивается только на этом Mac"');
  });
  it("is inactive until the state is known", () => {
    const html = button(null);
    expect(html).toContain('disabled=""');
    expect(html).toContain('data-state="closed"');
  });
});

describe("when the state could not be read", () => {
  it("the button is inactive and says so", () => {
    const html = button(null, 1000, "Состояние охраны неизвестно: сервер не ответил");
    expect(html).toContain('disabled=""');
    expect(html).toContain('title="Состояние охраны неизвестно: сервер не ответил"');
  });
  it("the window shows the problem instead of loading forever", () => {
    const html = popup(null, { error: "Состояние охраны неизвестно: сервер не ответил" });
    expect(html).toContain('role="alert">Состояние охраны неизвестно: сервер не ответил');
    expect(html).not.toContain("Загрузка");
    expect(html).not.toContain("10 мин");
  });
});

describe("GuardPopup", () => {
  it("offers three scopes with this chat selected, and three terms", () => {
    const html = popup(closed);
    expect(html).toContain("Этот чат");
    expect(html).toContain("Этот чат и субтреды");
    expect(html).toContain("Глобально");
    expect(html.match(/type="radio"/g)).toHaveLength(3);
    expect(html).toMatch(/<input[^>]*checked=""[^>]*value="thread"|<input[^>]*value="thread"[^>]*checked=""/);
    expect(html).toContain("10 мин");
    expect(html).toContain("30 мин");
    expect(html).toContain("60 мин");
    expect(html).not.toContain("Закрыть");
  });
  it("shows the status and a close button when open", () => {
    const html = popup(openTree);
    expect(html).toContain("Открыто: этот чат и субтреды, осталось 24 мин");
    expect(html).toContain("Закрыть");
  });
  it("preselects the scope that is open", () => {
    expect(popup(openTree)).toMatch(/<input[^>]*checked=""[^>]*value="tree"|<input[^>]*value="tree"[^>]*checked=""/);
  });
  it("explains instead of offering terms when the marker location is missing", () => {
    const html = popup({ configured: false, local: true, effective: null });
    expect(html).toContain("Укажите файл отметки в настройках плагина");
    expect(html).not.toContain("10 мин");
  });
  it("explains a thread on another machine", () => {
    const html = popup({ configured: true, local: false, effective: null });
    expect(html).toContain("Охрана настраивается только на этом Mac");
    expect(html).not.toContain("10 мин");
  });
  it("shows a refusal from the server", () => {
    expect(popup(closed, { error: "Файл отметки недоступен для записи" })).toContain(
      'role="alert">Файл отметки недоступен для записи',
    );
  });
  it("disables the controls while a request is running", () => {
    const html = popup(openTree, { busy: true });
    expect(html.match(/<button[^>]*disabled=""/g)).toHaveLength(4);
  });
});
