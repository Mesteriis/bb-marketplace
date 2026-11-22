// What the workspace needs from whoever supplies a kind of panel, on top of
// the core's provider port: the list for the content picker, the live title
// of a panel by its reference, and the content to mount for a live instance.
import type { ReactNode } from "react";
import type { PanelProvider, PanelRef, PanelRegistry, PanelState } from "../../../core/panels/index.ts";
import type { ContentSectionState } from "../../../ui/chrome/index.ts";
import type { PanelLabel } from "../../../ui/tiles/index.ts";

export interface SourceItem {
  readonly id: string;
  readonly title: string;
  readonly context?: string;
  readonly status?: string;
}

export interface SourceSection {
  readonly state: ContentSectionState;
  readonly items: readonly SourceItem[];
}

/** Text that replaces the default explanation of a panel state. */
export interface PanelStateText {
  readonly title: string;
  readonly description: string;
}

export interface ContentSource {
  /** The provider the panel registry asks to open, release and end a panel. */
  readonly provider: PanelProvider;
  /** Heading of the provider's section in the content picker. */
  readonly sectionTitle: string;
  /** What a tile shows until the provider tells the panel's own title. */
  readonly neutralLabel: string;
  /** Whether the user may end the session of a live panel through Chertog. */
  readonly canEndSession: boolean;
  /** Whether the content picker lists this source now. A source that is not offered still shows its saved panels. */
  offered(): boolean;
  section(): SourceSection;
  /** Controls for selecting the scope of a catalog before choosing an item. */
  controls?(): ReactNode;
  /** The reference to open for a listed item, or `null` when the item is not listed any more. */
  refOf(itemId: string): PanelRef | null;
  /**
   * The reference a listed item always stands for, so the picker can tell
   * that it is already open; `null` when every choice of the item makes a
   * new panel.
   */
  stableRefOf(itemId: string): PanelRef | null;
  /** The panel's title, context and status as the provider knows them now; `null` until it does. */
  label(ref: PanelRef): PanelLabel | null;
  /** The content of a live instance. Called once per instance while it stays live. */
  render(ref: PanelRef, instanceId: string): ReactNode;
  /** The provider's own words for a state of its panel, or `null` for the default text. */
  stateText(state: PanelState, ref: PanelRef): PanelStateText | null;
  /** Lets the source tell the registry that a live panel stopped being live. */
  connect?(registry: Pick<PanelRegistry, "report">): void;
  subscribe(listener: () => void): () => void;
}

/** A set of listeners with the usual subscribe and notify. */
export class Listeners {
  private readonly listeners = new Set<() => void>();

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  notify(): void {
    for (const listener of [...this.listeners]) listener();
  }
}
