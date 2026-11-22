import { createElement } from "react";
import type { useBbNavigate, useSdk } from "@get-bb/plugin-sdk/app";
import { entryCards, entryRoute, fileTarget, type CardType } from "../../../core/panels/entry-card.ts";
import { PanelRegistry } from "../../../core/panels/registry.ts";
import { panelRefKey, panelRefSchema, type PanelRef } from "../../../core/panels/ref.ts";
import { EntryCard, type CardAction } from "../../../ui/panels/EntryCard.tsx";
import type { ContentSource, SourceItem } from "./content-sources.ts";

type Sdk = ReturnType<typeof useSdk>;
type Navigate = ReturnType<typeof useBbNavigate>;
type Scope = Parameters<Sdk["experimental_desktopBrowsers"]["listTabs"]>[0];

interface CardRoutePort {
  /** False only when the history entry has not been pushed. */
  inDocument(href: string): boolean;
  confirm(message: string): boolean;
  reload(href: string): void;
}

const browserRoutes: CardRoutePort = {
  inDocument(href) {
    // BB's web router listens to popstate and uses the entry index for Back/Forward.
    const index: unknown = window.history.state?.idx;
    if (typeof index !== "number" || !Number.isSafeInteger(index + 1) || index < 0 ||
      typeof window.crypto.randomUUID !== "function") return false;
    const state = { usr: null, key: window.crypto.randomUUID(), idx: index + 1 };
    try {
      window.history.pushState(state, "", href);
    } catch {
      return false;
    }
    window.dispatchEvent(new PopStateEvent("popstate", { state }));
    return true;
  },
  confirm: message => window.confirm(message),
  reload: href => window.location.assign(href),
};

export interface CardHost {
  routes?: CardRoutePort;
  navigate: Pick<Navigate, "toThread" | "experimental_openTerminal" | "experimental_openFilePreview" | "experimental_openFileExternally">;
  plugins: { list(): Promise<{ plugins: readonly { id: string; enabled: boolean; status: string }[] }> };
  desktop: {
    listInstances(input: { hostId: string }): Promise<{ instances: readonly { instanceId: string; hostId: string; generation: string; label: string }[] }>;
    listTabs(input: Scope): Promise<{ tabs: readonly { threadId: string; tabId: string; title: string }[] }>;
    revealTab: Sdk["experimental_desktopBrowsers"]["revealTab"];
  };
  threadTabs: { get(input: { threadId: string }): Promise<{ tabs: readonly { id: string; kind: string }[] }> };
}

export interface CardDirectory {
  items(type: CardType): readonly (SourceItem & { ref: PanelRef })[];
  subscribe(listener: () => void): () => void;
}

async function desktopChoices(host: CardHost, hostId: string, threadId: string): Promise<CardAction[]> {
  const { instances } = await host.desktop.listInstances({ hostId });
  const choices = instances.filter(i => i.hostId === hostId).map(instance => ({
    label: instance.label + " · " + instance.instanceId,
    async run() {
      const scope = { hostId, threadId, instanceId: instance.instanceId, generation: instance.generation };
      const { tabs } = await host.desktop.listTabs(scope);
      const choices = tabs.filter(t => t.threadId === threadId).map(tab => ({
        label: tab.title ? tab.title + " · " + tab.tabId : tab.tabId,
        async run() {
          await host.desktop.revealTab({ ...scope, tabId: tab.tabId });
          return "Desktop обработал запрос показа вкладки.";
        },
      }));
      if (!choices.length) throw Error("В этом экземпляре нет открытых вкладок треда.");
      return choices;
    },
  }));
  if (!choices.length) throw Error("Экземпляры Desktop на выбранном хосте недоступны.");
  return choices;
}

function targetLabel(ref: PanelRef): string | undefined {
  const params = ref.params;
  if ("path" in params) {
    const file = fileTarget(params);
    return file.environmentId + " · " + file.path;
  }
  return Object.values(params).join(" · ") || undefined;
}

