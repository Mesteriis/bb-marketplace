// The Chertog part of BB's title bar over one window workspace: the focused
// tile on the left, the workspace actions on the right, the page title. The
// route is mounted beside them as in the app; they share one session.
import { act, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWindowWorkspace, type WindowWorkspace } from "../../../src/adapters/bb/app/window-workspace.ts";
import { ChertogHeaderActions, ChertogHeaderTitle, useChertogPageTitle } from "../../../src/adapters/bb/app/WorkspaceHeader.tsx";
import { WorkspaceRoute } from "../../../src/adapters/bb/app/WorkspaceRoute.tsx";
import { FakeWorkspaceRpc, sequentialIds } from "./support.ts";

const SIZE = { width: 1204, height: 800 };

interface Stage {
  workspace: WindowWorkspace;
  newThreads: number;
}

function newStage(): Stage {
  const rpc = new FakeWorkspaceRpc();
  const ids = sequentialIds();
  const stage: Stage = { newThreads: 0, workspace: undefined as unknown as WindowWorkspace };
  stage.workspace = createWindowWorkspace({
    renderChat: () => null,
    randomId: () => ids("r").slice(2),
    diagnostics: { failure: () => undefined },
  });
  stage.workspace.host.rpc = {
    call: async (method: string, input: unknown) => {
      if (method === "load_workspace") return rpc.load();
      const { document, expectedRevision } = input as { document: never; expectedRevision: number };
      return rpc.save(document, expectedRevision);
    },
  };
  stage.workspace.host.pluginId = "chertog";
  stage.workspace.threads.set({
    status: "ready",
    threads: [
      { id: "thr_a", title: "Исполнитель", projectName: "bb-main" },
      { id: "thr_b", title: "Ревьюер", projectName: "bb-main", status: { tone: "busy", label: "Работает" } },
    ],
  });
  return stage;
}

/** What BB mounts for the route: the title, the actions and the page. */
function Bar({ stage }: { stage: Stage }) {
  return (
    <>
      <header>
        <ChertogHeaderTitle workspace={stage.workspace} />
        <ChertogHeaderActions workspace={stage.workspace} onNewThread={() => (stage.newThreads += 1)} />
      </header>
      <WorkspaceRoute workspace={stage.workspace} surfaceSize={SIZE} />
    </>
  );
}

const title = () => within(document.querySelector<HTMLElement>("[data-chertog-header-title]")!);

async function addPanel(user: ReturnType<typeof userEvent.setup>, item: RegExp): Promise<void> {
  await user.click(screen.getByRole("button", { name: "Добавить панель" }));
  await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: item }));
}

afterEach(() => vi.unstubAllGlobals());

describe("the title of the bar", () => {
  it("is «Чертог» while no tile has content", async () => {
    render(<Bar stage={newStage()} />);

    await screen.findByRole("heading", { name: "Выберите содержимое" });
    expect(title().getByText("Чертог")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Действия тайла" })).toBeNull();
  });

  it("shows the focused tile and changes at once when the focus moves", async () => {
    const stage = newStage();
    const user = userEvent.setup();
    render(<Bar stage={stage} />);
    await user.click(await screen.findByRole("button", { name: /Исполнитель/ }));
    await addPanel(user, /Ревьюер/);

    // The tile that was just opened has the focus.
    expect(title().getByText("Ревьюер")).toBeTruthy();
    expect(title().getByRole("img", { name: "Работает" })).toBeTruthy();
    expect(title().getByText("bb-main")).toBeTruthy();

    await act(async () => {
      const panelOfFirst = Object.entries(stage.workspace.session.labels()).find(([, label]) => label.title === "Исполнитель")![0];
      stage.workspace.session.focusPanel(panelOfFirst);
    });

    expect(title().getByText("Исполнитель")).toBeTruthy();
    expect(title().queryByText("Ревьюер")).toBeNull();
    expect(title().queryByRole("img")).toBeNull();
  });

  it("has the menu of the focused tile, and the menu acts on that tile", async () => {
    const stage = newStage();
    const user = userEvent.setup();
    render(<Bar stage={stage} />);
    await user.click(await screen.findByRole("button", { name: /Исполнитель/ }));
    await addPanel(user, /Ревьюер/);
    expect(document.querySelectorAll("[data-group-id]")).toHaveLength(2);

    await user.click(title().getByRole("button", { name: "Действия тайла" }));
    const items = within(screen.getByRole("menu", { name: "Действия тайла" })).getAllByRole("menuitem");
    expect(items.map((item) => item.textContent)).toEqual(["Убрать вкладку из раскладки", "Убрать тайл из раскладки", "Открыть рядом…"]);
    await user.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: "Убрать тайл из раскладки" }));

    await waitFor(() => expect(document.querySelectorAll("[data-group-id]")).toHaveLength(1));
    expect(title().getByText("Исполнитель")).toBeTruthy();
  });
});

