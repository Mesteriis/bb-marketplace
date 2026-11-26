// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { installTestPluginRuntime } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { InventoryRowDto } from "../core/contract";
import type { CatalogApi } from "./api";
import { CatalogPage } from "./catalog-page";

beforeAll(() => installTestPluginRuntime());
afterEach(cleanup);

const row = (extra: Partial<InventoryRowDto> = {}): InventoryRowDto => ({
  pluginId: "p1",
  pluginName: "mcp-demo",
  serverId: "demo",
  status: "running",
  enabled: true,
  approved: true,
  origin: "catalog",
  lastError: null,
  updateAvailable: null,
  toolCount: null,
  ...extra,
});

function fakeApi(overrides: Partial<CatalogApi> = {}): CatalogApi {
  const unexpected = async () => {
    throw new Error("unexpected call");
  };
  return {
    inventory: vi.fn(async () => ({ rows: [], warnings: [] })),
    setEnabled: vi.fn(async () => undefined),
    approve: vi.fn(async () => undefined),
    auth: vi.fn(async () => ({ url: null })),
    setSecrets: vi.fn(async () => undefined),
    remove: vi.fn(async () => undefined),
    update: vi.fn(async () => undefined),
    collection: vi.fn(async () => ({ items: [] })),
    search: vi.fn(async () => ({ items: [], nextCursor: null, warning: null })),
    startReview: vi.fn(unexpected),
    reviews: vi.fn(async () => ({ items: [] })),
    accept: vi.fn(async () => undefined),
    reject: vi.fn(async () => undefined),
    install: vi.fn(unexpected),
    secretsState: vi.fn(async () => ({ variables: [] })),
    config: vi.fn(async () => ({ pluginId: "mcp-catalog", missing: [] })),
    ...overrides,
  };
}

function renderPage(api: CatalogApi, extra: { openUrl?: (url: string) => void } = {}) {
  const notify = vi.fn();
  render(<CatalogPage api={api} notify={notify} openUrl={extra.openUrl ?? vi.fn()} />);
  return { notify };
}

const clickTab = (name: string) => fireEvent.click(screen.getByRole("tab", { name }));

describe("page shell", () => {
  it("shows the three tabs and the refresh button", async () => {
    renderPage(fakeApi());
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["Стоящие", "Коллекция", "Поиск"]);
    expect(screen.getByRole("button", { name: "Обновить" })).toBeTruthy();
    await screen.findByText("Серверов пока нет");
  });

  it("shows a loading state, then the empty state", async () => {
    renderPage(fakeApi());
    expect(screen.getByText("Загрузка…")).toBeTruthy();
    await screen.findByText("Серверов пока нет");
  });

  it("shows the error and retries", async () => {
    const inventory = vi
      .fn()
      .mockRejectedValueOnce(new Error("bb не отвечает"))
      .mockResolvedValueOnce({ rows: [row()], warnings: [] });
    renderPage(fakeApi({ inventory }));
    await screen.findByText("bb не отвечает");
    fireEvent.click(screen.getByRole("button", { name: "Повторить" }));
    await screen.findByText("demo");
  });

  it("reloads on «Обновить»", async () => {
    const api = fakeApi();
    renderPage(api);
    await screen.findByText("Серверов пока нет");
    fireEvent.click(screen.getByRole("button", { name: "Обновить" }));
    await waitFor(() => expect(api.inventory).toHaveBeenCalledTimes(2));
  });
});