/** Resolve only the selected resource. Constructing or restoring a card never navigates. */
export function cardActions(type: CardType, ref: PanelRef, host: CardHost, hasLivePanels: () => boolean = () => true): CardAction[] {
  if (ref.provider !== type) throw Error("Тип ссылки не соответствует карточке.");
  panelRefSchema.parse(ref);
  const data = entryCards[type].paramsSchema.parse(ref.params);
  const href = entryRoute(ref);
  if (href !== null) return [{
    label: "Открыть раздел", href,
    async run() {
      const routes = host.routes ?? browserRoutes;
      if (!routes.inDocument(href)) {
        if (hasLivePanels() && !routes.confirm("Переход перезагрузит Чертог, живые панели закроются")) return "Переход отменён.";
        routes.reload(href);
      }
      return "Переход запрошен.";
    },
  }];
  if ("terminalId" in data) return [{
    label: "Открыть терминал",
    async run() {
      if (!await host.navigate.experimental_openTerminal({ terminalId: data.terminalId })) throw Error("Терминал завершён или панель терминалов недоступна.");
      return "BB обработал запрос открытия терминала.";
    },
  }];
  if ("path" in data) {
    const options = { target: fileTarget(ref.params), location: null };
    const actions: CardAction[] = [{
      label: "Открыть файл", async run() {
        if (!host.navigate.experimental_openFilePreview(options)) throw Error("BB отклонил запрос просмотра файла.");
        return "BB обработал запрос просмотра.";
      },
    }];
    if (type === "bb-editor") actions.push({
      label: "Внешний редактор", async run() {
        if (!host.navigate.experimental_openFileExternally(options)) throw Error("Внешний редактор недоступен.");
        return "BB обработал запрос открытия во внешнем редакторе.";
      },
    });
    return actions;
  }
  if ("hostId" in data) return [{
    label: "Выбрать экземпляр Desktop", run: () => desktopChoices(host, data.hostId, data.threadId),
  }];
  if (type === "app-preview" && "threadId" in data) return [{
    label: "Открыть тред", async run() {
      if ("tabId" in data) {
        const { tabs } = await host.threadTabs.get({ threadId: data.threadId });
        if (!tabs.some(tab => tab.kind === "browser" && tab.id === data.tabId)) throw Error("Вкладка предпросмотра в треде уже закрыта.");
      }
      host.navigate.toThread(data.threadId);
      return "Переход к треду запрошен.";
    },
  }];
  throw Error("Действие для этой ссылки недоступно.");
}

export function createCardSource(type: CardType, host: CardHost, directory?: CardDirectory): ContentSource {
  let registry: PanelRegistry | null = null;
  // Include parked views and pending opens. An unbound source cannot rule out live neighbours.
  const hasLivePanels = () => registry?.list().some(p =>
    p.state === "live" || p.state === "loading" || p.unknownOutcome === "open"
  ) ?? true;
  const card = entryCards[type];
  const sectionRef = { provider: type, params: {} };
  const items = () => {
    if (card.paramsSchema.safeParse({}).success) return [{ id: type, title: card.title, ref: sectionRef }];
    return directory?.items(type).filter(({ ref }) => ref.provider === type &&
      panelRefSchema.safeParse(ref).success && card.paramsSchema.safeParse(ref.params).success) ?? [];
  };
  const refOf = (id: string) => items().find(item => item.id === id)?.ref ?? null;
  async function check() {
    if (card.plugin === null) return;
    const { plugins } = await host.plugins.list();
    const plugin = plugins.find(p => p.id === card.plugin);
    if (!plugin?.enabled) throw Error(card.title + " выключен или не установлен. Ссылка сохранена.");
    if (plugin.status !== "running" && plugin.status !== "degraded") {
      throw Error(card.title + " недоступен (" + plugin.status + "). Ссылка сохранена.");
    }
  }
  return {
    provider: {
      type, paramsSchema: card.paramsSchema, multipleViews: false,
      capabilities: {
        showNativeRoute: type === "diff-review" || type === "bb-terminal" || type === "bb-desktop-tab" ? "yes" : "partial",
        embedInstance: "no", keepLiveInDocument: "no",
        rebindToSession: type === "bb-terminal" ? "partial" : "no",
        transferBetweenWindows: "no", restoreAfterRestart: "partial",
      },
      async open({ ref }) {
        if (ref.provider !== type || !panelRefSchema.safeParse(ref).success || !card.paramsSchema.safeParse(ref.params).success)
          return { status: "access-denied" };
        return { status: "entry" };
      },
      // The card holds no provider resource or external session.
      release() {}, endsSessionOnLastClose: () => false, endSession: async () => "unknown",
    },
    sectionTitle: card.title, neutralLabel: card.title, canEndSession: false,
    offered: () => true, section: () => ({ state: "ready", items: items() }),
    refOf, stableRefOf: refOf,
    label: ref => ref.provider === type && card.paramsSchema.safeParse(ref.params).success
      ? { title: card.title, context: targetLabel(ref) ?? card.purpose } : null,
    render: ref => createElement(EntryCard, { key: panelRefKey(ref), title: card.title, purpose: card.purpose,
      target: targetLabel(ref), check, actions: cardActions(type, ref, host, hasLivePanels) }),
    connect(target) { registry = target instanceof PanelRegistry ? target : null; },
    stateText: () => null,
    subscribe: listener => directory?.subscribe(listener) ?? (() => {}),
  };
}