describe("the actions of the bar", () => {
  it("opens BB's new thread screen", async () => {
    const stage = newStage();
    const user = userEvent.setup();
    render(<Bar stage={stage} />);

    await user.click(await screen.findByRole("button", { name: "Новый тред" }));

    expect(stage.newThreads).toBe(1);
  });

  it("adds content in a new tile through «Добавить панель»", async () => {
    const stage = newStage();
    const user = userEvent.setup();
    render(<Bar stage={stage} />);
    await user.click(await screen.findByRole("button", { name: /Исполнитель/ }));

    await addPanel(user, /Ревьюер/);

    await waitFor(() => expect(document.querySelectorAll("[data-group-id]")).toHaveLength(2));
  });

  it("switches the layout and shows the save state", async () => {
    const stage = newStage();
    const user = userEvent.setup();
    render(<Bar stage={stage} />);

    await waitFor(() => expect(within(screen.getByRole("toolbar")).getByRole("status").textContent).toBe("Сохранено"));
    await user.click(screen.getByRole("button", { name: /Раскладка: Основная/ }));
    await user.type(screen.getByRole("textbox", { name: "Имя новой раскладки" }), "Ревью");
    await user.click(screen.getByRole("button", { name: "Создать" }));

    expect(await screen.findByRole("button", { name: "Раскладка: Ревью" })).toBeTruthy();
  });

  it("shows nothing before the workspace has loaded", () => {
    const stage = newStage();
    render(
      <header>
        <ChertogHeaderActions workspace={stage.workspace} onNewThread={() => undefined} />
      </header>,
    );

    expect(screen.queryByRole("toolbar")).toBeNull();
  });

  it("folds into the menu when the title bar is narrow, and unfolds when it is wide again", async () => {
    let width = 640;
    const observers: (() => void)[] = [];
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: () => void) {
          observers.push(callback);
        }
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    const original = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      return this.tagName === "HEADER" ? ({ width, height: 48, left: 0, top: 0, right: width, bottom: 48, x: 0, y: 0, toJSON: () => ({}) } as DOMRect) : original.call(this);
    });
    render(<Bar stage={newStage()} />);

    await screen.findByRole("button", { name: "Ещё" });
    expect(screen.queryByRole("button", { name: "Новый тред" })).toBeNull();

    width = 1400;
    act(() => observers.forEach((callback) => callback()));

    expect(await screen.findByRole("button", { name: "Новый тред" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Ещё" })).toBeNull();
    vi.restoreAllMocks();
  });
});

describe("the route under the bar", () => {
  it("has no toolbar or new thread button of its own, and the tiles start right under the bar", async () => {
    const stage = newStage();
    render(<WorkspaceRoute workspace={stage.workspace} surfaceSize={SIZE} />);

    await screen.findByRole("heading", { name: "Выберите содержимое" });
    expect(screen.queryByRole("toolbar")).toBeNull();
    expect(screen.queryByRole("button", { name: "Новый тред" })).toBeNull();
    const route = document.querySelector("[data-chertog-route]")!;
    expect(route.firstElementChild?.hasAttribute("data-chertog-surface-host")).toBe(true);
  });
});

describe("the page title", () => {
  it("is null without a focused tile, so BB keeps its default", async () => {
    const stage = newStage();
    const { result } = renderHook(() => useChertogPageTitle(stage.workspace));

    expect(result.current).toBeNull();
  });

  it("is the title of the focused tile, with the product in the window title", async () => {
    const stage = newStage();
    const user = userEvent.setup();
    render(<Bar stage={stage} />);
    const { result } = renderHook(() => useChertogPageTitle(stage.workspace));
    await user.click(await screen.findByRole("button", { name: /Исполнитель/ }));

    await waitFor(() => expect(result.current).toEqual({ title: "Исполнитель", windowTitle: "Исполнитель — Чертог" }));
  });
});