describe("settings not filled in", () => {
  const unset = (missing: ("marketplaceRepoPath" | "marketplaceProjectId")[]) =>
    fakeApi({
      config: async () => ({ pluginId: "mcp-catalog", missing }),
      inventory: async () => ({ rows: [row({ updateAvailable: "1.1.0" })], warnings: [] }),
      collection: async () => ({ items: [{ name: "io.example/Demo", version: "1.0.0", summary: "", error: null, installed: false, reviewing: false, lastRecheck: null }] }),
      reviews: async () => ({ items: [{ name: "a/ready", version: "1.0.0", state: "ready" as const, error: null, threadId: "t1", recheck: false }] }),
      search: async () => ({
        items: [{ name: "a/new", latestVersion: "1.0.0", versions: [{ version: "1.0.0", publishedAt: null, description: "", sources: ["npm" as const], unsupported: null, reviewing: false }], installed: false, inCollection: false, reviewing: false, catalogs: ["official" as const], unsupported: null }],
        nextCursor: null,
        warning: null,
      }),
    });
  const disabled = (name: string) => (screen.getByRole("button", { name }) as HTMLButtonElement).disabled;

  it("shows no notice when both settings are set", async () => {
    renderPage(fakeApi());
    await screen.findByText("Серверов пока нет");
    expect(screen.queryByText(/Каталог не настроен/)).toBeNull();
  });

  it("names the missing settings with the bb plugin config command and disables the actions needing them", async () => {
    renderPage(unset(["marketplaceRepoPath", "marketplaceProjectId"]));
    await screen.findByText(/Каталог не настроен/);
    expect(screen.getByText("bb plugin config mcp-catalog set marketplaceRepoPath <путь к рабочей копии>")).toBeTruthy();
    expect(screen.getByText("bb plugin config mcp-catalog set marketplaceProjectId <id проекта>")).toBeTruthy();
    await screen.findByText("demo");
    expect(disabled("Обновить до 1.1.0")).toBe(true);
    expect(disabled("Выключить")).toBe(false);
    clickTab("Коллекция");
    await screen.findByText("io.example/Demo");
    expect(disabled("Поставить")).toBe(true);
    expect(disabled("Принять")).toBe(true);
    expect(disabled("Отклонить")).toBe(true);
    clickTab("Поиск");
    fireEvent.change(screen.getByLabelText("Запрос в реестр"), { target: { value: "demo" } });
    fireEvent.submit(screen.getByRole("search"));
    await screen.findByText("a/new");
    expect(disabled("Проверить")).toBe(true);
  });

  it("with only the project missing, keeps install and accept but disables «Проверить»", async () => {
    renderPage(unset(["marketplaceProjectId"]));
    await screen.findByText(/Каталог не настроен/);
    expect(screen.queryByText(/marketplaceRepoPath/)).toBeNull();
    clickTab("Коллекция");
    await screen.findByText("io.example/Demo");
    expect(disabled("Поставить")).toBe(false);
    expect(disabled("Принять")).toBe(false);
    clickTab("Поиск");
    fireEvent.change(screen.getByLabelText("Запрос в реестр"), { target: { value: "demo" } });
    fireEvent.submit(screen.getByRole("search"));
    await screen.findByText("a/new");
    expect(disabled("Проверить")).toBe(true);
  });
});

