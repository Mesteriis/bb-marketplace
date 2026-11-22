// The assembled workspace of one window: BB's title bar with Chertog's part
// (the focused tile and the workspace actions), the route (tile surface)
// and the live layer over one session, driven through the UI. The providers
// are stand-ins: a chat that is a textarea, and the fixture frame.
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect } from "react";
import { describe, expect, it, vi } from "vitest";
import { embeddedSources } from "../../../src/adapters/bb/app/embedded-source.tsx";
import { LiveLayer } from "../../../src/adapters/bb/app/LiveLayer.tsx";
import { createWindowWorkspace, type WindowWorkspace } from "../../../src/adapters/bb/app/window-workspace.ts";
import { ChertogHeaderActions, ChertogHeaderTitle } from "../../../src/adapters/bb/app/WorkspaceHeader.tsx";
import { WorkspaceRoute } from "../../../src/adapters/bb/app/WorkspaceRoute.tsx";
import { createCardSource, type CardHost } from "../../../src/adapters/bb/app/card-source.ts";
import { FakeWorkspaceRpc, sequentialIds } from "./support.ts";

const SIZE = { width: 1204, height: 800 };

interface Stage {
  workspace: WindowWorkspace;
  rpc: FakeWorkspaceRpc;
  /** How many times the chat of a thread was mounted and unmounted. */
  chats: Record<string, { mounts: number; unmounts: number }>;
  newThreads: number;
}

function ChatProbe({ threadId, stage }: { threadId: string; stage: Stage }) {
  useEffect(() => {
    const counter = (stage.chats[threadId] ??= { mounts: 0, unmounts: 0 });
    counter.mounts += 1;
    return () => {
      counter.unmounts += 1;
    };
  }, [threadId, stage]);
  return <textarea aria-label={"черновик " + threadId} defaultValue="" />;
}

function newStage(options: { fixture?: boolean; zoom?: boolean; embeds?: boolean } = {}): Stage {
  const rpc = new FakeWorkspaceRpc();
  const ids = sequentialIds();
  const stage: Stage = { rpc, chats: {}, newThreads: 0, workspace: undefined as unknown as WindowWorkspace };
  stage.workspace = createWindowWorkspace({
    extraSources: options.embeds ? embeddedSources() : options.zoom ? [createCardSource("zoom", { plugins: { list: async () => ({ plugins: [] }) } } as unknown as CardHost)] : [],
    renderChat: (threadId) => <ChatProbe threadId={threadId} stage={stage} />,
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
  stage.workspace.host.acceptanceFixture = options.fixture ?? true;
  stage.workspace.threads.set({
    status: "ready",
    threads: [
      { id: "thr_a", title: "Исполнитель", projectName: "bb-main" },
      { id: "thr_b", title: "Ревьюер", projectName: "bb-main", status: { tone: "busy", label: "Работает" } },
    ],
  });
  return stage;
}

/** The window: the live layer is always mounted, the route only while the user is on it. */
function Window({ stage, onRoute }: { stage: Stage; onRoute: boolean }) {
  return (
    <>
      {onRoute && (
        <>
          <header>
            <ChertogHeaderTitle workspace={stage.workspace} />
            <ChertogHeaderActions workspace={stage.workspace} onNewThread={() => (stage.newThreads += 1)} />
          </header>
          <WorkspaceRoute workspace={stage.workspace} surfaceSize={SIZE} />
        </>
      )}
      <LiveLayer workspace={stage.workspace} />
    </>
  );
}

const draft = (threadId: string): HTMLTextAreaElement => {
  const found = document.querySelectorAll<HTMLTextAreaElement>('textarea[aria-label="черновик ' + threadId + '"]');
  if (found.length !== 1) throw new Error("expected one chat of " + threadId + ", found " + found.length);
  return found[0];
};
const frame = (): HTMLIFrameElement => {
  const found = document.querySelectorAll("iframe");
  if (found.length !== 1) throw new Error("expected one frame, found " + found.length);
  return found[0];
};
function hostOf(content: HTMLElement): HTMLElement {
  const host = content.closest<HTMLElement>("[data-live-host]");
  if (host === null) throw new Error("the content is not inside a live host");
  return host;
}
const tiles = (): HTMLElement[] => Array.from(document.querySelectorAll<HTMLElement>("[data-group-id]"));
const boxOf = (host: HTMLElement) => [host.style.left, host.style.top, host.style.width, host.style.height];

async function settled(stage: Stage): Promise<void> {
  await act(async () => {
    await stage.workspace.session.controller.whenIdle();
  });
}

async function addPanel(user: ReturnType<typeof userEvent.setup>, item: RegExp): Promise<void> {
  await user.click(screen.getByRole("button", { name: "Добавить панель" }));
  await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: item }));
}

async function createLayout(user: ReturnType<typeof userEvent.setup>, current: string, name: string): Promise<void> {
  await user.click(screen.getByRole("button", { name: "Раскладка: " + current }));
  await user.type(screen.getByRole("textbox", { name: "Имя новой раскладки" }), name);
  await user.click(screen.getByRole("button", { name: "Создать" }));
}

