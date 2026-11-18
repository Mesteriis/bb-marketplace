// The transport and experience options of an RDP connection: a setting that is stored with the profile, travels to the
// helper in the open request and is validated again there. Every field is something the pinned IronRDP really does (see
// helper/src/rdp/options.rs): bulk compression, colour depth (32/24/16 bits per pixel) and six experience switches (the
// Client Info performance flags, which a server may ignore). There is no switch here that does nothing.
import { z } from "zod";

export const COLOR_DEPTHS = [32, 24, 16] as const;

export const rdpOptionsSchema = z
  .object({
    /** Bulk compression of the update stream (RDP 5.0, 64 K history). Fewer bytes, a little more CPU. */
    compression: z.boolean(),
    colorDepth: z.union([z.literal(32), z.literal(24), z.literal(16)]),
    /** true = the effect is wanted (drawn), false = the server is asked not to draw it. */
    wallpaper: z.boolean(),
    fullWindowDrag: z.boolean(),
    menuAnimations: z.boolean(),
    fontSmoothing: z.boolean(),
    desktopComposition: z.boolean(),
    themes: z.boolean(),
  })
  .strict();

export type RdpOptions = z.infer<typeof rdpOptionsSchema>;

export type RdpPreset = "slow" | "balanced" | "quality";

export const RDP_PRESETS: Record<RdpPreset, RdpOptions> = {
  /** A slow or metered link: 16 bits per pixel, every optional effect off (text stays smooth). */
  slow: { compression: true, colorDepth: 16, wallpaper: false, fullWindowDrag: false, menuAnimations: false, fontSmoothing: true, desktopComposition: false, themes: false },
  /** The default, chosen for a VPN or WAN link: compression on, wallpaper, window drag and menu animations off. */
  balanced: { compression: true, colorDepth: 32, wallpaper: false, fullWindowDrag: false, menuAnimations: false, fontSmoothing: true, desktopComposition: false, themes: true },
  /** A fast local link: nothing is held back. */
  quality: { compression: false, colorDepth: 32, wallpaper: true, fullWindowDrag: true, menuAnimations: true, fontSmoothing: true, desktopComposition: true, themes: true },
};

export const PRESET_LABELS: Record<RdpPreset | "custom", string> = {
  slow: "Slow link",
  balanced: "Balanced (default)",
  quality: "Best quality",
  custom: "Custom",
};

export const DEFAULT_RDP_OPTIONS: RdpOptions = RDP_PRESETS.balanced;

/** The preset these options equal, or "custom". */
export function presetOf(options: RdpOptions): RdpPreset | "custom" {
  for (const name of Object.keys(RDP_PRESETS) as RdpPreset[]) {
    const p = RDP_PRESETS[name];
    if ((Object.keys(p) as Array<keyof RdpOptions>).every((k) => p[k] === options[k])) return name;
  }
  return "custom";
}

/** What the open request carries: the profile's options, or the default (quick connect, a profile saved before this existed). */
export function effectiveRdpOptions(stored: RdpOptions | null | undefined): RdpOptions {
  return stored ?? DEFAULT_RDP_OPTIONS;
}
