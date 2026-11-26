import { useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { ConfigResult } from "../core/contract";
import type { CatalogApi, Notify, Setup } from "./api";
import { CollectionTab } from "./collection-tab";
import { InstalledTab } from "./installed-tab";
import { SearchTab } from "./search-tab";
import { useLoad } from "./use-load";

const TABS = [
  { id: "installed", label: "Стоящие" },
  { id: "collection", label: "Коллекция" },
  { id: "search", label: "Поиск" },
] as const;
type TabId = (typeof TABS)[number]["id"];

interface Props {
  api: CatalogApi;
  notify: Notify;
  openUrl: (url: string) => void;
}

const SETTING_HELP = {
  marketplaceRepoPath: {
    label: "Рабочая копия репозитория маркетплейса",
    needs: "без неё нельзя ставить, обновлять и принимать проверки",
    placeholder: "<путь к рабочей копии>",
  },
  marketplaceProjectId: {
    label: "Проект маркетплейса в BB",
    needs: "без него нельзя запускать проверки",
    placeholder: "<id проекта>",
  },
} as const;

function SetupNotice({ config }: { config: ConfigResult }) {
  if (config.missing.length === 0) return null;
  return (
    <div role="status" className="flex flex-col gap-1 border-b border-border px-4 py-2 text-xs text-muted-foreground">
      <p className="font-medium text-foreground">Каталог не настроен. Задайте в настройках плагина «MCP Каталог» или командой:</p>
      <ul className="flex flex-col gap-1">
        {config.missing.map((name) => (
          <li key={name}>
            {`${SETTING_HELP[name].label}: ${SETTING_HELP[name].needs}.`}
            <code className="block select-all font-mono">{`bb plugin config ${config.pluginId} set ${name} ${SETTING_HELP[name].placeholder}`}</code>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function CatalogPage({ api, notify, openUrl }: Props) {
  const [tab, setTab] = useState<TabId>("installed");
  // A tab mounts when first opened and stays mounted (hidden), so a search survives a tab switch.
  const [visited, setVisited] = useState<Set<TabId>>(() => new Set(["installed"]));
  const [tick, setTick] = useState(0);
  const refresh = () => setTick((value) => value + 1);
  const config = useLoad(() => api.config(), tick);
  // Until the settings are known nothing is disabled; the server refuses an action that needs an empty one anyway.
  const missing = config.state.kind === "ready" ? config.state.data.missing : [];
  const setup: Setup = { repo: !missing.includes("marketplaceRepoPath"), project: !missing.includes("marketplaceProjectId") };

  const select = (id: TabId) => {
    setTab(id);
    setVisited((current) => (current.has(id) ? current : new Set(current).add(id)));
  };

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <header className="flex items-center gap-2 border-b border-border px-4 py-2">
        <div role="tablist" aria-label="Разделы" className="flex rounded-md border border-input p-0.5">
          {TABS.map(({ id, label }) => (
            <button
              key={id}
              type="button"
              role="tab"
              id={`catalog-tab-${id}`}
              aria-selected={tab === id}
              aria-controls={`catalog-panel-${id}`}
              className={cn("rounded px-2.5 py-1 text-xs font-medium", tab === id ? "bg-secondary" : "text-muted-foreground")}
              onClick={() => select(id)}
            >
              {label}
            </button>
          ))}
        </div>
        <Button className="ml-auto" size="sm" variant="ghost" onClick={refresh}>
          Обновить
        </Button>
      </header>
      {config.state.kind === "ready" && <SetupNotice config={config.state.data} />}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {visited.has("installed") && (
          <div role="tabpanel" id="catalog-panel-installed" aria-labelledby="catalog-tab-installed" hidden={tab !== "installed"}>
            <InstalledTab api={api} notify={notify} tick={tick} openUrl={openUrl} onChanged={refresh} setup={setup} />
          </div>
        )}
        {visited.has("collection") && (
          <div role="tabpanel" id="catalog-panel-collection" aria-labelledby="catalog-tab-collection" hidden={tab !== "collection"}>
            <CollectionTab api={api} notify={notify} tick={tick} onChanged={refresh} setup={setup} />
          </div>
        )}
        {visited.has("search") && (
          <div role="tabpanel" id="catalog-panel-search" aria-labelledby="catalog-tab-search" hidden={tab !== "search"}>
            <SearchTab api={api} notify={notify} tick={tick} onChanged={refresh} setup={setup} />
          </div>
        )}
      </div>
    </div>
  );
}
