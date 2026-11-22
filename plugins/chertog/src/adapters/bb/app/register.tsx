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
  useRealtime,
  useSettings,
  type PluginAppBuilder,
  type PluginSidebarThread,
} from "@get-bb/plugin-sdk/app";
import { useEffect } from "react";
import { WindowOverlay } from "./window-handoff.ts";
import { CHANNEL } from "../../../core/windows/wire.ts";
import type { Diagnostics } from "../../../core/panels/index.ts";
import { createHomeRedirectSection, openNewThreadScreen } from "../home/index.ts";
import { runForTileComposer, tileComposer } from "./addressee.ts";
import { LiveLayer } from "./LiveLayer.tsx";
import { readAcceptanceFixture, readHomeRedirect } from "./settings.ts";
import { appStrings } from "./strings.ts";
import type { ThreadEntry } from "./thread-source.ts";
import { createWindowWorkspace, type WindowWorkspace } from "./window-workspace.ts";
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
function windowWorkspace(): WindowWorkspace {
  current ??= createWindowWorkspace({
    // An existing thread in a bounded container; no thread is created or forked here.
    renderChat: (threadId) => <ThreadChat threadId={threadId} layout="contained" />,
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

function ChertogOverlay() {
  const workspace = windowWorkspace();
  useHostHandles(workspace);

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
            projectName: projectNames.get(thread.projectId) ?? null,
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

function ChertogNavPanel() {
  const workspace = windowWorkspace();
  useHostHandles(workspace);
  const navigate = useBbNavigate();
  return (
    <>
      <ComposerWatch workspace={workspace} />
      <WorkspaceRoute workspace={workspace} onNewThread={() => openNewThreadScreen(navigate)} />
    </>
  );
}

/** The instance of the focused tile, while the window shows the Chertog route. */
function chosenInstance(workspace: WindowWorkspace): string | null {
  return workspace.bridge.getPlace() === null ? null : (workspace.session.focusedInstance()?.instanceId ?? null);
}

export function registerChertogApp(app: PluginAppBuilder): void {
  // No `experimental_sidebar`: BB's own tree of projects and threads stays beside the workspace.
  app.slots.navPanel({
    id: "chertog-home",
    title: appStrings.panelTitle,
    icon: "LayoutGrid",
    path: CHERTOG_PANEL_PATH,
    component: ChertogNavPanel,
  });

  app.slots.experimental_appOverlay({ id: "chertog-live-panels", component: ChertogOverlay });

  app.slots.homepageSection({
    id: "chertog-home-redirect",
    title: appStrings.panelTitle,
    component: createHomeRedirectSection({
      panelPath: CHERTOG_PANEL_PATH,
      openLabel: appStrings.openChertog,
      useRedirectEnabled: () => readHomeRedirect(useSettings().values),
    }),
  });

  // The command reaches the composer BB lists for exactly the thread of the
  // chosen tile, and only when there is one such composer.
  app.commands.register({
    id: "focus-tile-composer",
    title: appStrings.focusComposerCommand,
    isAvailable() {
      const workspace = windowWorkspace();
      const instanceId = chosenInstance(workspace);
      if (instanceId === null) return false;
      const read = (id: string) => workspace.session.registry.addresseeOf(id);
      return tileComposer(read, workspace.composers.list(), instanceId).status === "one";
    },
    async run() {
      const workspace = windowWorkspace();
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
      const workspace = windowWorkspace();
      const instance = workspace.session.focusedInstance();
      if (workspace.bridge.getPlace() === null || instance === null || instance.state !== "live") return false;
      return workspace.session.sourceOf(instance.ref.provider)?.canEndSession === true;
    },
    async run() {
      const workspace = windowWorkspace();
      const instanceId = chosenInstance(workspace);
      if (instanceId !== null) await workspace.session.endSession(instanceId);
    },
  });
}
