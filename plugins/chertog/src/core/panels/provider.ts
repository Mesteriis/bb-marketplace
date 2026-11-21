// The provider port: what Chertog requires from whoever owns a kind of panel
// (BB threads, Telegram, Zoom, Remote Hub, …). The names are Chertog's own
// vocabulary, not methods of the BB SDK; an adapter maps them to a provider.
import type { PanelRef } from "./ref.ts";

/**
 * How far a provider supports one capability. `partial` works with a stated
 * limitation; `unverified` has not been checked on a running provider and
 * must not be presented as a guarantee.
 */
export type PanelCapabilityLevel = "yes" | "partial" | "no" | "unverified";

/** Independent capabilities: none of them implies another. */
export interface PanelCapabilities {
  /** Show the provider's own route. */
  readonly showNativeRoute: PanelCapabilityLevel;
  /** Embed one specific instance into a container Chertog gives. */
  readonly embedInstance: PanelCapabilityLevel;
  /** Keep the live view alive while it moves inside one document. */
  readonly keepLiveInDocument: PanelCapabilityLevel;
  /** Safely attach a new view to a session that already exists. */
  readonly rebindToSession: PanelCapabilityLevel;
  /** Hand the same native view over to another window. */
  readonly transferBetweenWindows: PanelCapabilityLevel;
  /** Resolve a saved reference after a restart. */
  readonly restoreAfterRestart: PanelCapabilityLevel;
}

/**
 * What a tile shows about its panel.
 *
 * - `loading`: the provider has been asked and has not answered.
 * - `provider-missing`: no provider of this type is registered; the reference is kept.
 * - `session-ended`: the provider's session is over.
 * - `access-denied`: the provider refused access.
 * - `live`: the provider confirmed a live view.
 * - `lost`: the view is gone or its fate is unknown; it is never shown as restored.
 */
export type PanelState = "loading" | "provider-missing" | "session-ended" | "access-denied" | "live" | "lost";

export interface PanelOpenRequest {
  /** The instance the view belongs to. Stable across layouts and moves. */
  readonly instanceId: string;
  readonly ref: PanelRef;
}

/**
 * The provider's answer to an open request. `unknown` means the provider
 * cannot tell whether a view or a session was opened.
 */
export type PanelOpenOutcome =
  | {
      readonly status: "live";
      /** Identity of who receives input from this panel, or null when it takes none. */
      readonly addressee: string | null;
    }
  | { readonly status: "session-ended" | "access-denied" | "lost" | "unknown" };

export type PanelEndSessionOutcome = "ended" | "unknown";

export interface PanelProvider {
  /** Provider type, matched against `PanelRef.provider`. */
  readonly type: string;
  readonly capabilities: PanelCapabilities;
  /** Whether one session may have several views open at once. */
  readonly multipleViews: boolean;

  /**
   * Opens a view for the instance. Called again for the same instance only
   * after an explicit retry; the new view then replaces the earlier one.
   * A rejection is treated as an unknown outcome.
   */
  open(request: PanelOpenRequest): Promise<PanelOpenOutcome>;

  /**
   * Frees the view and its handlers. Called at most once per instance, also
   * while `open` is still pending: the provider then drops the pending view.
   */
  release(instanceId: string): void | Promise<void>;

  /** Whether closing the last view of this reference ends the session itself. */
  endsSessionOnLastClose(ref: PanelRef): boolean;

  /** Leaves the call or disconnects the session. Called only on the user's explicit action. */
  endSession(instanceId: string): Promise<PanelEndSessionOutcome>;
}
