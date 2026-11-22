// The questions the workspace chrome asks, and the actions that raise them.
// The title bar and the route are separate components that BB mounts apart,
// so what both can start (close a panel, choose a tile for a panel) lives
// here, in the window's workspace; the route draws the dialogs.
import { listGroups } from "../../../core/layout/index.ts";
import type { ContentChoice } from "../../../ui/chrome/index.ts";
import { Listeners } from "./content-sources.ts";
import type { ContentDestination, WorkspaceSession } from "./workspace-session.ts";

export interface ClosingPanel {
  readonly panelId: string;
  readonly title: string;
  /** Whether the open layout places the panel: only then can it be hidden instead. */
  readonly placed: boolean;
  /** Linked tiles that close with it. */
  readonly linkedCount: number;
}

/** The open questions of one window: which panel is being closed, which content waits for a tile. */
export class ChromeDialogs {
  private closingPanel: ClosingPanel | null = null;
  private placingChoice: ContentChoice | null = null;
  private version = 0;
  private readonly listeners = new Listeners();

  subscribe = this.listeners.subscribe;
  getVersion = (): number => this.version;

  get closing(): ClosingPanel | null {
    return this.closingPanel;
  }

  get placing(): ContentChoice | null {
    return this.placingChoice;
  }

  setClosing(closing: ClosingPanel | null): void {
    this.closingPanel = closing;
    this.touch();
  }

  setPlacing(choice: ContentChoice | null): void {
    this.placingChoice = choice;
    this.touch();
  }

  private touch(): void {
    this.version += 1;
    this.listeners.notify();
  }
}

export interface ChromeActions {
  /** Opens content; a choice that needs the user to pick a tile raises that question instead. */
  open(choice: ContentChoice, destination: ContentDestination): void;
  /** Raises the question for closing a panel. */
  askToClose(panelId: string): void;
  /** Closes a panel, asking first when closing needs a confirmation. */
  requestClose(panelId: string): Promise<void>;
  requestCloseInstance(instanceId: string): void;
}

export function chromeActions(session: WorkspaceSession, dialogs: ChromeDialogs): ChromeActions {
  const placed = (panelId: string): boolean => {
    const state = session.surfaceState();
    return state !== null && listGroups(state.root).some((group) => group.tabs.includes(panelId));
  };
  const askToClose = (panelId: string): void =>
    // Which question to ask is read from the session when the answer comes, not from what a render drew.
    dialogs.setClosing({ panelId, title: session.labelOf(panelId).title, placed: placed(panelId), linkedCount: session.linkedCountOf(panelId) });
  const requestClose = async (panelId: string): Promise<void> => {
    if ((await session.closePanel(panelId)) === "needs-confirmation") askToClose(panelId);
  };
  return {
    open(choice, destination) {
      if (choice.placement === "pick-place") dialogs.setPlacing(choice);
      else session.openContent(choice, destination);
    },
    askToClose,
    requestClose,
    requestCloseInstance(instanceId) {
      const panelId = session.panelOfInstance(instanceId);
      if (panelId !== null) void requestClose(panelId);
    },
  };
}
