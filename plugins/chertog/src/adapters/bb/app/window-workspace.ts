// Everything one BB window keeps for Chertog while the window lives: the
// session with its registry of live panels, the directories BB fills in, the
// bridge between the route and the live layer. It is created once and
// outlives every visit of the Chertog route.
import type { Diagnostics } from "../../../core/panels/index.ts";
import { ComposerDirectory } from "./addressee.ts";
import type { ContentSource } from "./content-sources.ts";
import { createFixtureSource, type FixtureSource } from "./fixture-source.tsx";
import { SurfaceBridge } from "./surface-bridge.ts";
import { createThreadSource, ThreadDirectory } from "./thread-source.ts";
import { createWorkspaceRpcPort, type WorkspaceRpcClient } from "./workspace-controller.ts";
import { WorkspaceSession } from "./workspace-session.ts";
import type { ReactNode } from "react";

export interface WindowWorkspace {
  readonly session: WorkspaceSession;
  readonly bridge: SurfaceBridge;
  readonly threads: ThreadDirectory;
  readonly composers: ComposerDirectory;
  readonly fixture: FixtureSource;
  /** What the host hands to components and the session reads later. */
  readonly host: {
    rpc: WorkspaceRpcClient | null;
    pluginId: string | null;
    acceptanceFixture: boolean;
  };
}

export interface WindowWorkspaceOptions {
  /** Draws the chat of an existing thread. */
  renderChat(threadId: string): ReactNode;
  /** Random lowercase letters and digits. */
  randomId(): string;
  readonly diagnostics: Diagnostics;
  /** Sources beyond the two of stage A. */
  readonly extraSources?: readonly ContentSource[];
}

export function createWindowWorkspace(options: WindowWorkspaceOptions): WindowWorkspace {
  const host: WindowWorkspace["host"] = { rpc: null, pluginId: null, acceptanceFixture: false };
  const threads = new ThreadDirectory();
  const fixture = createFixtureSource({
    pluginId: () => {
      if (host.pluginId === null) throw new Error("The plugin id is not known yet");
      return host.pluginId;
    },
    enabled: () => host.acceptanceFixture,
    newFrameName: () => "frame-" + options.randomId(),
  });
  const session = new WorkspaceSession({
    rpc: createWorkspaceRpcPort(() => {
      if (host.rpc === null) throw new Error("BB has not given this window its RPC client yet");
      return host.rpc;
    }),
    sources: [createThreadSource({ directory: threads, renderChat: options.renderChat }), fixture, ...(options.extraSources ?? [])],
    newId: (prefix) => prefix + "-" + options.randomId(),
    diagnostics: options.diagnostics,
  });
  return { session, bridge: new SurfaceBridge(), threads, composers: new ComposerDirectory(), fixture, host };
}
