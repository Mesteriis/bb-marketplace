// Mail settings -> Inbox -> Tabs (Split Inbox): the owner's Inbox tabs as a
// list with rename, condition, order and remove, and the library of ready
// tabs. The same dialogs as the row over the Inbox.
import { useCallback, useEffect, useState } from "react";
import { TABS_MAX, TAB_LIBRARY } from "../../core/inbox-tabs.ts";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { TabEditDialog, TabLibraryDialog, libraryLeft, type TabRequest } from "../inbox-tabs.tsx";
import { tx } from "../i18n/index.ts";
import { SectionHeading } from "./primitives.tsx";
import { messageOf } from "./shared.ts";

export interface TabSettingView {
  id: string;
  name: string;
  query: string;
  /** The condition no longer parses. */
  broken: boolean;
}

/** The page's calls for the Tabs group; each rejects with the reason. */
export interface InboxTabsPort {
  load: () => Promise<TabSettingView[]>;
  /** A new tab (no id) or a tab's new name and condition. */
  save: (input: { id?: string; name: string; query: string }) => Promise<void>;
  move: (id: string, direction: "left" | "right") => Promise<void>;
  remove: (id: string) => Promise<void>;
}

type EditRequest = Exclude<TabRequest, { kind: "library" } | { kind: "menu" }>;

export function TabsSettings({ port }: { port: InboxTabsPort }) {
  const [tabs, setTabs] = useState<TabSettingView[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [library, setLibrary] = useState(false);
  const [edit, setEdit] = useState<EditRequest | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    try {
      setTabs(await port.load());
    } catch (error) {
      setProblem(messageOf(error, "Could not load the tabs."));
    }
  }, [port]);
  useEffect(() => {
    void reload();
  }, [reload]);

  /** A change from the list itself: its failure shows under the list. */
  const change = (call: () => Promise<void>) => {
    setProblem(null);
    setBusy(true);
    call()
      .then(reload, (error: unknown) => setProblem(messageOf(error, "Could not change the tabs.")))
      .finally(() => setBusy(false));
  };
  /** A save from a dialog: its failure stays in the dialog. */
  const save = async (input: { id?: string; name: string; query: string }) => {
    await port.save(input);
    await reload();
  };
  const asRow = (tab: TabSettingView) => ({ ...tab, unread: 0 });

  return (
    <>
      <SectionHeading
        action={
          <Button variant="outline" size="sm" className="h-7" disabled={tabs === null} onClick={() => setLibrary(true)}>
            {tx("Add a tab…")}
          </Button>
        }
      >
        {tx("Tabs")}
      </SectionHeading>
      <p className="text-xs text-muted-foreground">
        {tx("Tabs over the Inbox, each showing the conversations that match its condition. The ] and [ keys switch between them.")}
      </p>
      {tabs === null && problem === null ? <p className="text-sm text-muted-foreground">{tx("Loading…")}</p> : null}
      {tabs !== null && tabs.length === 0 ? (
        <p className="text-sm text-muted-foreground">{tx("No tabs yet: the Inbox is one list.")}</p>
      ) : null}
      {tabs !== null && tabs.length > 0 ? (
        <ul aria-label={tx("Inbox tabs")} className="flex flex-col divide-y divide-border rounded-md border border-border">
          {tabs.map((tab, index) => (
            <li key={tab.id} aria-label={tab.name} className="flex flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2">
              <div className="flex min-w-0 flex-1 basis-40 flex-col">
                <span className="truncate text-sm text-foreground">{tab.name}</span>
                {tab.broken ? (
                  <span className="text-xs text-destructive">{tx("This tab's condition no longer works")}</span>
                ) : (
                  <span className="break-all text-xs text-muted-foreground">{tab.query}</span>
                )}
              </div>
              <div className="flex shrink-0 flex-wrap items-center gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  className="size-7 p-0"
                  disabled={busy || index === 0}
                  aria-label={tx("Move {p1} up", { p1: tab.name })}
                  onClick={() => change(() => port.move(tab.id, "left"))}
                >
                  <Icon name="ArrowUp" aria-hidden />
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="size-7 p-0"
                  disabled={busy || index === tabs.length - 1}
                  aria-label={tx("Move {p1} down", { p1: tab.name })}
                  onClick={() => change(() => port.move(tab.id, "right"))}
                >
                  <Icon name="ArrowDown" aria-hidden />
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7"
                  aria-label={tx("Rename {p1}", { p1: tab.name })}
                  onClick={() => setEdit({ kind: "rename", tab: asRow(tab) })}
                >
                  {tx("Rename…")}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7"
                  aria-label={tx("Edit the condition of {p1}", { p1: tab.name })}
                  onClick={() => setEdit({ kind: "edit", tab: asRow(tab) })}
                >
                  {tx("Condition…")}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 text-destructive"
                  disabled={busy}
                  aria-label={tx("Remove {p1}", { p1: tab.name })}
                  onClick={() => change(() => port.remove(tab.id))}
                >
                  {tx("Remove")}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      ) : null}
      {problem !== null ? (
        <p role="alert" className="text-xs text-destructive">
          {tx(problem)}
        </p>
      ) : null}
      <TabLibraryDialog
        open={library}
        left={libraryLeft(TAB_LIBRARY, tabs ?? [])}
        full={(tabs?.length ?? 0) >= TABS_MAX}
        onAdd={(tab) => save(tab)}
        onOwn={() => {
          setLibrary(false);
          setEdit({ kind: "new", name: "", query: "" });
        }}
        onClose={() => setLibrary(false)}
      />
      <TabEditDialog
        request={edit}
        onSave={async (result) => {
          if (result.kind === "new") await save({ name: result.name, query: result.query });
          else {
            const tab = tabs?.find((t) => t.id === result.id);
            if (tab === undefined) throw new Error("Unknown tab");
            await save(
              result.kind === "rename" ? { id: tab.id, name: result.name, query: tab.query } : { id: tab.id, name: tab.name, query: result.query },
            );
          }
          setEdit(null);
        }}
        onCancel={() => setEdit(null)}
      />
    </>
  );
}
