// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { createStaging } from "../src/core/staging.ts";
import type { ProposeOutcome, WindowStatusView } from "../src/core/window-status.ts";
import { DockPage } from "../src/ui/dock-page.tsx";
import type { DockServices } from "../src/ui/services.ts";

const MARKER = "SYNTHETIC-MARKER-51ab";
const trusted = () => true;

afterEach(cleanup);

const OPEN: WindowStatusView = { window: "open", reason: null, proposal: "none", last: null };

function makeServices(answer: ProposeOutcome = { ok: true, proposalId: "p-1" }) {
  const copied: string[] = [];
  const notes: string[] = [];
  const proposed: Array<[string, string]> = [];
  let opened = 0;
  const attached: boolean[] = [];
  const services: DockServices = {
    staging: createStaging(),
    window: {
      open: async () => ((opened += 1), OPEN),
      propose: async (text, source) => (proposed.push([text, source]), answer),
      attach: (view) => void attached.push(view.visible),
    },
    copyText: async (text) => (copied.push(text), true),
    notify: (_kind, message) => void notes.push(message),
  };
  return { services, copied, notes, proposed, opened: () => opened, attached };
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("the ChatGPT page", () => {
  it("opens ChatGPT when the page opens, explains the window and names what it does not protect against", async () => {
    const { services, opened } = makeServices();
    render(<DockPage services={services} status={{ window: "closed", reason: null, proposal: "none", last: null }} isUserAction={trusted} />);
    await settle();

    expect(opened()).toBe(1);
    expect(screen.getByRole("status").textContent).toBe("ChatGPT закрыт.");
    expect(screen.getByText(/Вход в нём сохраняется между запусками/).textContent).toContain("полными правами в");
    expect((screen.getByRole("button", { name: "Передать в ChatGPT" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("reserves an area for ChatGPT and hides the window when the page goes away", async () => {
    const { services, attached } = makeServices();
    const view = render(<DockPage services={services} status={OPEN} isUserAction={trusted} />);
    await settle();

    expect(screen.getByLabelText("ChatGPT").hasAttribute("data-chat-dock-area")).toBe(true);
    view.unmount();

    expect(attached[attached.length - 1]).toBe(false);
  });

  it("hands over exactly the edited preview with its source, and copies only on the button", async () => {
    const { services, proposed, copied, notes } = makeServices();
    services.staging.stage({ text: "picked " + MARKER, source: { kind: "message-selection", threadId: "thr_1" } });
    render(<DockPage services={services} status={OPEN} isUserAction={trusted} />);

    fireEvent.change(screen.getByLabelText("Текст для передачи"), { target: { value: "edited\n" + MARKER } });
    fireEvent.click(screen.getByRole("button", { name: "Передать в ChatGPT" }));
    await settle();

    expect(proposed).toEqual([["edited\n" + MARKER, "message-selection"]]);
    expect(copied).toEqual([]);
    expect(notes).toEqual(["Текст показан под ChatGPT. Проверьте беседу и подтвердите вставку там."]);
    expect(services.staging.get()?.text).toBe("edited\n" + MARKER);

    fireEvent.click(screen.getByRole("button", { name: "Скопировать контекст" }));
    await settle();
    expect(copied).toEqual(["edited\n" + MARKER]);
  });

  it("drops the staged text once the window reports it may be in a draft, and keeps it after a refusal", async () => {
    const { services } = makeServices();
    services.staging.stage({ text: MARKER, source: { kind: "manual" } });
    const view = render(<DockPage services={services} status={OPEN} isUserAction={trusted} />);
    fireEvent.click(screen.getByRole("button", { name: "Передать в ChatGPT" }));
    await settle();

    view.rerender(<DockPage services={services} status={{ ...OPEN, last: { proposalId: "p-1", outcome: "refused" } }} isUserAction={trusted} />);
    expect(services.staging.get()?.text).toBe(MARKER);
    expect(screen.getByText(/вставка отменена, текст никуда не записан/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Передать в ChatGPT" }));
    await settle();
    view.rerender(<DockPage services={services} status={{ ...OPEN, last: { proposalId: "p-1", outcome: "handed-off" } }} isUserAction={trusted} />);
    expect(services.staging.get()).toBeNull();
  });

  it("ignores an outcome for a proposal this page did not send", async () => {
    const { services } = makeServices();
    services.staging.stage({ text: MARKER, source: { kind: "manual" } });
    render(<DockPage services={services} status={{ ...OPEN, last: { proposalId: "other", outcome: "handed-off" } }} isUserAction={trusted} />);

    expect(services.staging.get()?.text).toBe(MARKER);
  });

  it("tells the user when the window is busy or not ready", async () => {
    const busy = makeServices({ ok: false, reason: "busy" });
    busy.services.staging.stage({ text: MARKER, source: { kind: "manual" } });
    render(<DockPage services={busy.services} status={OPEN} isUserAction={trusted} />);
    fireEvent.click(screen.getByRole("button", { name: "Передать в ChatGPT" }));
    await settle();

    expect(busy.notes).toEqual(["ChatGPT ещё принимает предыдущий текст. Дождитесь результата."]);
  });

  it("disables handing over while the window is writing", () => {
    const { services } = makeServices();
    services.staging.stage({ text: MARKER, source: { kind: "manual" } });
    render(<DockPage services={services} status={{ ...OPEN, proposal: "writing" }} isUserAction={trusted} />);

    expect((screen.getByRole("button", { name: "Передать в ChatGPT" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("status").textContent).toBe("Текст передаётся в поле ввода.");
  });

  it("shows why the window is unavailable", () => {
    const { services } = makeServices();
    render(<DockPage services={services} status={{ window: "unavailable", reason: "Не найден компилятор Swift.", proposal: "none", last: null }} isUserAction={trusted} />);

    expect(screen.getByRole("status").textContent).toBe("ChatGPT недоступен. Не найден компилятор Swift.");
  });

  it("ignores clicks the user did not make", async () => {
    const { services, proposed, copied, opened } = makeServices();
    services.staging.stage({ text: MARKER, source: { kind: "manual" } });
    // No `isUserAction`: the default guard is in force, and dispatched events are untrusted.
    render(<DockPage services={services} status={OPEN} />);

    for (const name of ["Передать в ChatGPT", "Скопировать контекст", "Очистить"]) {
      fireEvent.click(screen.getByRole("button", { name }));
    }
    await settle();

    // Only the automatic open when the page appeared.
    expect(opened()).toBe(1);
    expect(proposed).toEqual([]);
    expect(copied).toEqual([]);
    expect(services.staging.get()?.text).toBe(MARKER);
  });
});
