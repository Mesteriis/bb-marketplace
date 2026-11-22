// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { Attachment } from "../src/core/attachment.ts";
import type { WindowStatusView } from "../src/core/window-status.ts";
import { DockPage } from "../src/ui/dock-page.tsx";
import type { WindowApi } from "../src/ui/services.ts";

afterEach(cleanup);

function fakeChat(answer: WindowStatusView = { window: "open", reason: null }) {
  let opened = 0;
  const attached: Attachment[] = [];
  const chat: WindowApi = {
    open: async () => ((opened += 1), answer),
    attach: (view) => void attached.push(view),
  };
  return { chat, opened: () => opened, attached };
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("the ChatGPT tab", () => {
  it("is only ChatGPT: opens it with the tab, the whole tab is its area, no other controls", async () => {
    const { chat, opened } = fakeChat();
    const { container } = render(<DockPage chat={chat} status={{ window: "open", reason: null }} />);
    await settle();

    expect(opened()).toBe(1);
    const area = screen.getByLabelText("ChatGPT");
    expect(area.hasAttribute("data-chat-dock-area")).toBe(true);
    expect(container.firstElementChild).toBe(area);
    expect(screen.queryAllByRole("button")).toEqual([]);
    expect(container.querySelectorAll("textarea, input, aside")).toHaveLength(0);
  });

  it("hides the window when the tab goes away", async () => {
    const { chat, attached } = fakeChat();
    const view = render(<DockPage chat={chat} status={{ window: "open", reason: null }} />);
    await settle();
    view.unmount();

    expect(attached[attached.length - 1]!.visible).toBe(false);
  });

  it("says why ChatGPT is not there and offers to open it again", async () => {
    const { chat, opened } = fakeChat({ window: "unavailable", reason: "Нет компилятора." });
    render(<DockPage chat={chat} status={{ window: "unavailable", reason: "Нет компилятора." }} />);
    await settle();

    expect(screen.getByRole("status").textContent).toBe("ChatGPT недоступен. Нет компилятора.");
    fireEvent.click(screen.getByRole("button", { name: "Открыть ChatGPT" }));
    await settle();
    expect(opened()).toBe(2);
  });

  it("shows a refused open and lets you try again, even before any status arrived", async () => {
    let attempts = 0;
    const chat: WindowApi = {
      open: async () => {
        attempts += 1;
        throw new Error("no host");
      },
      attach: () => {},
    };
    render(<DockPage chat={chat} status={null} />);
    await settle();

    expect(screen.getByRole("status").textContent).toBe("Не удалось связаться с компьютером, на котором работает BB.");
    fireEvent.click(screen.getByRole("button", { name: "Открыть ChatGPT" }));
    await settle();
    expect(attempts).toBe(2);
  });

  it("names the first build while it runs", () => {
    render(<DockPage chat={fakeChat().chat} status={{ window: "building", reason: null }} />);
    expect(screen.getByRole("status").textContent).toContain("собирается");
    expect(screen.queryAllByRole("button")).toEqual([]);
  });
});