async function switchLayout(user: ReturnType<typeof userEvent.setup>, current: string, target: string): Promise<void> {
  await user.click(screen.getByRole("button", { name: "Раскладка: " + current }));
  await user.click(within(screen.getByRole("dialog", { name: "Раскладки" })).getByRole("button", { name: target }));
}

/** Two threads and the frame in three tiles, with a draft typed into each chat. */
async function threePanels(stage: Stage, user: ReturnType<typeof userEvent.setup>) {
  const view = render(<Window stage={stage} onRoute />);
  await user.click(await screen.findByRole("button", { name: /Исполнитель/ }));
  await addPanel(user, /Ревьюер/);
  await addPanel(user, /Тестовая панель/);
  await settled(stage);
  await user.type(draft("thr_a"), "черновик исполнителя");
  await user.type(draft("thr_b"), "черновик ревьюера");
  return view;
}

describe("the first entry", () => {
  it("shows one full-size tile that offers the content, and saves nothing", async () => {
    const stage = newStage({ fixture: false });
    render(<Window stage={stage} onRoute />);

    expect(await screen.findByRole("heading", { name: "Выберите содержимое" })).toBeTruthy();
    expect(tiles()).toHaveLength(1);
    expect([tiles()[0].style.left, tiles()[0].style.top, tiles()[0].style.width, tiles()[0].style.height]).toEqual(["6px", "6px", "1192px", "788px"]);
    expect(screen.getByRole("button", { name: /Исполнитель/ }).textContent).toContain("bb-main");
    // Without the owner's acceptance setting the frame is not offered.
    expect(screen.queryByRole("button", { name: /Тестовая панель/ })).toBeNull();
    expect(document.querySelectorAll("[data-live-host]")).toHaveLength(0);
    expect(stage.rpc.saves).toEqual([]);
    expect(screen.getByRole("toolbar", { name: "Рабочее место" })).toBeTruthy();
  });

  it("opens BB's new thread screen from its own action", async () => {
    const stage = newStage();
    const user = userEvent.setup();
    render(<Window stage={stage} onRoute />);
    await user.click(await screen.findByRole("button", { name: "Новый тред" }));
    expect(stage.newThreads).toBe(1);
  });
});

