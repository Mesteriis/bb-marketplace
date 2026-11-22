// The assembled workspace of one window: the route (toolbar and tile surface)
// and the live layer over one session, driven through the UI. The providers
// are stand-ins: a chat that is a textarea, and the fixture frame.
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect } from "react";
import { describe, expect, it } from "vitest";
import { LiveLayer } from "../../../src/adapters/bb/app/LiveLayer.tsx";
import { createWindowWorkspace, type WindowWorkspace } from "../../../src/adapters/bb/app/window-workspace.ts";
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

function newStage(options: { fixture?: boolean; zoom?: boolean } = {}): Stage {
  const rpc = new FakeWorkspaceRpc();
  const ids = sequentialIds();
  const stage: Stage = { rpc, chats: {}, newThreads: 0, workspace: undefined as unknown as WindowWorkspace };
  stage.workspace = createWindowWorkspace({
    extraSources: options.zoom ? [createCardSource("zoom", { plugins: { list: async () => ({ plugins: [] }) } } as unknown as CardHost)] : [],
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
      {onRoute && <WorkspaceRoute workspace={stage.workspace} surfaceSize={SIZE} onNewThread={() => (stage.newThreads += 1)} />}
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
    expect([tiles()[0].style.left, tiles()[0].style.top, tiles()[0].style.width, tiles()[0].style.height]).toEqual(["0px", "0px", "1204px", "800px"]);
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
    expect(boxOf(hostOf(frame())).slice(0, 2)).toEqual(["0px", "32px"]);
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
        <WorkspaceRoute workspace={stage.workspace} surfaceSize={SIZE} onNewThread={() => undefined} />
        <WorkspaceRoute workspace={stage.workspace} surfaceSize={SIZE} onNewThread={() => undefined} />
        <LiveLayer workspace={stage.workspace} />
      </>,
    );
    await screen.findByRole("heading", { name: "Выберите содержимое" });
    expect(screen.getAllByRole("toolbar")).toHaveLength(1);
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
