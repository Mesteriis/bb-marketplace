// Chertog in a BB window: the nav panel that is the workspace route, the app
// overlay that keeps live panels for the life of the window, the Home
// section that redirects to the route, and the commands for the chosen tile.
// Everything BB-specific is read here through the public SDK and handed to
// the workspace as plain data.
import {
  experimental_usePluginId,
  experimental_useSidebarThreads,
  ThreadChat,
  useBbNavigate,
  useComposers,
  useRpc,
  useSdk,
  useRealtime,
  useSettings,
  type PluginAppBuilder,
  type PluginSidebarThread,
} from "@get-bb/plugin-sdk/app";
import { useEffect, useMemo } from "react";
import { WindowOverlay } from "./window-handoff.ts";
import { CHANNEL } from "../../../core/windows/wire.ts";
import type { Diagnostics } from "../../../core/panels/index.ts";
import { createHomeRedirectSection, openNewThreadScreen } from "../home/index.ts";
import { runForTileComposer, tileComposer } from "./addressee.ts";
import { embeddedSources } from "./embedded-source.tsx";
import { providerSources } from "./provider-sources.tsx";
import { useOpenRequests, whenShown } from "./open-requests.ts";
import { LiveLayer } from "./LiveLayer.tsx";
import { readAcceptanceFixture, readHomeRedirectEffective, readTileSpace } from "./settings.ts";
import { appStrings } from "./strings.ts";
import type { ThreadEntry } from "./thread-source.ts";
import { createWindowWorkspace, type WindowWorkspace } from "./window-workspace.ts";
import { TileTitle } from "../../../ui/chrome/index.ts";
import { ChertogHeaderActions, ChertogHeaderTitle, useChertogPageTitle } from "./WorkspaceHeader.tsx";
import { WorkspaceRoute } from "./WorkspaceRoute.tsx";

/** `path` of the nav panel: the route is `/plugins/chertog/home`. */
export const CHERTOG_PANEL_PATH = "home";

const diagnostics: Diagnostics = {
  failure: (where, error) => console.error("[chertog] " + where, error),
};

function randomId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

let current: WindowWorkspace | null = null;

/** This window's workspace. The plugin app is loaded once per window, and so is this. */
function useWindowWorkspace(): WindowWorkspace {
  const sdk = useSdk();
  const navigate = useBbNavigate();
  current ??= createWindowWorkspace({
    // An existing thread in a bounded container; no thread is created or forked here.
    renderChat: (threadId) => <ThreadChat threadId={threadId} layout="contained" />,
    extraSources: threads => [...providerSources(sdk, navigate, threads), ...embeddedSources()],
    randomId,
    diagnostics,
  });
  return current;
}

const BUSY: ReadonlySet<string> = new Set(["starting", "active", "stopping"]);

function statusOf(thread: PluginSidebarThread): ThreadEntry["status"] {
  if (thread.hasPendingInteraction) return { tone: "attention", label: appStrings.threads.waiting };
  if (BUSY.has(thread.status)) return { tone: "busy", label: appStrings.threads.working };
  if (thread.isUnread) return { tone: "idle", label: appStrings.threads.unread };
  return undefined;
}

/** Hands what BB gives a component of this plugin to the window's workspace. */
function useHostHandles(workspace: WindowWorkspace): void {
  const rpc = useRpc();
  workspace.host.rpc = { call: (method: string, input: unknown) => rpc.call(method, input) };
  workspace.host.pluginId = experimental_usePluginId();
}

/** The «Тайловое пространство» switch as the window sees it; `null` until BB delivers the values. */
function useTileSpace(): boolean | null {
  return readTileSpace(useSettings().values);
}

/** Set by the overlay, which BB keeps mounted: the commands read it, they have no hooks. */
let tileSpaceOn = false;

/** Mounts the workspace's overlay only while the switch is on: off, it holds no listener and no subscription. */
function ChertogOverlay() {
  const tileSpace = useTileSpace();
  useEffect(() => {
    tileSpaceOn = tileSpace === true;
    return () => {
      tileSpaceOn = false;
    };
  }, [tileSpace]);
  return tileSpace === true ? <ChertogLiveOverlay /> : null;
}

function ChertogLiveOverlay() {
  const workspace = useWindowWorkspace();
  useHostHandles(workspace);
  const openTarget = useMemo(() => whenShown(workspace.session, () => workspace.bridge.getPlace() !== null), [workspace]);
  useOpenRequests(openTarget);

  const { status, threads, projects } = experimental_useSidebarThreads();
  useEffect(() => {
    if (status !== "ready") {
      workspace.threads.set({ status });
      return;
    }
    const projectNames = new Map(projects.map((project) => [project.id, project.isPersonal ? null : project.name]));
    workspace.threads.set({
      status: "ready",
      threads: threads
        .filter((thread) => !thread.isHidden && !thread.isArchived)
        .map((thread) => {
          const entryStatus = statusOf(thread);
          return {
            id: thread.id,
            title: thread.displayTitle,
            hostId: thread.host?.id,
            projectName: projectNames.get(thread.projectId) ?? null,
            ...(thread.parentThreadId === null ? {} : { parentThreadId: thread.parentThreadId }),
            ...(entryStatus === undefined ? {} : { status: entryStatus }),
          };
        }),
    });
  }, [workspace, status, threads, projects]);

  const acceptanceFixture = readAcceptanceFixture(useSettings().values);
  useEffect(() => {
    workspace.host.acceptanceFixture = acceptanceFixture;
    workspace.fixture.settingChanged();
  }, [workspace, acceptanceFixture]);

  const rpc = useRpc();
  useRealtime(CHANNEL, () => { void workspace.handoff.sync(); });
  return (
    <WindowOverlay workspace={workspace} call={(method, input) => rpc.call(method, input)}>
      <LiveLayer workspace={workspace} diagnostics={diagnostics} />
    </WindowOverlay>
  );
}