describe("stage A in one window", () => {
  it("keeps the same DOM nodes of the shared panels across named layouts and the route", async () => {
    const stage = newStage();
    const user = userEvent.setup();
    const view = await threePanels(stage, user);

    expect(tiles()).toHaveLength(3);
    const nodes = { a: draft("thr_a"), b: draft("thr_b"), frame: frame() };
    // The tile shows the thread and its project; the frame is one page with its own instance name.
    expect(screen.getByRole("tab", { name: "Исполнитель" })).toBeTruthy();
    expect(document.querySelector("[data-tile-context]")?.textContent).toBe("bb-main");
    expect(nodes.frame.getAttribute("src")).toBe("/api/v1/plugins/chertog/http/fixtures/live-frame.html?instance=frame-5");

    // Two named layouts through the toolbar: each starts as a copy of the open one.
    await createLayout(user, "Основная", "Разработка");
    await createLayout(user, "Разработка", "Ревью");
    await settled(stage);
    expect(stage.rpc.stored?.layouts.map((layout) => layout.name)).toEqual(["Основная", "Разработка", "Ревью"]);
    expect(stage.rpc.stored?.activeLayoutId).toBe("layout-9");

    // In "Ревью" the reviewer's thread is taken out of the layout and the frame moves to the left edge.
    const frameBoxBefore = boxOf(hostOf(frame()));
    const reviewerTile = screen.getByRole("tab", { name: "Ревьюер" }).closest<HTMLElement>("[data-group-id]") as HTMLElement;
    await user.click(within(reviewerTile).getByRole("button", { name: "Действия тайла" }));
    await user.click(screen.getByRole("menuitem", { name: "Убрать вкладку из раскладки" }));
    fireEvent.keyDown(screen.getByRole("tab", { name: /^Тестовая панель/ }), { key: "ArrowLeft", ctrlKey: true, altKey: true });
    await settled(stage);

    expect(tiles()).toHaveLength(2);
    expect(screen.queryByRole("tab", { name: "Ревьюер" })).toBeNull();
    // From the rightmost of three tiles in a row to the left edge, under its header.
    expect(frameBoxBefore[0]).not.toBe("0px");
    expect(boxOf(hostOf(frame())).slice(0, 2)).toEqual(["7px", "31px"]);
    // The hidden thread is live: same node, same draft, listed among the hidden panels.
    expect(draft("thr_b")).toBe(nodes.b);
    expect(nodes.b.value).toBe("черновик ревьюера");
    expect(hostOf(draft("thr_b")).dataset.visible).toBe("false");
    expect(screen.getByRole("button", { name: "Скрытые панели: 1" })).toBeTruthy();
    expect(stage.workspace.session.registry.list().map((instance) => [instance.state, instance.placed])).toEqual([
      ["live", true],
      ["live", false],
      ["live", true],
    ]);

    // Switching to "Разработка" and back keeps every node.
    await switchLayout(user, "Ревью", "Разработка");
    expect(tiles()).toHaveLength(3);
    expect(hostOf(draft("thr_b")).dataset.visible).toBe("true");
    expect(boxOf(hostOf(frame()))).toEqual(frameBoxBefore);
    expect([draft("thr_a"), draft("thr_b"), frame()]).toEqual([nodes.a, nodes.b, nodes.frame]);
    await switchLayout(user, "Разработка", "Ревью");
    expect(tiles()).toHaveLength(2);
    expect([draft("thr_a"), draft("thr_b"), frame()]).toEqual([nodes.a, nodes.b, nodes.frame]);
    expect(frame() === nodes.frame && draft("thr_a") === nodes.a).toBe(true);
    expect([nodes.a.value, nodes.b.value]).toEqual(["черновик исполнителя", "черновик ревьюера"]);

    // Leaving the route parks every panel; coming back shows the same ones.
    view.rerender(<Window stage={stage} onRoute={false} />);
    expect(screen.queryByRole("toolbar")).toBeNull();
    expect(document.querySelector("[data-chertog-live-layer]")?.getAttribute("data-chertog-live-layer")).toBe("parked");
    expect(Array.from(document.querySelectorAll<HTMLElement>("[data-live-host]")).map((host) => host.dataset.visible)).toEqual(["false", "false", "false"]);
    expect([draft("thr_a"), draft("thr_b"), frame()]).toEqual([nodes.a, nodes.b, nodes.frame]);
    view.rerender(<Window stage={stage} onRoute />);
    await screen.findByRole("button", { name: "Раскладка: Ревью" });
    expect(frame()).toBe(nodes.frame);
    expect(draft("thr_a")).toBe(nodes.a);
    expect(hostOf(draft("thr_a")).dataset.visible).toBe("true");
    expect(nodes.a.value).toBe("черновик исполнителя");
    // One load of the document for the whole life of the window.
    expect(stage.rpc.loads).toBe(1);

    // Nothing was mounted twice or unmounted, and the frame was never navigated again.
    expect(stage.chats).toEqual({ thr_a: { mounts: 1, unmounts: 0 }, thr_b: { mounts: 1, unmounts: 0 } });
    expect(document.querySelectorAll("iframe")).toHaveLength(1);

    // The saved document has both layouts, references only, and no titles.
    await settled(stage);
    const stored = stage.rpc.stored;
    expect(stored?.layouts.map((layout) => [layout.id, layout.name])).toEqual([
      ["layout-main", "Основная"],
      ["layout-8", "Разработка"],
      ["layout-9", "Ревью"],
    ]);
    expect(stored?.panels).toEqual({
      "panel-1": { ref: { provider: "bb-thread", params: { threadId: "thr_a" } } },
      "panel-3": { ref: { provider: "bb-thread", params: { threadId: "thr_b" } } },
      "panel-6": { ref: { provider: "fixture-frame", params: { frame: "frame-5" } } },
    });
    expect(JSON.stringify(stored)).not.toContain("Исполнитель");
  });

  it("changes only the status in the tile header when the agent reports", async () => {
    const stage = newStage();
    const user = userEvent.setup();
    await threePanels(stage, user);
    const before = tiles().map((tile) => [tile.dataset.groupId, tile.dataset.focused, tile.style.left, tile.style.top]);
    const saves = stage.rpc.saves.length;
    draft("thr_a").focus();

    act(() => {
      stage.workspace.threads.set({
        status: "ready",
        threads: [
          { id: "thr_a", title: "Исполнитель", projectName: "bb-main", status: { tone: "attention", label: "Ждёт ответа" } },
          { id: "thr_b", title: "Ревьюер", projectName: "bb-main" },
        ],
      });
    });

    expect(screen.getByRole("img", { name: "Ждёт ответа" })).toBeTruthy();
    expect(screen.queryByRole("img", { name: "Работает" })).toBeNull();
    expect(tiles().map((tile) => [tile.dataset.groupId, tile.dataset.focused, tile.style.left, tile.style.top])).toEqual(before);
    expect(document.activeElement).toBe(draft("thr_a"));
    await settled(stage);
    expect(stage.rpc.saves).toHaveLength(saves);
    expect(stage.chats.thr_a).toEqual({ mounts: 1, unmounts: 0 });
  });

  it("shows a thread that left BB's list as ended and keeps its reference", async () => {
    const stage = newStage();
    const user = userEvent.setup();
    await threePanels(stage, user);

    act(() => {
      stage.workspace.threads.set({ status: "ready", threads: [{ id: "thr_a", title: "Исполнитель", projectName: "bb-main" }] });
    });

    const gone = document.querySelector<HTMLElement>('[data-panel-state="session-ended"]');
    expect(gone?.textContent).toContain("Тред недоступен");
    // The title falls back to the neutral caption of the provider's kind.
    expect(screen.getByRole("tab", { name: "Тред" })).toBeTruthy();
    expect(stage.workspace.session.document()?.panels["panel-3"]).toEqual({ ref: { provider: "bb-thread", params: { threadId: "thr_b" } } });
  });
});

