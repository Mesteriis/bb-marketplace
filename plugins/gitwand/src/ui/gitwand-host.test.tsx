// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GitWandHost } from "./gitwand-host.tsx";

afterEach(cleanup);

const URL_A = "http://localhost:3000/api/v1/plugins/makosh-gitwand/http/ui/index.html?repo=%2Fr";
const FRAME_ORIGIN = "http://localhost:3000";

function frameWindow() {
  return (screen.getByTitle("GitWand") as HTMLIFrameElement).contentWindow!;
}

function fromFrame(data: unknown, origin = FRAME_ORIGIN, source: MessageEventSource | null = frameWindow()) {
  act(() => {
    window.dispatchEvent(new MessageEvent("message", { data, origin, source }));
  });
}

describe("GitWandHost", () => {
  it("passes GitWand's notifications to BB", () => {
    const onNotify = vi.fn();
    render(<GitWandHost url={URL_A} onNotify={onNotify} />);
    fromFrame({ source: "gitwand", type: "notify", title: "Pushed", body: "main → origin" });
    expect(onNotify).toHaveBeenCalledWith("Pushed", "main → origin");
  });

  it("ignores messages from another origin or another window", () => {
    const onNotify = vi.fn();
    render(<GitWandHost url={URL_A} onNotify={onNotify} />);
    fromFrame({ source: "gitwand", type: "notify", title: "x", body: "y" }, "http://evil.example");
    fromFrame({ source: "gitwand", type: "notify", title: "x", body: "y" }, FRAME_ORIGIN, window);
    expect(onNotify).not.toHaveBeenCalled();
  });

  it("asks for a folder and sends the answer back to the frame's origin only", () => {
    render(<GitWandHost url={URL_A} onNotify={() => {}} />);
    const post = vi.spyOn(frameWindow(), "postMessage").mockImplementation(() => {});
    fromFrame({ source: "gitwand", type: "pick-folder", id: 3 });
    fireEvent.change(screen.getByLabelText("Путь к папке репозитория"), { target: { value: "  /Users/me/project  " } });
    fireEvent.click(screen.getByRole("button", { name: "Открыть" }));
    expect(post).toHaveBeenCalledWith({ source: "gitwand-host", type: "pick-folder-result", id: 3, path: "/Users/me/project" }, FRAME_ORIGIN);
    expect(screen.queryByLabelText("Путь к папке репозитория")).toBeNull();
  });

  it("answers null when the folder dialog is cancelled", () => {
    render(<GitWandHost url={URL_A} onNotify={() => {}} />);
    const post = vi.spyOn(frameWindow(), "postMessage").mockImplementation(() => {});
    fromFrame({ source: "gitwand", type: "pick-folder", id: 4 });
    fireEvent.click(screen.getByRole("button", { name: "Отмена" }));
    expect(post).toHaveBeenCalledWith({ source: "gitwand-host", type: "pick-folder-result", id: 4, path: null }, FRAME_ORIGIN);
  });

  it("says when the backend stopped and reloads the frame on request", () => {
    render(<GitWandHost url={URL_A} onNotify={() => {}} />);
    const before = screen.getByTitle("GitWand");
    fromFrame({ source: "gitwand", type: "lost", reason: "gitwand-bridge exited (code 1)" });
    expect(screen.getByRole("alert").textContent).toContain("GitWand перезапущен: открытые терминалы закрыты (gitwand-bridge exited (code 1))");
    fireEvent.click(screen.getByRole("button", { name: "Обновить" }));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByTitle("GitWand")).not.toBe(before);
  });

  it("shows the problem instead of the frame when there is one", () => {
    render(<GitWandHost url={URL_A} problem="This thread has no workspace yet." onNotify={() => {}} />);
    expect(screen.queryByTitle("GitWand")).toBeNull();
    expect(screen.getByRole("status").textContent).toBe("This thread has no workspace yet.");
  });
});