describe("installed tab", () => {
  it("gives an infra row no «Удалить» and marks it «из infra»", async () => {
    renderPage(fakeApi({ inventory: async () => ({ rows: [row({ origin: "infra", serverId: "infra-srv" })], warnings: [] }) }));
    await screen.findByText("infra-srv");
    expect(screen.getByText("из infra")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Удалить" })).toBeNull();
  });

  it("gives a catalog row «Удалить» (with confirmation) and «Обновить до X»", async () => {
    const api = fakeApi({ inventory: async () => ({ rows: [row({ updateAvailable: "1.1.0" })], warnings: [] }) });
    renderPage(api);
    await screen.findByText("demo");
    fireEvent.click(screen.getByRole("button", { name: "Обновить до 1.1.0" }));
    await waitFor(() => expect(api.update).toHaveBeenCalledWith({ pluginId: "p1" }));
    fireEvent.click(screen.getByRole("button", { name: "Удалить" }));
    expect(api.remove).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Точно удалить?" }));
    await waitFor(() => expect(api.remove).toHaveBeenCalledWith({ pluginId: "p1" }));
  });

  it("labels statuses in Russian", async () => {
    const statuses = ["running", "idle", "needs approval", "needs auth", "error"];
    renderPage(
      fakeApi({
        inventory: async () => ({
          rows: statuses.map((status, i) => row({ status, serverId: `s${i}`, pluginId: `p${i}` })),
          warnings: [],
        }),
      }),
    );
    await screen.findByText("s0");
    for (const label of ["работает", "простаивает", "нужно одобрение", "нужен вход", "ошибка"]) {
      expect(screen.getByText(label)).toBeTruthy();
    }
  });

  it("labels the statuses the bridge really reports (ready, disabled) without a duplicate badge", async () => {
    renderPage(
      fakeApi({
        inventory: async () => ({
          rows: [
            row({ status: "ready", serverId: "a", pluginId: "pa" }),
            row({ status: "disabled", enabled: false, serverId: "b", pluginId: "pb" }),
          ],
          warnings: [],
        }),
      }),
    );
    await screen.findByText("a");
    expect(screen.getByText("работает")).toBeTruthy();
    expect(screen.getAllByText("выключен")).toHaveLength(1);
    expect(screen.queryByText("ready")).toBeNull();
    expect(screen.queryByText("disabled")).toBeNull();
  });

  it("toggles enabled", async () => {
    const api = fakeApi({ inventory: async () => ({ rows: [row({ enabled: true })], warnings: [] }) });
    renderPage(api);
    await screen.findByText("demo");
    fireEvent.click(screen.getByRole("button", { name: "Выключить" }));
    await waitFor(() => expect(api.setEnabled).toHaveBeenCalledWith({ pluginId: "p1", serverId: "demo", enabled: false }));
  });

  it("offers «Включить» for a disabled server", async () => {
    renderPage(fakeApi({ inventory: async () => ({ rows: [row({ enabled: false })], warnings: [] }) }));
    await screen.findByText("demo");
    expect(screen.getByRole("button", { name: "Включить" })).toBeTruthy();
  });

  it("approves a server that needs approval", async () => {
    const api = fakeApi({
      inventory: async () => ({ rows: [row({ status: "needs approval", approved: false })], warnings: [] }),
    });
    renderPage(api);
    await screen.findByText("demo");
    fireEvent.click(screen.getByRole("button", { name: "Одобрить" }));
    await waitFor(() => expect(api.approve).toHaveBeenCalledWith({ pluginId: "p1", serverId: "demo" }));
  });

  it("opens the returned URL on «Войти»", async () => {
    const openUrl = vi.fn();
    const api = fakeApi({
      inventory: async () => ({ rows: [row({ status: "needs auth" })], warnings: [] }),
      auth: async () => ({ url: "https://auth.example/login" }),
    });
    renderPage(api, { openUrl });
    await screen.findByText("demo");
    fireEvent.click(screen.getByRole("button", { name: "Войти" }));
    await waitFor(() => expect(openUrl).toHaveBeenCalledWith("https://auth.example/login"));
  });

  it("shows warnings and the last error", async () => {
    renderPage(
      fakeApi({
        inventory: async () => ({ rows: [row({ status: "error", lastError: "процесс упал" })], warnings: ["x: не описан"] }),
      }),
    );
    await screen.findByText("процесс упал");
    expect(screen.getByText("x: не описан")).toBeTruthy();
  });

  it("reports a failed action through notify and keeps the row", async () => {
    const api = fakeApi({
      inventory: async () => ({ rows: [row()], warnings: [] }),
      setEnabled: async () => {
        throw new Error("мост не ответил");
      },
    });
    const { notify } = renderPage(api);
    await screen.findByText("demo");
    fireEvent.click(screen.getByRole("button", { name: "Выключить" }));
    await waitFor(() => expect(notify).toHaveBeenCalledWith("error", "мост не ответил"));
    expect(screen.getByText("demo")).toBeTruthy();
  });
});

const item = (extra: Partial<{ name: string; version: string; summary: string; error: string | null; installed: boolean; reviewing: boolean; lastRecheck: { state: "failed" | "rejected"; error: string | null } | null }> = {}) => ({
  name: "io.example/Demo",
  version: "1.0.0",
  summary: "Лицензия MIT.",
  error: null,
  installed: false,
  reviewing: false,
  lastRecheck: null,
  ...extra,
});

describe("collection tab", () => {
  it("shows the empty state", async () => {
    renderPage(fakeApi());
    clickTab("Коллекция");
    await screen.findByText("В коллекции пока ничего нет");
  });

  it("lists entries with the review extract", async () => {
    renderPage(fakeApi({ collection: async () => ({ items: [item()] }) }));
    clickTab("Коллекция");
    await screen.findByText("io.example/Demo");
    expect(screen.getByText("Лицензия MIT.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Поставить" })).toBeTruthy();
  });

  it("does not offer «Поставить» for a damaged or already installed entry", async () => {
    renderPage(
      fakeApi({
        collection: async () => ({
          items: [item({ name: "a/damaged", error: "хэш не совпадает" }), item({ name: "b/there", installed: true })],
        }),
      }),
    );
    clickTab("Коллекция");
    await screen.findByText("a/damaged");
    expect(screen.queryByRole("button", { name: "Поставить" })).toBeNull();
    expect(screen.getByText("хэш не совпадает")).toBeTruthy();
    expect(screen.getByText("уже стоит")).toBeTruthy();
  });

  it("offers «Принять» and «Отклонить» only for a ready review", async () => {
    const reviews = async () => ({
      items: [
        { name: "a/ready", version: "1.0.0", state: "ready" as const, error: null, threadId: "t1", recheck: false },
        { name: "b/running", version: "1.0.0", state: "reviewing" as const, error: null, threadId: "t2", recheck: false },
        { name: "c/failed", version: "1.0.0", state: "failed" as const, error: "тред упал", threadId: "t3", recheck: false },
      ],
    });
    const api = fakeApi({ reviews });
    renderPage(api);
    clickTab("Коллекция");
    await screen.findByText("a/ready");
    expect(screen.getAllByRole("button", { name: "Принять" })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Отклонить" })).toHaveLength(1);
    expect(screen.getByText("идёт проверка")).toBeTruthy();
    expect(screen.getByText("тред упал")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Принять" }));
    await waitFor(() => expect(api.accept).toHaveBeenCalledWith({ name: "a/ready", version: "1.0.0" }));
  });
});

describe("re-check", () => {
  it("«Проверить заново» starts a review with recheck: true", async () => {
    const startReview = vi.fn(async () => ({ name: "io.example/Demo", version: "1.0.0", state: "reviewing" as const, error: null, threadId: "t9", recheck: true }));
    const api = fakeApi({ collection: async () => ({ items: [item()] }), startReview });
    renderPage(api);
    clickTab("Коллекция");
    await screen.findByText("io.example/Demo");
    fireEvent.click(screen.getByRole("button", { name: "Проверить заново" }));
    await waitFor(() => expect(startReview).toHaveBeenCalledWith({ name: "io.example/Demo", version: "1.0.0", recheck: true }));
  });

  it("is disabled while a review of that version is running", async () => {
    renderPage(fakeApi({ collection: async () => ({ items: [item({ reviewing: true })] }) }));
    clickTab("Коллекция");
    await screen.findByText("io.example/Demo");
    expect((screen.getByRole("button", { name: "Проверить заново" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("labels a running re-check «повторная проверка»", async () => {
    renderPage(fakeApi({ reviews: async () => ({ items: [{ name: "a/b", version: "1.0.0", state: "reviewing" as const, error: null, threadId: "t1", recheck: true }] }) }));
    clickTab("Коллекция");
    await screen.findByText("a/b");
    expect(screen.getByText("повторная проверка")).toBeTruthy();
    expect(screen.queryByText("идёт проверка")).toBeNull();
  });
});

describe("re-check follow-up", () => {
  it("shows why the last re-check did not pass", async () => {
    renderPage(fakeApi({ collection: async () => ({ items: [item({ lastRecheck: { state: "failed", error: "тред упал" } }), item({ name: "b/x", lastRecheck: { state: "rejected", error: null } })] }) }));
    clickTab("Коллекция");
    await screen.findByText("повторная проверка не прошла: тред упал");
    expect(screen.getByText("повторная проверка отклонена")).toBeTruthy();
  });

  it("reloads the collection when a review stops running", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const running = { name: "io.example/Demo", version: "1.0.0", state: "reviewing" as const, error: null, threadId: "t1", recheck: true };
      const reviews = vi.fn().mockResolvedValueOnce({ items: [running] }).mockResolvedValue({ items: [{ ...running, state: "accepted" as const }] });
      const collection = vi.fn(async () => ({ items: [item()] }));
      renderPage(fakeApi({ reviews, collection }));
      clickTab("Коллекция");
      await screen.findByText("повторная проверка");
      const before = collection.mock.calls.length;
      await vi.advanceTimersByTimeAsync(16_000);
      await waitFor(() => expect(collection.mock.calls.length).toBeGreaterThan(before));
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("install dialog", () => {
  const secrets = {
    variables: [
      { name: "API_KEY", description: "ключ доступа", isRequired: true, isSecret: true, state: "set" as const },
      { name: "TOKEN", description: null, isRequired: false, isSecret: true, state: "missing" as const },
      { name: "REGION", description: null, isRequired: false, isSecret: false, state: "missing" as const },
    ],
  };

  async function openDialog(api: CatalogApi) {
    renderPage(api);
    clickTab("Коллекция");
    await screen.findByText("io.example/Demo");
    fireEvent.click(screen.getByRole("button", { name: "Поставить" }));
    return screen.findByRole("dialog");
  }

  it("shows «задано» for a set secret and leaves every field empty", async () => {
    const dialog = within(
      await openDialog(fakeApi({ collection: async () => ({ items: [item()] }), secretsState: async () => secrets })),
    );
    const apiKey = (await dialog.findByLabelText(/API_KEY/)) as HTMLInputElement;
    expect(apiKey.type).toBe("password");
    expect(apiKey.placeholder).toBe("задано");
    expect(apiKey.value).toBe("");
    const token = dialog.getByLabelText(/TOKEN/) as HTMLInputElement;
    expect(token.type).toBe("password");
    expect(token.placeholder).toBe("");
    expect(token.value).toBe("");
    const region = dialog.getByLabelText(/REGION/) as HTMLInputElement;
    expect(region.type).toBe("text");
  });

  it("sends only typed values and never renders a secret as text", async () => {
    const install = vi.fn(async () => ({ ok: true as const, pluginId: "new", needsApproval: true as const }));
    const api = fakeApi({ collection: async () => ({ items: [item()] }), secretsState: async () => secrets, install });
    const dialog = within(await openDialog(api));
    fireEvent.change(await dialog.findByLabelText(/TOKEN/), { target: { value: "s3cret-typed" } });
    expect(document.body.textContent).not.toContain("s3cret-typed");
    fireEvent.click(dialog.getByRole("button", { name: "Поставить" }));
    await waitFor(() =>
      expect(install).toHaveBeenCalledWith({ name: "io.example/Demo", values: { TOKEN: "s3cret-typed" } }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("blocks submit while a required variable is neither set nor typed", async () => {
    const api = fakeApi({
      collection: async () => ({ items: [item()] }),
      secretsState: async () => ({
        variables: [{ name: "API_KEY", description: null, isRequired: true, isSecret: true, state: "missing" }],
      }),
    });
    const dialog = within(await openDialog(api));
    await dialog.findByLabelText(/API_KEY/);
    const submit = dialog.getByRole("button", { name: "Поставить" }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.change(dialog.getByLabelText(/API_KEY/), { target: { value: "x" } });
    expect(submit.disabled).toBe(false);
  });

  it("shows the launcher message when the install is refused", async () => {
    const api = fakeApi({
      collection: async () => ({ items: [item()] }),
      secretsState: async () => ({ variables: [] }),
      install: async () => ({ ok: false as const, message: "не найден npx: поставьте Node.js" }),
    });
    const dialog = within(await openDialog(api));
    await waitFor(() => expect((dialog.getByRole("button", { name: "Поставить" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(dialog.getByRole("button", { name: "Поставить" }));
    await dialog.findByText("не найден npx: поставьте Node.js");
    expect(screen.getByRole("dialog")).toBeTruthy();
  });
});

describe("search tab", () => {
  const ver = (version: string, extra = {}) => ({
    version,
    publishedAt: "2026-11-20T16:05:37Z",
    description: "Демо-сервер",
    sources: ["npm" as const],
    unsupported: null,
    reviewing: false,
    ...extra,
  });
  const found = (extra = {}) => ({
    name: "io.example/Demo",
    latestVersion: "1.2.3",
    versions: [ver("1.2.3"), ver("1.2.2")],
    installed: false,
    inCollection: false,
    reviewing: false,
    catalogs: ["official" as const],
    unsupported: null,
    ...extra,
  });
  const page = (items: ReturnType<typeof found>[], nextCursor: string | null = null) => ({ items, nextCursor, warning: null });

  async function search(api: CatalogApi) {
    renderPage(api);
    clickTab("Поиск");
    fireEvent.change(screen.getByLabelText("Запрос в реестр"), { target: { value: "demo" } });
    fireEvent.submit(screen.getByRole("search"));
  }

  it("marks results «уже стоит» and «в коллекции» and offers «Проверить»", async () => {
    await search(
      fakeApi({
        search: async () =>
          page([found({ name: "a/new" }), found({ name: "b/installed", installed: true }), found({ name: "c/collected", inCollection: true })]),
      }),
    );
    await screen.findByText("a/new");
    expect(screen.getByText("уже стоит")).toBeTruthy();
    expect(screen.getByText("в коллекции")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Проверить" })).toHaveLength(3);
    expect(screen.getAllByText("npm")).toHaveLength(3);
  });

  it("shows one row per server with the latest version selected and the publication date", async () => {
    await search(fakeApi({ search: async () => page([found()]) }));
    await screen.findByText("io.example/Demo");
    const select = screen.getByLabelText("Версия io.example/Demo") as HTMLSelectElement;
    expect(select.value).toBe("1.2.3");
    expect(Array.from(select.options).map((option) => option.value)).toEqual(["1.2.3", "1.2.2"]);
    expect(screen.getByText("2026-11-20")).toBeTruthy();
  });

  it("reviews the selected version and shows that version's description and date", async () => {
    const startReview = vi.fn(async () => ({ name: "io.example/Demo", version: "1.2.2", state: "reviewing" as const, error: null, threadId: "t", recheck: false }));
    const item = found({ versions: [ver("1.2.3"), ver("1.2.2", { description: "Старая версия", publishedAt: "2026-10-01T00:00:00Z" })] });
    await search(fakeApi({ search: async () => page([item]), startReview }));
    await screen.findByText("io.example/Demo");
    fireEvent.change(screen.getByLabelText("Версия io.example/Demo"), { target: { value: "1.2.2" } });
    expect(screen.getByText("Старая версия")).toBeTruthy();
    expect(screen.getByText("2026-10-01")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Проверить" }));
    await waitFor(() => expect(startReview).toHaveBeenCalledWith({ name: "io.example/Demo", version: "1.2.2" }));
  });

  it("marks a server whose review is running «проверяется» and disables «Проверить»", async () => {
    await search(fakeApi({ search: async () => page([found({ reviewing: true, versions: [ver("1.2.3", { reviewing: true }), ver("1.2.2")] })]) }));
    await screen.findByText("io.example/Demo");
    expect(screen.getByText("проверяется")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Проверить" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("disables «Проверить» only for the selected version that is under review", async () => {
    await search(fakeApi({ search: async () => page([found({ reviewing: true, versions: [ver("1.2.3"), ver("1.2.2", { reviewing: true })] })]) }));
    await screen.findByText("io.example/Demo");
    const button = () => screen.getByRole("button", { name: "Проверить" }) as HTMLButtonElement;
    expect(button().disabled).toBe(false);
    expect(screen.queryByText("проверяется")).toBeNull();
    fireEvent.change(screen.getByLabelText("Версия io.example/Demo"), { target: { value: "1.2.2" } });
    expect(button().disabled).toBe(true);
    expect(screen.getByText("проверяется")).toBeTruthy();
  });

  it("starts a review", async () => {
    const startReview = vi.fn(async () => ({ name: "a/new", version: "1.2.3", state: "reviewing" as const, error: null, threadId: "t", recheck: false }));
    await search(fakeApi({ search: async () => page([found({ name: "a/new" })]), startReview }));
    await screen.findByText("a/new");
    fireEvent.click(screen.getByRole("button", { name: "Проверить" }));
    await waitFor(() => expect(startReview).toHaveBeenCalledWith({ name: "a/new", version: "1.2.3" }));
  });

  it("shows the empty result and the registry error", async () => {
    await search(fakeApi());
    await screen.findByText("Ничего не найдено");
    cleanup();
    await search(
      fakeApi({
        search: async () => {
          throw new Error("реестр MCP недоступен: нет ответа");
        },
      }),
    );
    await screen.findByText("реестр MCP недоступен: нет ответа");
  });

  it("loads the next page and merges versions of a name that straddles the pages", async () => {
    const searchFn = vi
      .fn()
      .mockResolvedValueOnce(page([found({ name: "a/one", latestVersion: "1.2.3", versions: [ver("1.2.3")] })], "c2"))
      .mockResolvedValueOnce(page([found({ name: "a/one", latestVersion: "1.2.1", versions: [ver("1.2.1")] }), found({ name: "a/two" })]));
    await search(fakeApi({ search: searchFn }));
    await screen.findByText("a/one");
    fireEvent.click(screen.getByRole("button", { name: "Ещё" }));
    await screen.findByText("a/two");
    expect(searchFn).toHaveBeenLastCalledWith("demo", "c2", ["official", "github", "docker"]);
    expect(screen.getAllByText("a/one")).toHaveLength(1);
    const select = screen.getByLabelText("Версия a/one") as HTMLSelectElement;
    expect(Array.from(select.options).map((option) => option.value)).toEqual(["1.2.3", "1.2.1"]);
  });

  const toggle = (name: string) => screen.getByRole("checkbox", { name }) as HTMLInputElement;

  it("shows the three catalog toggles, all on, and a badge per catalog of each result", async () => {
    await search(
      fakeApi({
        search: async () => page([found({ catalogs: ["official", "docker"] })]),
      }),
    );
    await screen.findByText("io.example/Demo");
    expect(["Официальный", "GitHub", "Docker"].map((name) => toggle(name).checked)).toEqual([true, true, true]);
    const row = within(screen.getByText("io.example/Demo").closest("li") as HTMLElement);
    expect(row.getByText("каталог: Официальный")).toBeTruthy();
    expect(row.getByText("каталог: Docker")).toBeTruthy();
    expect(row.queryByText(/GitHub/)).toBeNull();
  });

  it("sends the first search with all catalogs", async () => {
    const searchFn = vi.fn(async () => page([found()]));
    await search(fakeApi({ search: searchFn }));
    await screen.findByText("io.example/Demo");
    expect(searchFn).toHaveBeenCalledWith("demo", undefined, ["official", "github", "docker"]);
  });

  it("re-runs from the first page without the toggled-off catalog and clears the list", async () => {
    const searchFn = vi
      .fn()
      .mockResolvedValueOnce(page([found({ name: "a/one" })], "c2"))
      .mockResolvedValueOnce(page([found({ name: "a/two" })]));
    await search(fakeApi({ search: searchFn }));
    await screen.findByText("a/one");
    fireEvent.click(toggle("Docker"));
    await screen.findByText("a/two");
    expect(searchFn).toHaveBeenLastCalledWith("demo", undefined, ["official", "github"]);
    expect(screen.queryByText("a/one")).toBeNull();
    expect(toggle("Docker").checked).toBe(false);
  });

  it("keeps the last enabled catalog on, explains why and stays focusable", async () => {
    await search(fakeApi({ search: async () => page([found()]) }));
    await screen.findByText("io.example/Demo");
    expect(screen.queryByText("Должен быть включён хотя бы один каталог")).toBeNull();
    fireEvent.click(toggle("GitHub"));
    fireEvent.click(toggle("Docker"));
    await waitFor(() => expect(toggle("Docker").checked).toBe(false));
    const last = toggle("Официальный");
    expect(last.disabled).toBe(false);
    expect(last.getAttribute("aria-disabled")).toBe("true");
    const hint = screen.getByText("Должен быть включён хотя бы один каталог");
    expect(last.getAttribute("aria-describedby")).toBe(hint.id);
    expect(hint.id).not.toBe("");
    fireEvent.click(last);
    expect(toggle("Официальный").checked).toBe(true);
    expect(toggle("GitHub").getAttribute("aria-disabled")).toBeNull();
  });

  it("drops the response of a search that a catalog toggle has replaced", async () => {
    const resolvers: ((value: ReturnType<typeof page>) => void)[] = [];
    const searchFn = vi.fn(() => new Promise<ReturnType<typeof page>>((resolve) => resolvers.push(resolve)));
    await search(fakeApi({ search: searchFn }));
    await waitFor(() => expect(searchFn).toHaveBeenCalledTimes(1));
    fireEvent.click(toggle("Docker"));
    await waitFor(() => expect(searchFn).toHaveBeenCalledTimes(2));
    resolvers[1]?.(page([found({ name: "a/new" })]));
    await screen.findByText("a/new");
    resolvers[0]?.(page([found({ name: "a/old" })]));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(screen.queryByText("a/old")).toBeNull();
    expect(screen.getByText("a/new")).toBeTruthy();
  });

  it("drops a «Ещё» page that arrives after a catalog toggle", async () => {
    let resolveMore: (value: ReturnType<typeof page>) => void = () => {};
    const searchFn = vi
      .fn()
      .mockResolvedValueOnce(page([found({ name: "a/one" })], "c2"))
      .mockImplementationOnce(() => new Promise((resolve) => (resolveMore = resolve)))
      .mockResolvedValueOnce(page([found({ name: "a/fresh" })]));
    await search(fakeApi({ search: searchFn }));
    await screen.findByText("a/one");
    fireEvent.click(screen.getByRole("button", { name: "Ещё" }));
    await waitFor(() => expect(searchFn).toHaveBeenCalledTimes(2));
    fireEvent.click(toggle("Docker"));
    await screen.findByText("a/fresh");
    resolveMore(page([found({ name: "a/stale" })]));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(screen.queryByText("a/stale")).toBeNull();
    expect(screen.queryByText("a/one")).toBeNull();
    expect(screen.getByText("a/fresh")).toBeTruthy();
  });

  it("remembers the toggles before a first search", async () => {
    const searchFn = vi.fn(async () => page([found()]));
    renderPage(fakeApi({ search: searchFn }));
    clickTab("Поиск");
    fireEvent.click(toggle("GitHub"));
    expect(searchFn).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Запрос в реестр"), {
      target: { value: "demo" },
    });
    fireEvent.submit(screen.getByRole("search"));
    await screen.findByText("io.example/Demo");
    expect(searchFn).toHaveBeenCalledWith("demo", undefined, ["official", "docker"]);
  });

  it("disables «Проверить» for an unsupported version and shows the reason", async () => {
    const item = found({
      unsupported: "нет пакета для запуска",
      versions: [ver("1.2.3", { unsupported: "нет пакета для запуска" })],
    });
    await search(fakeApi({ search: async () => page([item]) }));
    await screen.findByText("io.example/Demo");
    expect(screen.getByText("не поддерживается: нет пакета для запуска")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Проверить" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("uses the unsupported state of the picked version", async () => {
    const item = found({
      unsupported: "старый формат",
      versions: [ver("1.2.3", { unsupported: "старый формат" }), ver("1.2.2")],
    });
    await search(fakeApi({ search: async () => page([item]) }));
    await screen.findByText("не поддерживается: старый формат");
    fireEvent.change(screen.getByLabelText("Версия io.example/Demo"), {
      target: { value: "1.2.2" },
    });
    expect(screen.queryByText(/не поддерживается/)).toBeNull();
    expect((screen.getByRole("button", { name: "Проверить" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("merges catalogs of a name that straddles the pages", async () => {
    const searchFn = vi
      .fn()
      .mockResolvedValueOnce(page([found({ name: "a/one", catalogs: ["official"] })], "c2"))
      .mockResolvedValueOnce(page([found({ name: "a/one", catalogs: ["docker"] })]));
    await search(fakeApi({ search: searchFn }));
    await screen.findByText("a/one");
    fireEvent.click(screen.getByRole("button", { name: "Ещё" }));
    await waitFor(() => expect(searchFn).toHaveBeenCalledTimes(2));
    const row = within(screen.getByText("a/one").closest("li") as HTMLElement);
    await waitFor(() => expect(row.getByText("каталог: Docker")).toBeTruthy());
    expect(row.getByText("каталог: Официальный")).toBeTruthy();
    expect(screen.getAllByText("a/one")).toHaveLength(1);
  });
});

describe("tool count and URL safety", () => {
  it("shows the tool count per server", async () => {
    renderPage(fakeApi({ inventory: async () => ({ rows: [row({ toolCount: 4 })], warnings: [] }) }));
    await screen.findByText("4 инструм.");
  });

  it("does not open a non-http auth URL", async () => {
    const openUrl = vi.fn();
    const api = fakeApi({
      inventory: async () => ({ rows: [row({ status: "needs auth" })], warnings: [] }),
      auth: async () => ({ url: "javascript:alert(1)" }),
    });
    const { notify } = renderPage(api, { openUrl });
    await screen.findByText("demo");
    fireEvent.click(screen.getByRole("button", { name: "Войти" }));
    await waitFor(() => expect(notify).toHaveBeenCalledWith("error", expect.stringContaining("адрес")));
    expect(openUrl).not.toHaveBeenCalled();
  });
});

describe("edit variables of an installed catalog server", () => {
  const vars = {
    variables: [
      { name: "API_KEY", description: null, isRequired: false, isSecret: true, state: "set" as const },
      { name: "TOKEN", description: null, isRequired: false, isSecret: true, state: "missing" as const },
    ],
  };

  it("offers «Изменить переменные» on catalog rows only", async () => {
    renderPage(
      fakeApi({
        inventory: async () => ({
          rows: [row({ serverId: "cat" }), row({ serverId: "inf", pluginId: "p2", origin: "infra" })],
          warnings: [],
        }),
      }),
    );
    await screen.findByText("cat");
    expect(screen.getAllByRole("button", { name: "Изменить переменные" })).toHaveLength(1);
  });

  it("loads state by plugin id, offers «Очистить» only for a set variable and saves typed values and clears", async () => {
    const api = fakeApi({ inventory: async () => ({ rows: [row()], warnings: [] }), secretsState: vi.fn(async () => vars) });
    renderPage(api);
    await screen.findByText("demo");
    fireEvent.click(screen.getByRole("button", { name: "Изменить переменные" }));
    const dialog = within(await screen.findByRole("dialog"));
    const apiKey = (await dialog.findByLabelText(/API_KEY/)) as HTMLInputElement;
    expect(api.secretsState).toHaveBeenCalledWith({ pluginId: "p1" });
    expect(apiKey.value).toBe("");
    expect(apiKey.placeholder).toBe("задано");
    expect(dialog.getAllByRole("button", { name: "Очистить" })).toHaveLength(1);
    fireEvent.change(dialog.getByLabelText(/TOKEN/), { target: { value: "new-token" } });
    fireEvent.click(dialog.getByRole("button", { name: "Очистить" }));
    expect((dialog.getByLabelText(/API_KEY/) as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(dialog.getByRole("button", { name: "Сохранить" }));
    await waitFor(() => expect(api.setSecrets).toHaveBeenCalledWith({ pluginId: "p1", values: { TOKEN: "new-token" }, clear: ["API_KEY"] }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("can take back a pending clear", async () => {
    const api = fakeApi({ inventory: async () => ({ rows: [row()], warnings: [] }), secretsState: async () => vars });
    renderPage(api);
    await screen.findByText("demo");
    fireEvent.click(screen.getByRole("button", { name: "Изменить переменные" }));
    const dialog = within(await screen.findByRole("dialog"));
    await dialog.findByLabelText(/API_KEY/);
    fireEvent.click(dialog.getByRole("button", { name: "Очистить" }));
    fireEvent.click(dialog.getByRole("button", { name: "Не очищать" }));
    fireEvent.click(dialog.getByRole("button", { name: "Сохранить" }));
    await waitFor(() => expect(api.setSecrets).toHaveBeenCalledWith({ pluginId: "p1", values: {}, clear: [] }));
  });

  it("shows the refusal from the server in the dialog", async () => {
    const api = fakeApi({
      inventory: async () => ({ rows: [row()], warnings: [] }),
      secretsState: async () => vars,
      setSecrets: async () => {
        throw new Error("переменная «X» не объявлена сервером");
      },
    });
    renderPage(api);
    await screen.findByText("demo");
    fireEvent.click(screen.getByRole("button", { name: "Изменить переменные" }));
    const dialog = within(await screen.findByRole("dialog"));
    await dialog.findByLabelText(/API_KEY/);
    fireEvent.click(dialog.getByRole("button", { name: "Сохранить" }));
    await dialog.findByText("переменная «X» не объявлена сервером");
  });
});