describe("the three actions", () => {
  it("closes a thread panel at once and leaves the thread alone", async () => {
    const stage = newStage();
    const user = userEvent.setup();
    await threePanels(stage, user);

    await user.click(screen.getByRole("button", { name: "Закрыть: Ревьюер" }));
    await settled(stage);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.querySelector('textarea[aria-label="черновик thr_b"]')).toBeNull();
    expect(stage.chats.thr_b).toEqual({ mounts: 1, unmounts: 1 });
    expect(tiles()).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Скрытые панели: 0" })).toBeTruthy();
    expect(Object.keys(stage.rpc.stored?.panels ?? {})).toEqual(["panel-1", "panel-6"]);
  });

  it("asks before a close that ends the session, hides on request, and ends only on the explicit choice", async () => {
    const stage = newStage();
    const user = userEvent.setup();
    await threePanels(stage, user);
    const page = frame();

    await user.click(screen.getByRole("button", { name: /^Закрыть: Тестовая панель/ }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("сессия завершится");
    await user.click(within(dialog).getByRole("button", { name: "Скрыть панель" }));
    await settled(stage);

    // Hidden, not closed: the same page, out of the layout, listed among the hidden panels.
    expect(frame()).toBe(page);
    expect(tiles()).toHaveLength(2);
    await user.click(screen.getByRole("button", { name: "Скрытые панели: 1" }));
    await user.click(screen.getByRole("button", { name: /^Закрыть «Тестовая панель/ }));
    await user.click(within(await screen.findByRole("dialog", { name: /^Закрыть «Тестовая панель/ })).getByRole("button", { name: "Отмена" }));
    expect(frame()).toBe(page);

    // The question took the focus out of the list, which closed it.
    await user.click(screen.getByRole("button", { name: "Скрытые панели: 1" }));
    await user.click(screen.getByRole("button", { name: /^Закрыть «Тестовая панель/ }));
    await user.click(within(await screen.findByRole("dialog", { name: /^Закрыть «Тестовая панель/ })).getByRole("button", { name: "Закрыть и завершить" }));
    await settled(stage);
    await waitFor(() => expect(document.querySelector("iframe")).toBeNull());
    expect(stage.workspace.session.registry.list().map((instance) => instance.ref.provider)).toEqual(["bb-thread", "bb-thread"]);
    expect(Object.keys(stage.rpc.stored?.panels ?? {})).toEqual(["panel-1", "panel-3"]);
  });

  describe("closing a parent tile", () => {
    async function parentWithChild(stage: Stage, user: ReturnType<typeof userEvent.setup>) {
      stage.workspace.threads.set({
        status: "ready",
        threads: [
          { id: "thr_a", title: "Исполнитель", projectName: "bb-main" },
          { id: "thr_c", title: "Субтред", projectName: "bb-main", parentThreadId: "thr_a" },
        ],
      });
      render(<Window stage={stage} onRoute />);
      await user.click(await screen.findByRole("button", { name: /Исполнитель/ }));
      await settled(stage);
      act(() => void stage.workspace.session.openThread("thr_c"));
      await settled(stage);
      expect(tiles()).toHaveLength(2);
    }

    it("opens the block dialog, which confirms the block and the end of sessions, and the single-panel dialog for a panel without children", async () => {
      const stage = newStage();
      const user = userEvent.setup();
      await parentWithChild(stage, user);
      const close = vi.spyOn(stage.workspace.session, "closePanel");

      await user.click(screen.getByRole("button", { name: "Закрыть: Исполнитель" }));
      const dialog = await screen.findByRole("dialog", { name: "Закрыть вместе с подчинёнными (1)?" });
      expect(screen.queryByRole("button", { name: "Скрыть панель" })).toBeNull();
      await user.click(within(dialog).getByRole("button", { name: "Закрыть всё" }));
      await settled(stage);
      expect(close).toHaveBeenLastCalledWith("panel-1", { confirmBlock: true, confirmEndsSession: true });
      expect(tiles().flatMap((tile) => Array.from(tile.querySelectorAll("[data-panel-id]")))).toHaveLength(0);
    });

    it("does not confirm the end of a session for a block that is gone by the time the user confirms", async () => {
      const stage = newStage();
      const user = userEvent.setup();
      await parentWithChild(stage, user);
      const close = vi.spyOn(stage.workspace.session, "closePanel");

      await user.click(screen.getByRole("button", { name: "Закрыть: Исполнитель" }));
      const dialog = await screen.findByRole("dialog", { name: "Закрыть вместе с подчинёнными (1)?" });
      const childPanel = Object.keys(stage.workspace.session.document()!.panels).find((id) => stage.workspace.session.document()!.panels[id].ref.params.threadId === "thr_c")!;
      await act(async () => {
        await stage.workspace.session.closePanel(childPanel);
      });
      expect(stage.workspace.session.linkedCountOf("panel-1")).toBe(0);
      close.mockClear();
      await user.click(within(dialog).getByRole("button", { name: "Закрыть всё" }));
      await settled(stage);
      // The parent has no block now: it goes through the normal close, with no blanket confirmation.
      expect(close.mock.calls.every(([, options]) => options?.confirmEndsSession !== true && options?.confirmBlock !== true)).toBe(true);
    });
  });

  it("ends a session only when asked by name, and a retry loads a new page", async () => {
    const stage = newStage();
    const user = userEvent.setup();
    await threePanels(stage, user);
    const page = frame();
    const instance = stage.workspace.session.registry.list().find((item) => item.ref.provider === "fixture-frame");
    if (instance === undefined) throw new Error("the frame is not open");

    await act(async () => {
      await stage.workspace.session.endSession(instance.instanceId);
    });
    expect(document.querySelector("iframe")).toBeNull();
    expect(document.querySelector('[data-panel-state="session-ended"]')?.textContent).toContain("Страница тестовой панели выгружена");
    // The threads were not touched.
    expect(stage.chats).toEqual({ thr_a: { mounts: 1, unmounts: 0 }, thr_b: { mounts: 1, unmounts: 0 } });

    await user.click(screen.getByRole("button", { name: "Повторить" }));
    await waitFor(() => expect(document.querySelector("iframe")).not.toBeNull());
    expect(frame()).not.toBe(page);
  });
});

describe("saving", () => {
  it("shows a failed save and keeps what the window holds", async () => {
    const stage = newStage();
    const user = userEvent.setup();
    render(<Window stage={stage} onRoute />);
    stage.rpc.saveFailures.push(new Error("нет сети"));
    await user.click(await screen.findByRole("button", { name: /Исполнитель/ }));
    await settled(stage);

    const toolbar = within(screen.getByRole("toolbar"));
    expect(toolbar.getByRole("status").textContent).toBe("Не сохранено");
    expect(toolbar.getByRole("status").title).toContain("нет сети");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(draft("thr_a")).toBeTruthy();
    expect(stage.rpc.stored).toBeNull();

    await user.click(toolbar.getByRole("button", { name: "Сохранить ещё раз" }));
    await settled(stage);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(within(screen.getByRole("toolbar")).getByRole("status").textContent).toBe("Сохранено");
    expect(stage.rpc.stored?.revision).toBe(1);
  });

  it("shows saving is off when storage has a newer schema", async () => {
    const stage = newStage();
    stage.rpc.loadAnswer = { status: "newer", schemaVersion: 9 };
    render(<Window stage={stage} onRoute />);
    const toolbar = within(await screen.findByRole("toolbar"));
    expect(toolbar.getByRole("status").textContent).toBe("Сохранение выключено");
    expect(toolbar.getByRole("status").title).toContain("более новой версией");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("button", { name: "Сохранить ещё раз" })).toBeNull();
  });

  it("tells the user about a merge with another window", async () => {
    const stage = newStage();
    const user = userEvent.setup();
    render(<Window stage={stage} onRoute />);
    await screen.findByRole("heading", { name: "Выберите содержимое" });
    const first = stage.workspace.session.document();
    if (first === null) throw new Error("not loaded");
    // Another window saved a layout of its own first.
    stage.rpc.stored = {
      ...first,
      revision: 1,
      layouts: [...first.layouts, { id: "layout-theirs", name: "Созвон", workspace: first.layouts[0].workspace }],
    };

    await createLayout(user, "Основная", "Разработка");
    await settled(stage);
    expect(screen.getByText("Раскладки объединены с изменениями другого окна.")).toBeTruthy();
    expect(stage.rpc.stored?.layouts.map((layout) => layout.name)).toEqual(["Основная", "Созвон", "Разработка"]);
    expect(screen.getByRole("button", { name: "Раскладка: Разработка" })).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Скрыть" }));
    expect(screen.queryByText("Раскладки объединены с изменениями другого окна.")).toBeNull();
  });

  it("says so when the document cannot be loaded and loads on retry", async () => {
    const stage = newStage();
    const user = userEvent.setup();
    stage.rpc.loadFailure = new Error("сервер недоступен");
    render(<Window stage={stage} onRoute />);
    expect((await screen.findByRole("alert")).textContent).toBe("Не удалось загрузить рабочее место: сервер недоступен");

    stage.rpc.loadFailure = null;
    await user.click(screen.getByRole("button", { name: "Повторить" }));
    expect(await screen.findByRole("heading", { name: "Выберите содержимое" })).toBeTruthy();
  });
});

