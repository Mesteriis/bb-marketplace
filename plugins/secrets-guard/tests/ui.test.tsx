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

function popup(
  view: GuardView | null,
  extra: { error?: string | null; busy?: boolean; layout?: "fit" | "fill" } = {},
) {
  return renderToStaticMarkup(
    <GuardPopup
      layout={extra.layout}
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
    expect(html).toContain('data-guard="closed"');
    expect(html).not.toContain('disabled=""');
    expect(html).not.toContain(" м<");
    expect(html).not.toContain("bg-warning");
  });
  it("shows the remaining minutes and names the scope when open", () => {
    const html = button(openTree);
    expect(html).toContain('data-guard="open"');
    expect(html).toContain("24 м");
    expect(html).toContain("bg-warning");
    expect(html).toContain("whitespace-nowrap");
    expect(html).toContain('title="Открыто: этот чат и субтреды, осталось 24 мин"');
  });
  it("falls back to closed once the deadline has passed", () => {
    expect(button(openTree, 2440)).toContain('data-guard="closed"');
  });
  it("is inactive with an explanation when the marker location is missing", () => {
    const html = button({ configured: false, local: true, effective: null });
    expect(html).toContain('disabled=""');
    expect(html).toContain('title="Охрана не найдена: хук охраны Claude Code ещё не создал указатель. Запустите любой тред Claude Code или укажите файл отметки в настройках плагина"');
  });
  it("is inactive on a thread that runs on another machine", () => {
    const html = button({ configured: true, local: false, effective: null });
    expect(html).toContain('disabled=""');
    expect(html).toContain('title="Охрана настраивается только на этом Mac"');
  });
  it("is inactive until the state is known", () => {
    const html = button(null);
    expect(html).toContain('disabled=""');
    expect(html).toContain('data-guard="closed"');
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
    expect(html).toContain('role="alert"');
    expect(html).toContain("Состояние охраны неизвестно: сервер не ответил");
    expect(html).not.toContain("Загрузка");
    expect(html).not.toContain("10 мин");
  });
});

describe("GuardPopup", () => {
  it("closed: scope segments under «Кому», three terms under «Открыть на», nothing else", () => {
    const html = popup(closed);
    expect(html).toContain('role="radiogroup"');
    expect(html).toContain('aria-label="Охват"');
    expect(html.match(/role="radio"/g)).toHaveLength(3);
    expect(html).toContain("Кому");
    expect(html).toContain("Открыть на");
    expect(html).toContain("Этот чат");
    expect(html).toContain("С субтредами");
    expect(html).toContain("Глобально");
    expect(html).toContain("10 мин");
    expect(html).toContain("30 мин");
    expect(html).toContain("60 мин");
    expect(html).not.toContain("Закрыть");
    expect(html).not.toContain("Продлить на");
    expect(html).not.toContain('role="progressbar"');
  });
  it("has no radio dots and no «Открыто: …» line any more", () => {
    const html = popup(openTree);
    expect(html).not.toContain('type="radio"');
    expect(html).not.toContain("Открыто:");
  });
  it("selects this chat by default and keeps one segment in the tab order", () => {
    const html = popup(closed);
    expect(html).toMatch(/<button[^>]*aria-checked="true"[^>]*data-scope="thread"/);
    expect(html.match(/aria-checked="true"/g)).toHaveLength(1);
    expect(html.match(/role="radio"[^>]*tabindex="0"/g)).toHaveLength(1);
    expect(html.match(/role="radio"[^>]*tabindex="-1"/g)).toHaveLength(2);
  });
  it("open: status line, a quiet close button, the remaining bar and «Продлить на»", () => {
    const html = popup(openTree);
    expect(html).toContain("Открыто ещё 24 мин");
    expect(html).toContain("· с субтредами");
    expect(html).toContain("Закрыть");
    expect(html).toContain("Продлить на");
    expect(html).not.toContain("Открыть на");
    expect(html).toMatch(/role="progressbar"[^>]*aria-valuenow="24"/);
    expect(html).toMatch(/role="progressbar"[^>]*aria-valuemax="60"/);
    expect(html).toContain("width:40%");
  });
  it("names a global opening and a single chat in the status line", () => {
    expect(popup({ configured: true, local: true, effective: { scope: "global", until: 1600, rootThreadId: null } })).toContain(
      "· глобально",
    );
    expect(popup({ configured: true, local: true, effective: { scope: "thread", until: 1600, rootThreadId: "a" } })).toContain(
      "· этот чат",
    );
  });
  it("preselects the scope that is open", () => {
    expect(popup(openTree)).toMatch(/<button[^>]*aria-checked="true"[^>]*data-scope="tree"/);
  });
  it("explains instead of offering terms when the guard is not found", () => {
    const html = popup({ configured: false, local: true, effective: null });
    expect(html).toContain("Охрана не найдена: хук охраны Claude Code ещё не создал указатель.");
    expect(html).not.toContain("10 мин");
    expect(html).not.toContain('role="radiogroup"');
  });
  it("explains a thread on another machine", () => {
    const html = popup({ configured: true, local: false, effective: null });
    expect(html).toContain("Охрана настраивается только на этом Mac");
    expect(html).not.toContain("10 мин");
  });
  it("shows a refusal from the server under the controls", () => {
    const html = popup(closed, { error: "Файл отметки недоступен для записи" });
    expect(html).toContain("Файл отметки недоступен для записи");
    expect(html).toContain('role="alert"');
    expect(html).toContain("10 мин");
  });
  it("disables the terms and the close button while a request is running", () => {
    const html = popup(openTree, { busy: true });
    expect(html.match(/<button[^>]*disabled=""/g)).toHaveLength(4);
    expect(html).toContain('aria-busy="true"');
  });
  it("shows loading until the state is known", () => {
    const html = popup(null);
    expect(html).toContain("Загрузка…");
    expect(html).not.toContain('role="radiogroup"');
  });
});

describe("the two layouts of the window", () => {
  it("is as wide as its content by default, with every segment labelled", () => {
    const html = popup(closed);
    expect(html).toContain('data-layout="fit"');
    expect(html).toContain("w-fit");
    expect(html).not.toContain("@container");
  });
  it("fills the host's window: the segments share the row and stay on one line", () => {
    const html = popup(closed, { layout: "fill" });
    expect(html).toContain('data-layout="fill"');
    expect(html).toContain("@container");
    expect(html).not.toContain("w-fit");
    const group = /<div[^>]*role="radiogroup"[^>]*>/.exec(html)?.[0] ?? "";
    expect(group).toContain("flex-nowrap");
    expect(group).toContain("w-full");
  });
  it("in a narrow host window only the selected segment keeps its label; the others keep their names", () => {
    const html = popup(closed, { layout: "fill" });
    const segment = (scope: string) => new RegExp(`<button[^>]*data-scope="${scope}"[^>]*>.*?</button>`).exec(html)?.[0] ?? "";
    expect(segment("thread")).toContain('<span class="truncate">Этот чат</span>');
    expect(segment("tree")).toContain('<span class="hidden truncate @md:inline">С субтредами</span>');
    expect(segment("global")).toContain('<span class="hidden truncate @md:inline">Глобально</span>');
    expect(segment("tree")).toContain('aria-label="С субтредами"');
    expect(segment("tree")).toContain('title="С субтредами"');
  });
  it("in the content-wide window every segment shows its label", () => {
    const html = popup(closed);
    expect(html).not.toContain("hidden truncate");
  });
});
