// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { createConsent } from "../src/core/consent.ts";
import { createStaging } from "../src/core/staging.ts";
import type { PagePort } from "../src/core/transfer.ts";
import { DockPage } from "../src/ui/dock-page.tsx";
import type { DockServices, IsUserAction } from "../src/ui/services.ts";
import { ToolbarAction } from "../src/ui/toolbar-action.tsx";
import { evaluateInDocument, mountFixture, PATH_A, PATH_B, URL_A, URL_B, type Fixture } from "./fixture.ts";

const MARKER = "SYNTHETIC-MARKER-51ab";
const trusted = () => true;

let fixture: Fixture | null = null;

afterEach(() => {
  cleanup();
  fixture?.dispose();
  fixture = null;
});

function makeServices(): DockServices & { copied: string[]; notes: string[] } {
  const copied: string[] = [];
  const notes: string[] = [];
  return {
    staging: createStaging(),
    consent: createConsent(),
    async copyText(text) {
      copied.push(text);
      return true;
    },
    notify: (_kind, message) => void notes.push(message),
    copied,
    notes,
  };
}

const livePage: PagePort = { evaluate: async (expression) => evaluateInDocument(expression) };

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("the ChatGPT page", () => {
  it("starts in the manual mode, names the blocker and offers no sign-in", () => {
    const services = makeServices();
    render(<DockPage services={services} openChatGpt={() => true} isUserAction={trusted} />);

    expect(screen.getByRole("heading", { name: "Режим: ручная вставка" })).toBeTruthy();
    expect(screen.getByRole("note").textContent).toContain("агенты на этом компьютере технически смогут читать вашу переписку");
    expect(screen.queryByRole("button", { name: "Открыть chatgpt.com в BB" })).toBeNull();
    expect((screen.getByRole("button", { name: "Скопировать контекст" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("copies exactly the edited preview, and only on the button", async () => {
    const services = makeServices();
    services.staging.stage({ text: "picked " + MARKER, source: { kind: "message-selection", threadId: "thr_1" } });
    render(<DockPage services={services} openChatGpt={() => true} isUserAction={trusted} />);

    fireEvent.change(screen.getByLabelText("Текст для передачи"), { target: { value: "edited\n" + MARKER } });
    expect(services.copied).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Скопировать контекст" }));
    await settle();

    expect(services.copied).toEqual(["edited\n" + MARKER]);
    expect(screen.getByText(/Источник: Выделенный фрагмент сообщения ассистента/)).toBeTruthy();
  });

  it("ignores clicks the user did not make", async () => {
    const services = makeServices();
    services.staging.stage({ text: MARKER, source: { kind: "manual" } });
    let opened = 0;
    render(<DockPage services={services} openChatGpt={() => (opened += 1) > 0} />);

    // Events dispatched from code are not trusted; the default guard drops them.
    fireEvent.click(screen.getByRole("button", { name: "Скопировать контекст" }));
    fireEvent.click(screen.getByRole("button", { name: "Я понимаю риск: включить встроенный режим" }));
    fireEvent.click(screen.getByRole("button", { name: "Очистить" }));
    await settle();

    expect(services.copied).toEqual([]);
    expect(services.consent.granted()).toBe(false);
    expect(services.staging.get()?.text).toBe(MARKER);
    expect(opened).toBe(0);
  });

  it("turns the embedded mode on and off by the user's click", () => {
    const services = makeServices();
    let opened = 0;
    render(<DockPage services={services} openChatGpt={() => (opened += 1) > 0} isUserAction={trusted} />);

    fireEvent.click(screen.getByRole("button", { name: "Я понимаю риск: включить встроенный режим" }));
    expect(screen.getByRole("heading", { name: "Режим: встроенный ChatGPT" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Открыть chatgpt.com в BB" }));
    expect(opened).toBe(1);
    fireEvent.click(screen.getByRole("button", { name: "Выключить встроенный режим" }));
    expect(services.consent.granted()).toBe(false);
  });
});

describe("the Browser toolbar control", () => {
  function toolbar(
    services: DockServices,
    url: string,
    page: PagePort | null = livePage,
    isUserAction: IsUserAction | undefined = trusted,
  ) {
    let counter = 0;
    return (
      <ToolbarAction
        services={services}
        url={url}
        page={page}
        newNonce={() => "nonce-" + String((counter += 1))}
        {...(isUserAction === undefined ? {} : { isUserAction })}
      />
    );
  }

  it("does not open on a click the user did not make", async () => {
    fixture = mountFixture("textarea", { [PATH_A]: "draft" });
    const evaluations: string[] = [];
    const page: PagePort = {
      evaluate: async (expression) => {
        evaluations.push(expression);
        return evaluateInDocument(expression);
      },
    };
    const services = makeServices();
    services.consent.grant();
    services.staging.stage({ text: MARKER, source: { kind: "manual" } });
    // No `isUserAction`: the default guard is in force, and dispatched events are untrusted.
    render(<ToolbarAction services={services} url={URL_A} page={page} newNonce={() => "nonce"} />);

    fireEvent.click(screen.getByRole("button", { name: "Вставить в ChatGPT…" }));
    await settle();

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(evaluations).toEqual([]);
  });

  it("ignores untrusted clicks on insert, copy and re-choose in an open panel", async () => {
    fixture = mountFixture("textarea", { [PATH_A]: "draft" });
    const services = makeServices();
    services.consent.grant();
    services.staging.stage({ text: MARKER, source: { kind: "manual" } });
    // Only the opening click counts as the user's; everything after it is scripted.
    let allowed = 1;
    render(toolbar(services, URL_A, livePage, (event) => (allowed -= 1) >= 0 && event.nativeEvent instanceof Event));

    fireEvent.click(screen.getByRole("button", { name: "Вставить в ChatGPT…" }));
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Вставить в черновик" }));
    fireEvent.click(screen.getByRole("button", { name: "Скопировать контекст" }));
    fireEvent.click(screen.getByRole("button", { name: "Отмена" }));
    await settle();

    expect(fixture.draft(PATH_A)).toBe("draft");
    expect(services.copied).toEqual([]);
    expect(services.staging.get()?.text).toBe(MARKER);
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
  });

  it("tells the user the result when the toolbar is gone before the page answers", async () => {
    let answer: (value: unknown) => void = () => {};
    const answers: Array<Promise<unknown>> = [
      Promise.resolve({ top: true, origin: "https://chatgpt.com", path: PATH_A, tracked: true }),
      new Promise((resolve) => (answer = resolve)),
    ];
    const slowPage: PagePort = { evaluate: () => answers.shift() ?? Promise.reject(new Error("extra call")) };
    const services = makeServices();
    services.consent.grant();
    services.staging.stage({ text: MARKER, source: { kind: "manual" } });
    const view = render(toolbar(services, URL_A, slowPage));

    fireEvent.click(screen.getByRole("button", { name: "Вставить в ChatGPT…" }));
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Вставить в черновик" }));
    view.unmount();
    answer({ status: "not-json-we-know" });
    await settle();

    expect(services.staging.get()).toBeNull();
    expect(services.notes).toEqual([
      "Результат вставки неизвестен: страница не ответила. Проверьте черновик перед повтором.",
    ]);
  });

  it("is absent until the embedded mode is on, and absent on other sites", () => {
    const services = makeServices();
    const view = render(toolbar(services, URL_A));
    expect(screen.queryByRole("button", { name: "Вставить в ChatGPT…" })).toBeNull();

    act(() => services.consent.grant());
    expect(screen.getByRole("button", { name: "Вставить в ChatGPT…" })).toBeTruthy();

    view.rerender(toolbar(services, "https://example.com/c/aaaaaaaa-0000-4000-8000-00000000000a"));
    expect(screen.queryByRole("button", { name: "Вставить в ChatGPT…" })).toBeNull();
  });

  it("shows the text and the conversation, then appends once and clears the staged text", async () => {
    fixture = mountFixture("contenteditable", { [PATH_A]: "old draft", [PATH_B]: "other" });
    const services = makeServices();
    services.consent.grant();
    services.staging.stage({ text: MARKER, source: { kind: "message-selection", threadId: "thr_1" } });
    render(toolbar(services, URL_A));

    fireEvent.click(screen.getByRole("button", { name: "Вставить в ChatGPT…" }));
    await settle();
    expect(screen.getByRole("status").textContent).toContain("Адресат: беседа …0000000a на chatgpt.com");
    expect((screen.getByLabelText("Текст для передачи") as HTMLTextAreaElement).value).toBe(MARKER);

    const insert = screen.getByRole("button", { name: "Вставить в черновик" });
    fireEvent.click(insert);
    fireEvent.click(insert);
    await settle();

    expect(fixture.draft(PATH_A)).toBe("old draft" + MARKER);
    expect(fixture.draft(PATH_B)).toBe("other");
    expect(fixture.sent()).toBe(0);
    expect(services.copied).toEqual([]);
    expect(services.staging.get()).toBeNull();
    expect(screen.getByRole("status").textContent).toContain("Текст передан в поле ввода");
    expect(screen.queryByRole("button", { name: "Вставить в черновик" })).toBeNull();
  });

  it("withdraws the conversation when the tab moves to another one before the confirmation", async () => {
    fixture = mountFixture("textarea", { [PATH_A]: "draft A", [PATH_B]: "draft B" });
    const services = makeServices();
    services.consent.grant();
    services.staging.stage({ text: MARKER, source: { kind: "manual" } });
    const view = render(toolbar(services, URL_A));

    fireEvent.click(screen.getByRole("button", { name: "Вставить в ChatGPT…" }));
    await settle();
    fixture.go(PATH_B);
    view.rerender(toolbar(services, URL_B));
    await settle();

    expect(screen.getByRole("status").textContent).toContain("Беседа во вкладке сменилась после выбора");
    expect(screen.queryByRole("button", { name: "Вставить в черновик" })).toBeNull();
    expect(fixture.draft(PATH_A)).toBe("draft A");
    expect(fixture.draft(PATH_B)).toBe("draft B");
    expect(services.copied).toEqual([]);

    fireEvent.click(screen.getByRole("button", { name: "Скопировать контекст" }));
    await settle();
    expect(services.copied).toEqual([MARKER]);
  });

  it("falls back to copying on a client that cannot script the tab", async () => {
    const services = makeServices();
    services.consent.grant();
    services.staging.stage({ text: MARKER, source: { kind: "manual" } });
    render(toolbar(services, URL_A, null));

    fireEvent.click(screen.getByRole("button", { name: "Вставить в ChatGPT…" }));
    await settle();

    expect(screen.getByRole("status").textContent).toContain("Автовставка работает только в BB Desktop");
    expect(screen.queryByRole("button", { name: "Вставить в черновик" })).toBeNull();
    expect(screen.getByRole("button", { name: "Скопировать контекст" })).toBeTruthy();
  });

  it("leaves no panel and no usable permission after cancel or unmount", async () => {
    fixture = mountFixture("textarea", { [PATH_A]: "draft" });
    const services = makeServices();
    services.consent.grant();
    services.staging.stage({ text: MARKER, source: { kind: "manual" } });
    const view = render(toolbar(services, URL_A));

    fireEvent.click(screen.getByRole("button", { name: "Вставить в ChatGPT…" }));
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Отмена" }));
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Вставить в ChatGPT…" }));
    await settle();
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    view.unmount();

    expect(document.querySelector("[role='dialog']")).toBeNull();
    expect(fixture.draft(PATH_A)).toBe("draft");
    expect(services.staging.get()?.text).toBe(MARKER);
  });

  it("clears the staged text and tells the user when the panel is closed during the write", async () => {
    let answer: (value: unknown) => void = () => {};
    const answers: Array<Promise<unknown>> = [
      Promise.resolve({ top: true, origin: "https://chatgpt.com", path: PATH_A, tracked: true }),
      new Promise((resolve) => (answer = resolve)),
    ];
    const slowPage: PagePort = { evaluate: () => answers.shift() ?? Promise.reject(new Error("extra call")) };
    const services = makeServices();
    services.consent.grant();
    services.staging.stage({ text: MARKER, source: { kind: "manual" } });
    render(toolbar(services, URL_A, slowPage));

    fireEvent.click(screen.getByRole("button", { name: "Вставить в ChatGPT…" }));
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Вставить в черновик" }));
    fireEvent.click(screen.getByRole("button", { name: "Отмена" }));
    answer({ status: "handed-off" });
    await settle();

    expect(services.staging.get()).toBeNull();
    expect(services.notes).toEqual(["Текст передан в поле ввода ChatGPT. Проверьте черновик."]);
    expect(services.copied).toEqual([]);
  });

  it("does not let a reopened panel send the same text while the first write is unanswered", async () => {
    fixture = mountFixture("textarea", { [PATH_A]: "draft" });
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    let writes = 0;
    const page: PagePort = {
      async evaluate(expression) {
        const result = evaluateInDocument(expression);
        if (expression.includes(MARKER) && (writes += 1) === 1) await held;
        return result;
      },
    };
    const services = makeServices();
    services.consent.grant();
    services.staging.stage({ text: MARKER, source: { kind: "manual" } });
    render(toolbar(services, URL_A, page));

    fireEvent.click(screen.getByRole("button", { name: "Вставить в ChatGPT…" }));
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Вставить в черновик" }));
    fireEvent.click(screen.getByRole("button", { name: "Отмена" }));
    fireEvent.click(screen.getByRole("button", { name: "Вставить в ChatGPT…" }));
    await settle();

    const again = screen.getByRole("button", { name: "Вставить в черновик" }) as HTMLButtonElement;
    expect(again.disabled).toBe(true);
    expect(screen.getByRole("alert").textContent).toContain("Предыдущая передача ещё не завершена");
    fireEvent.click(again);
    await settle();
    release();
    await settle();

    expect(fixture.draft(PATH_A)).toBe("draft" + MARKER);
    expect(writes).toBe(1);
    expect(services.staging.get()).toBeNull();
  });
});