describe("one surface per window", () => {
  it("gives a second Chertog pane a notice instead of a second copy of the panels", async () => {
    const stage = newStage();
    render(
      <>
        <WorkspaceRoute workspace={stage.workspace} surfaceSize={SIZE} />
        <WorkspaceRoute workspace={stage.workspace} surfaceSize={SIZE} />
        <LiveLayer workspace={stage.workspace} />
      </>,
    );
    await screen.findByRole("heading", { name: "Выберите содержимое" });
    expect(screen.getAllByRole("heading", { name: "Выберите содержимое" })).toHaveLength(1);
    expect(screen.getByText("Чертог уже открыт в другой панели этого окна. Рабочее место в окне одно.")).toBeTruthy();
  });
});

it("places three independently selectable thread tiles from the agent preset", async () => {
  const stage = newStage();
  const user = userEvent.setup();
  render(<Window stage={stage} onRoute />);
  await user.click(await screen.findByRole("button", { name: /^Раскладка:/ }));
  await user.click(screen.getByRole("button", { name: /Команда агентов/ }));
  const choices = await screen.findAllByRole("button", { name: "Выбрать тред" });
  expect(choices).toHaveLength(3);
  await user.click(choices[1]);
  const picker = within(screen.getByRole("dialog"));
  expect(picker.queryByRole("heading", { name: "Приёмка" })).toBeNull();
  await user.click(picker.getByRole("button", { name: /Исполнитель/ }));
  expect(await screen.findByRole("textbox", { name: "черновик thr_a" })).toBeTruthy();
  expect(screen.getAllByRole("button", { name: "Выбрать тред" })).toHaveLength(2);
});

