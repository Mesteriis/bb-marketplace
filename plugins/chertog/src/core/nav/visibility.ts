// Whether Chertog's own navigation entry is shown follows the «Тайловое
// пространство» switch, but only when the switch changes: an entry the owner
// hid or showed by hand in BB's sidebar settings is never fought.

/** How Chertog's entry stands in the host's navigation: absent items cannot be acted on. */
export type ItemState = "visible" | "hidden" | "missing";

export interface NavVisibilityInput {
  /** The switch value applied last, `null` before the first run. */
  stored: boolean | null;
  /** The switch as the window sees it, `null` while the settings are not delivered. */
  delivered: boolean | null;
  item: ItemState;
}

export interface NavVisibilityDecision {
  /** Call `setVisible` with this, or `null` for no call. */
  setVisible: boolean | null;
  /** Remember this as the applied value, or `null` to leave the memory alone. */
  store: boolean | null;
}

const NOTHING: NavVisibilityDecision = { setVisible: null, store: null };

export function decideNavVisibility({ stored, delivered, item }: NavVisibilityInput): NavVisibilityDecision {
  // Not delivered: nothing is known. Item missing: nothing to act on, try again when it appears.
  if (delivered === null || item === "missing") return NOTHING;
  if (stored === delivered) return NOTHING;
  // First run with the switch on: the entry stays as the owner has it.
  if (stored === null && delivered) return { setVisible: null, store: true };
  return { setVisible: (item === "visible") === delivered ? null : delivered, store: delivered };
}