/**
 * Reports the composers on screen. It is a component of its own because BB
 * re-renders the caller of `useComposers()` on every keystroke in a draft.
 */
function ComposerWatch({ workspace }: { workspace: WindowWorkspace }) {
  const composers = useComposers();
  useEffect(() => {
    workspace.composers.set(composers);
  }, [workspace, composers]);
  useEffect(() => () => workspace.composers.set([]), [workspace]);
  return null;
}

/** What the route says with the switch off: one line, and where to turn it on. */
function TileSpaceOff() {
  return (
    <div data-chertog-tile-space-off className="p-6 text-sm text-muted-foreground">
      <p>{appStrings.tileSpaceOff}</p>
      <p>{appStrings.tileSpaceOffWhere}</p>
    </div>
  );
}

function ChertogNavPanel() {
  const tileSpace = useTileSpace();
  if (tileSpace === null) return null;
  return tileSpace ? <ChertogWorkspacePanel /> : <TileSpaceOff />;
}

function ChertogWorkspacePanel() {
  const workspace = useWindowWorkspace();
  useHostHandles(workspace);
  return (
    <>
      <ComposerWatch workspace={workspace} />
      <WorkspaceRoute workspace={workspace} />
    </>
  );
}

// BB renders these two in its shared title bar, in the plugin's own scope
// (observed on BB 0.50.1: inside the plugin root, so the scoped classes of
// the chrome apply there).
function ChertogHeaderTitleSlot() {
  const tileSpace = useTileSpace();
  if (tileSpace === null) return null;
  // Off: the name only, no tile and no menu.
  if (!tileSpace) return <TileTitle tile={null} fallback={appStrings.panelTitle} menuLabel={appStrings.focusedTileMenu} menuItems={[]} />;
  return <ChertogLiveHeaderTitle />;
}

function ChertogLiveHeaderTitle() {
  const workspace = useWindowWorkspace();
  useHostHandles(workspace);
  return <ChertogHeaderTitle workspace={workspace} />;
}

function ChertogHeaderActionsSlot() {
  return useTileSpace() === true ? <ChertogLiveHeaderActions /> : null;
}

function ChertogLiveHeaderActions() {
  const workspace = useWindowWorkspace();
  useHostHandles(workspace);
  const navigate = useBbNavigate();
  return <ChertogHeaderActions workspace={workspace} onNewThread={() => openNewThreadScreen(navigate)} />;
}

function useChertogPageTitleSlot() {
  const tileSpace = useTileSpace();
  const title = useChertogPageTitle(useWindowWorkspace());
  return tileSpace === true ? title : null;
}

/** The instance of the focused tile, while the window shows the Chertog route. */
function chosenInstance(workspace: WindowWorkspace): string | null {
  return !tileSpaceOn || workspace.bridge.getPlace() === null ? null : (workspace.session.focusedInstance()?.instanceId ?? null);
}

export function registerChertogApp(app: PluginAppBuilder): void {
  // No `experimental_sidebar`: BB's own tree of projects and threads stays beside the workspace.
  app.slots.navPanel({
    id: "chertog-home",
    title: appStrings.panelTitle,
    icon: "LayoutGrid",
    path: CHERTOG_PANEL_PATH,
    component: ChertogNavPanel,
    experimental_headerTitle: ChertogHeaderTitleSlot,
    headerContent: ChertogHeaderActionsSlot,
    experimental_usePageTitle: useChertogPageTitleSlot,
  });

  app.slots.experimental_appOverlay({ id: "chertog-live-panels", component: ChertogOverlay });

  app.slots.homepageSection({
    id: "chertog-home-redirect",
    title: appStrings.panelTitle,
    component: createHomeRedirectSection({
      panelPath: CHERTOG_PANEL_PATH,
      openLabel: appStrings.openChertog,
      useRedirectEnabled: () => readHomeRedirectEffective(useSettings().values),
    }),
  });

  // The command reaches the composer BB lists for exactly the thread of the
  // chosen tile, and only when there is one such composer.
  app.commands.register({
    id: "focus-tile-composer",
    title: appStrings.focusComposerCommand,
    isAvailable() {
      const workspace = current;
      if (!workspace) return false;
      const instanceId = chosenInstance(workspace);
      if (instanceId === null) return false;
      const read = (id: string) => workspace.session.registry.addresseeOf(id);
      return tileComposer(read, workspace.composers.list(), instanceId).status === "one";
    },
    async run() {
      const workspace = current;
      if (!workspace) return;
      const instanceId = chosenInstance(workspace);
      if (instanceId === null) return;
      await runForTileComposer(
        (id) => workspace.session.registry.addresseeOf(id),
        workspace.composers.list,
        instanceId,
        async () => undefined,
        (composer) => composer.focus(),
      );
    },
  });

  // Ending a session is never a side effect of a layout change: only this command asks for it.
  app.commands.register({
    id: "end-panel-session",
    title: appStrings.endSessionCommand,
    isAvailable() {
      const workspace = current;
      if (!workspace || !tileSpaceOn) return false;
      const instance = workspace.session.focusedInstance();
      if (workspace.bridge.getPlace() === null || instance === null || instance.state !== "live") return false;
      return workspace.session.sourceOf(instance.ref.provider)?.canEndSession === true;
    },
    async run() {
      const workspace = current;
      if (!workspace) return;
      const instanceId = chosenInstance(workspace);
      if (instanceId !== null) await workspace.session.endSession(instanceId);
    },
  });
}