it("keeps the Zoom entry available when applying the call preset again", async () => {
  const stage = newStage({ zoom: true });
  const user = userEvent.setup();
  render(<Window stage={stage} onRoute />);
  for (let turn = 0; turn < 2; turn++) {
    await user.click(await screen.findByRole("button", { name: /^Раскладка:/ }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: /^Создать.*Созвон/ }));
    const zoom = stage.workspace.session.focusedInstance();
    expect(zoom?.ref.provider).toBe("zoom");
    expect(zoom?.state).toBe("entry");
    const currentPanel = stage.workspace.session.panelOfInstance(zoom!.instanceId);
    const entry = stage.workspace.session.contentSections().find(section => section.providerId === "zoom")?.items[0];
    expect(entry?.openInTileId).toBe(currentPanel);
  }
});

it("keeps the picker node and instance through selection and requires owner ready", async () => {
  const stage = newStage({ embeds: true });
  render(<Window stage={stage} onRoute />);
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: /Добавить вид Telegram/ }));
  const node = document.querySelector<HTMLElement>('[data-chertog-embed-target="v1"]')!;
  expect(node.isConnected).toBe(true);
  const id = node.dataset.instanceId!;
  const detail = { version: "chertog.embed.v1", provider: "telegram-chat", instanceId: id, generation: 1 };
  const reply = (kind: string, fields = {}) => act(async () => {
    node.dispatchEvent(new CustomEvent("chertog.embed.v1.owner", { bubbles: true, detail: { ...detail, kind, ...fields } }));
  });
  expect(stage.rpc.saves).toEqual([]);
  await reply("ready");
  expect(stage.workspace.session.registry.get(id)).toBeNull();
  await reply("selected", { resourceRef: "12345678-1234-4123-8123-123456789abc" });
  expect(stage.workspace.session.registry.get(id)?.state).toBe("loading");
  expect(document.querySelector("[data-chertog-embed-target]")).toBe(node);
  await reply("ready");
  expect(stage.workspace.session.registry.get(id)?.state).toBe("live");
  await reply("revoked");
  await reply("ready");
  expect(stage.workspace.session.registry.get(id)?.state).toBe("lost");
});

async function embedStage() {
  const stage = newStage({ embeds: true });
  render(<Window stage={stage} onRoute />);
  await userEvent.setup().click(await screen.findByRole("button", { name: /Добавить вид Zoom/ }));
  const node = document.querySelector<HTMLElement>('[data-chertog-embed-target="v1"]')!;
  const id = node.dataset.instanceId!;
  const session = stage.workspace.session;
  const reply = (kind: string, fields = {}) => node.dispatchEvent(new CustomEvent("chertog.embed.v1.owner", {
    bubbles: true, detail: { version: "chertog.embed.v1", provider: "zoom-call", instanceId: id, generation: 1, kind, ...fields },
  }));
  const select = () => reply("selected", { resourceRef: "12345678-1234-4123-8123-123456789abc" });
  return { stage, session, node, id, reply, select };
}

it("times out an accepted reference, ignores late ready and retries with a new generation", async () => {
  const { session, id, reply, select } = await embedStage();
  vi.useFakeTimers();
  try {
    await act(async () => { select(); await vi.advanceTimersByTimeAsync(10001); reply("ready"); });
    expect(session.registry.get(id)).toMatchObject({ state: "lost", unknownOutcome: "open" });
    await act(async () => { session.retry(id); reply("ready"); });
    expect(session.registry.get(id)?.state).toBe("loading");
    await act(async () => { reply("denied", { generation: 2 }); });
    expect(session.registry.get(id)?.state).toBe("access-denied");
  } finally { vi.useRealTimers(); }
});

it("cancels a picker when its owner disables and ignores the late UUID", async () => {
  const { stage, session, node, reply, select } = await embedStage();
  await act(async () => { reply("revoked"); select(); });
  expect(node.isConnected).toBe(false);
  expect(session.reservations.size).toBe(0);
  expect(stage.rpc.saves).toEqual([]);
});

it("retains the last view on keep or owner loss and releases only on acknowledged close", async () => {
  const { session, node, id, reply, select } = await embedStage();
  await act(async () => { select(); reply("ready"); });
  const panel = session.panelOfInstance(id)!;
  await act(async () => { const closing = session.closePanel(panel); reply("keep"); expect(await closing).toBe("kept"); });
  expect(node.isConnected).toBe(true);
  await act(async () => {
    const closing = session.closePanel(panel);
    reply("revoked"); reply("ended");
    expect(await closing).toBe("kept");
  });
  expect(session.registry.get(id)?.state).toBe("lost");
  await act(async () => {
    session.retry(id); reply("ready", { generation: 2 });
    const closing = session.closePanel(panel);
    reply("ended", { generation: 2 });
    expect(await closing).toBe("closed");
  });
  expect(node.isConnected).toBe(false);
});

