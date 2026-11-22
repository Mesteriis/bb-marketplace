import type { PluginBrowserBbSdk, useBbNavigate } from "@get-bb/plugin-sdk/app";
import { entryCards, type CardType } from "../../../core/panels/entry-card.ts";
import type { PanelRef } from "../../../core/panels/ref.ts";
import { classes } from "../../../ui/chrome/primitives.tsx";
import { CatalogControls } from "./CatalogControls.tsx";
import { createCardSource, type CardDirectory } from "./card-source.ts";
import { createDiffSource, workspaceRevisions } from "./diff-source.tsx";
import { createFilePreviewSource, WorkspaceFileCatalog } from "./file-preview-source.tsx";
import { Listeners, type ContentSource, type SourceItem, type SourceSection } from "./content-sources.ts";
import type { ThreadDirectory } from "./thread-source.ts";

type Row = SourceItem & { ref: PanelRef };

export function providerSources(sdk: PluginBrowserBbSdk, navigate: ReturnType<typeof useBbNavigate>, threads: ThreadDirectory): ContentSource[] {
  const host = { navigate, plugins: sdk.plugins, desktop: sdk.experimental_desktopBrowsers, threadTabs: sdk.threads.tabs };
  const files = new WorkspaceFileCatalog(sdk.environments);
  const comparisons = new WorkspaceFileCatalog(sdk.environments);
  const preview = createFilePreviewSource(files);
  const diff = createDiffSource(comparisons, sdk.files, workspaceRevisions(sdk.plugins));
  const changes = new Listeners();
  let terminalState: SourceSection["state"] = "ready";
  let terminals: Row[] = [];
  let terminalGeneration = 0;
  let selectedThread = "";
  const directory: CardDirectory = {
    subscribe(listener) {
      const stops = [changes.subscribe(listener), files.subscribe(listener), threads.subscribe(listener)];
      return () => stops.forEach(stop => stop());
    },
    items(type): Row[] {
      if (type === "bb-terminal") return terminals;
      if (type === "markdown-editor" || type === "bb-editor") {
        return files.snapshot.items.flatMap(item => {
          const params = files.params(item.id);
          return params ? [{ ...item, ref: { provider: type, params } }] : [];
        });
      }
      const state = threads.get();
      if (state.status !== "ready") return [];
      return state.threads.flatMap(thread => {
        const threadId = thread.id;
        let ref: PanelRef;
        if (type === "diff-review") ref = { provider: type, params: { kind: "uncommitted", threadId } };
        else if (type === "app-preview") ref = { provider: type, params: { threadId } };
        else if (type === "bb-desktop-tab" && thread.hostId) ref = { provider: type, params: { hostId: thread.hostId, threadId } };
        else return [];
        return [{ id: threadId, title: thread.title, ref }];
      });
    },
  };
  async function selectTerminals(threadId: string) {
    const turn = ++terminalGeneration;
    selectedThread = threadId;
    terminals = [];
    terminalState = "loading";
    changes.notify();
    try {
      const { sessions } = await sdk.terminals.list({ scope: { kind: "thread", threadId } });
      if (turn !== terminalGeneration) return;
      terminals = sessions.filter(row => row.threadId === threadId && row.status === "running").map(row => ({
        id: row.id, title: row.title, ref: { provider: "bb-terminal", params: { terminalId: row.id } },
      }));
      terminalState = "ready";
    } catch {
      if (turn !== terminalGeneration) return;
      terminalState = "denied";
    }
    changes.notify();
  }
  const cards = (Object.keys(entryCards) as CardType[]).map(type => {
    const card = createCardSource(type, host, directory);
    if (type === "bb-editor" || type === "markdown-editor") card.controls = () => <CatalogControls catalog={files} />;
    if (type === "bb-terminal") {
      const section = card.section;
      card.section = () => ({ ...section(), state: terminalState });
      card.controls = () => {
        const state = threads.get();
        return <select aria-label="Тред терминала" className={classes.input} value={selectedThread}
          onChange={event => void selectTerminals(event.target.value)}>
          <option value="" disabled>Выберите тред терминала</option>
          {state.status === "ready" && state.threads.map(thread => <option key={thread.id} value={thread.id}>{thread.title}</option>)}
        </select>;
      };
    }
    return card;
  });
  return [...cards, { ...preview, controls: () => <CatalogControls catalog={files} /> },
    { ...diff, controls: () => <CatalogControls catalog={comparisons} diff={diff} /> }];
}
