// Shared class recipes of the window and the composer button. Colors, radii
// and type come from the host theme's tokens only, so the window follows the
// light and the dark theme and any custom palette.

/** Visible keyboard focus, the same on every control. */
export const FOCUS = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

const DISABLED = "disabled:pointer-events-none disabled:opacity-50";

/** A term button: bordered, at least 44 px tall. */
export const TERM_BUTTON = `inline-flex min-h-11 items-center justify-center whitespace-nowrap rounded-md border border-border px-3 text-sm text-foreground transition-colors hover:bg-accent hover:text-accent-foreground ${FOCUS} ${DISABLED}`;

/** A quiet button: no border until hovered, at least 40 px tall. */
export const QUIET_BUTTON = `inline-flex min-h-10 items-center gap-2 whitespace-nowrap rounded-md px-2.5 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground ${FOCUS} ${DISABLED}`;

/** One segment of the scope switch, at least 40 px tall. */
export const SEGMENT = `inline-flex min-h-10 items-center gap-2 whitespace-nowrap rounded-sm px-3 text-sm transition-colors ${FOCUS}`;
export const SEGMENT_ON = "bg-primary/15 text-primary";
export const SEGMENT_OFF = "text-muted-foreground hover:bg-accent hover:text-accent-foreground";

/** The small caption over a group of controls. */
export const CAPTION = "mb-1.5 block text-xs text-muted-foreground";

export const ICON = "size-4 shrink-0";