it("keeps an immediate revocation after ready in the same dispatch turn", async () => {
  const { session, id, reply, select } = await embedStage();
  await act(async () => { select(); reply("ready"); reply("revoked"); });
  expect(session.registry.get(id)).toMatchObject({ state: "lost", unknownOutcome: "open" });
});

it("keeps a Telegram sibling live after the owner closes one draft", async () => {
  const { workspace } = newStage({ embeds: true });
  const { session } = workspace;
  render(<LiveLayer workspace={workspace} />);
  await act(async () => { await session.controller.enter(); });
  const resourceRef = "12345678-1234-4123-8123-123456789abc";
  const nodes: HTMLElement[] = [];
  function reply(node: HTMLElement, kind: string) {
    node.dispatchEvent(new CustomEvent("chertog.embed.v1.owner", { bubbles: true, detail: {
      version: "chertog.embed.v1", provider: "telegram-chat", instanceId: node.dataset.instanceId,
      generation: 1, kind, ...(kind === "selected" ? { resourceRef } : {}),
    } }));
  }
  for (let i = 0; i < 2; i++) {
    await act(async () => { session.openContent({ providerId: "telegram-chat", itemId: "choose", placement: "default" }, { kind: "new-tile" }); });
    const node = document.querySelectorAll<HTMLElement>("[data-chertog-embed-target]")[i]!;
    nodes.push(node);
    await act(async () => { reply(node, "selected"); reply(node, "ready"); });
  }
  expect(session.registry.list().map(view => view.ref.params)).toEqual([{ resourceRef }, { resourceRef }]);
  const [first, second] = nodes as [HTMLElement, HTMLElement];
  await act(async () => {
    const done = session.closeInstance(first.dataset.instanceId!);
    reply(first, "ended");
    expect(await done).toBe("closed");
  });
  expect(second.isConnected).toBe(true);
  expect(session.registry.get(second.dataset.instanceId!)?.state).toBe("live");
});

it("retains a last view whose close acknowledgement timed out and ignores a late ended", async () => {
  const { session, node, id, select, reply } = await embedStage();
  await act(async () => { select(); reply("ready"); });
  vi.useFakeTimers();
  try {
    await act(async () => {
      const closing = session.closeInstance(id);
      await vi.advanceTimersByTimeAsync(10001);
      expect(await closing).toBe("kept");
      reply("ended");
    });
    expect(node.isConnected).toBe(true);
    expect(session.registry.get(id)?.state).toBe("lost");
  } finally { vi.useRealTimers(); }
});

it("explains an unsupported owner version without accepting its ready", async () => {
  const { id, session, select, reply } = await embedStage();
  vi.useFakeTimers();
  try {
    await act(async () => { select(); reply("ready", { version: "chertog.embed.v2" }); await vi.advanceTimersByTimeAsync(10001); });
    expect(session.registry.get(id)?.unknownOutcome).toBe("open");
    expect(screen.getByText("Версия протокола владельца не поддерживается.")).toBeTruthy();
  } finally { vi.useRealTimers(); }
});

async function threadWithPendingZoom() {
  const stage = newStage({ embeds: true });
  const session = stage.workspace.session;
  const user = userEvent.setup();
  render(<Window stage={stage} onRoute />);
  await user.click(await screen.findByRole("button", { name: /Исполнитель/ }));
  await settled(stage);
  const groupId = session.surfaceState()!.focusedGroupId;
  await act(async () => {
    session.openContent({ providerId: "zoom-call", itemId: "choose", placement: "tab" }, { kind: "group", groupId });
  });
  expect(session.reservations.size).toBe(1);
  return { stage, session, user, groupId };
}

it("persists removing a group with a thread and pending Zoom picker", async () => {
  const { stage, session, user } = await threadWithPendingZoom();
  await user.click(within(tiles()[0]).getByRole("button", { name: "Действия тайла" }));
  await user.click(screen.getByRole("menuitem", { name: "Убрать тайл из раскладки" }));
  await settled(stage);
  expect(session.reservations.size).toBe(0);
  expect(session.surfaceState()?.root).toMatchObject({ kind: "group", tabs: [] });
  expect(stage.rpc.stored?.layouts[0].workspace.root).toMatchObject({ kind: "group", tabs: [] });
  expect(session.hiddenPanels().map(panel => panel.title)).toEqual(["Исполнитель"]);
});

it("keeps existing tabs when only the pending Zoom picker tab is removed", async () => {
  const { stage, session, user } = await threadWithPendingZoom();
  const saved = stage.rpc.saves.length;
  await user.click(within(tiles()[0]).getByRole("button", { name: "Действия тайла" }));
  await user.click(screen.getByRole("menuitem", { name: "Убрать вкладку из раскладки" }));
  await settled(stage);
  expect(session.reservations.size).toBe(0);
  expect(session.surfaceState()?.root).toMatchObject({ kind: "group", tabs: ["panel-1"], activeTab: "panel-1" });
  expect(stage.rpc.saves).toHaveLength(saved);
});

