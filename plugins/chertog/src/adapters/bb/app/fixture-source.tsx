// The `fixture-frame` panels: the controlled page the plugin's server serves
// for acceptance, in an iframe. Each panel is its own page with its own load
// counters. The content picker offers it only while the owner's acceptance
// setting is on; a saved panel of this kind is shown either way.
import { z } from "zod";
import type { PanelProvider, PanelRef } from "../../../core/panels/index.ts";
import { liveFrameUrlPath } from "../../../core/wire/index.ts";
import { FramePanel } from "../../../ui/live-hosts/index.ts";
import { Listeners, type ContentSource } from "./content-sources.ts";
import { appStrings } from "./strings.ts";

const text = appStrings.fixture;

export const FIXTURE_PROVIDER = "fixture-frame";

/** The one item the picker lists: every choice of it makes a new page. */
const NEW_FRAME_ITEM = "new-frame";

/** `frame` is the page's `?instance=` name; the server accepts the same alphabet. */
const paramsSchema = z.strictObject({ frame: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/) });

export interface FixtureSourceOptions {
  /** The plugin id the host gave this app, for the address of the page. */
  pluginId(): string;
  /** The owner's acceptance setting, as last read. */
  enabled(): boolean;
  /** A new frame name: letters, digits, `-` and `_`. */
  newFrameName(): string;
}

export interface FixtureSource extends ContentSource {
  /** Tells the workspace that the acceptance setting may have changed. */
  settingChanged(): void;
}

export function createFixtureSource({ pluginId, enabled, newFrameName }: FixtureSourceOptions): FixtureSource {
  const listeners = new Listeners();

  const provider: PanelProvider = {
    type: FIXTURE_PROVIDER,
    capabilities: {
      showNativeRoute: "no",
      embedInstance: "yes",
      keepLiveInDocument: "yes",
      rebindToSession: "no",
      transferBetweenWindows: "no",
      restoreAfterRestart: "partial",
    },
    multipleViews: false,
    paramsSchema,
    // The page is the session: it starts with its iframe and lives as long as it.
    open: async () => ({ status: "live", addressee: null }),
    release: () => undefined,
    endsSessionOnLastClose: () => true,
    // The registry marks the session ended, and the frame is unmounted with its page.
    endSession: async () => "ended",
  };

  const frameOf = (ref: PanelRef): string | null => {
    const parsed = paramsSchema.safeParse(ref.params);
    return parsed.success ? parsed.data.frame : null;
  };

  return {
    provider,
    sectionTitle: text.section,
    neutralLabel: text.neutral,
    canEndSession: true,
    offered: enabled,
    section: () => ({ state: "ready", items: [{ id: NEW_FRAME_ITEM, title: text.item, context: text.itemContext }] }),
    refOf: (itemId) => (itemId === NEW_FRAME_ITEM ? { provider: FIXTURE_PROVIDER, params: { frame: newFrameName() } } : null),
    stableRefOf: () => null,
    label(ref) {
      const frame = frameOf(ref);
      return frame === null ? null : { title: text.title(frame) };
    },
    render(ref) {
      const frame = paramsSchema.parse(ref.params).frame;
      return <FramePanel src={liveFrameUrlPath(pluginId(), frame)} title={text.title(frame)} />;
    },
    stateText: (state) => (state === "session-ended" ? { title: text.endedTitle, description: text.endedText } : null),
    subscribe: listeners.subscribe,
    settingChanged: () => listeners.notify(),
  };
}