it("persists a thread split during Zoom selection and keeps it after cancellation", async () => {
  const { stage, session, groupId } = await threadWithPendingZoom();
  await act(async () => {
    session.openContent({ providerId: "bb-thread", itemId: "thr_b", placement: "tab" }, { kind: "group", groupId });
  });
  await act(async () => {
    session.applySurfaceChange({ kind: "operation", operation: {
      type: "moveTabToEdge", panelId: "panel-1", targetGroupId: groupId, edge: "right",
    } });
  });
  await settled(stage);
  expect(session.reservations.size).toBe(1);
  const split = { kind: "split", children: [{ kind: "group", tabs: ["panel-5"] }, { kind: "group", tabs: ["panel-1"] }] };
  expect(stage.rpc.stored?.layouts[0].workspace.root).toMatchObject(split);
  const reservation = [...session.reservations.values()][0]!;
  await act(async () => { await session.closePanel(reservation.panelId); });
  expect(session.surfaceState()?.root).toMatchObject(split);
});

async function zoomOverThreads(placement: "tab" | "split") {
  const stage = newStage({ embeds: true });
  const { session } = stage.workspace;
  const user = userEvent.setup();
  render(<Window stage={stage} onRoute />);
  await user.click(await screen.findByRole("button", { name: /Исполнитель/ }));
  const addTab = (providerId: string, itemId: string) => act(async () => {
    session.openContent({ providerId, itemId, placement: "tab" }, { kind: "group", groupId: session.surfaceState()!.focusedGroupId });
  });
  if (placement === "split") await addPanel(user, /Ревьюер/);
  else await addTab("bb-thread", "thr_b");
  await user.click(screen.getByRole("tab", { name: /Исполнитель/ }));
  await settled(stage);
  await addTab("zoom-call", "choose");
  const cancel = () => act(async () => {
    await session.closePanel([...session.reservations.values()][0]!.panelId);
  });
  return { stage, user, cancel };
}

it("keeps an explicitly selected tab after cancelling Zoom selection", async () => {
  const { stage, user, cancel } = await zoomOverThreads("tab");
  await user.click(screen.getByRole("tab", { name: /Ревьюер/ }));
  await settled(stage);
  expect(screen.getByRole("tab", { name: /Ревьюер/ }).getAttribute("aria-selected")).toBe("true");
  expect(stage.rpc.stored?.layouts[0].workspace.root).toMatchObject({ activeTab: "panel-3" });
  await cancel();
  expect(screen.getByRole("tab", { name: /Ревьюер/ }).getAttribute("aria-selected")).toBe("true");
  expect(stage.rpc.stored?.layouts[0].workspace.root).toMatchObject({ activeTab: "panel-3" });
});

it("activates the adjacent permanent tab when the active Zoom picker closes", async () => {
  const { stage, cancel } = await zoomOverThreads("tab");
  expect(screen.getByRole("tab", { name: /Zoom/ }).getAttribute("aria-selected")).toBe("true");
  expect(stage.workspace.session.focusedInstance()).toBeNull();
  await cancel();
  await settled(stage);
  expect(screen.getByRole("tab", { name: /Ревьюер/ }).getAttribute("aria-selected")).toBe("true");
  expect(stage.rpc.stored?.layouts[0].workspace.root).toMatchObject({ activeTab: "panel-3" });
});

it("keeps divider proportions changed during Zoom selection", async () => {
  const { stage, cancel } = await zoomOverThreads("split");
  const divider = screen.getByRole("separator");
  expect(divider.getAttribute("aria-valuenow")).toBe("50");
  fireEvent.keyDown(divider, { key: "ArrowRight" });
  await settled(stage);
  expect(divider.getAttribute("aria-valuenow")).toBe("51");
  await cancel();
  await settled(stage);
  expect(screen.getByRole("separator").getAttribute("aria-valuenow")).toBe("51");
  expect(stage.rpc.stored?.layouts[0].workspace.root).toMatchObject({ sizes: [609 / 1186, 577 / 1186] });
});

it("offers the handover of a thread in the menu of its tile and in the title bar, and draws no row for it", async () => {
  const user = userEvent.setup();
  const stage = newStage();
  render(<Window stage={stage} onRoute />);
  await user.click(await screen.findByRole("button", { name: /Исполнитель/ }));
  await settled(stage);
  await act(async () => {
    await stage.workspace.handoff.start(async () => ({
      instanceId: "me",
      windows: ["me", "634b078f51300"],
      placements: [{ threadId: "thr_a", placement: { owner: "me", generation: 1, transfer: null } }],
    }));
  });
  expect(screen.queryByText("Передать в другое окно")).toBeNull();
  const menus = [screen.getByRole("button", { name: "Действия тайла" }), screen.getByRole("button", { name: "Действия выбранного тайла" })];
  expect(menus).toHaveLength(2);
  for (const menu of menus) {
    await user.click(menu);
    expect(screen.getByRole("menuitem", { name: "Передать в окно 634b078f" })).toBeTruthy();
    await user.keyboard("{Escape}");
  }
});
