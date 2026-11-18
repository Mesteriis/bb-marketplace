import { describe, expect, it } from "vitest";
import { DEFAULT_RDP_OPTIONS, RDP_PRESETS, effectiveRdpOptions, presetOf, rdpOptionsSchema } from "./rdp-options.ts";

describe("rdp options", () => {
  it("the default is Balanced, with literal values", () => {
    expect(DEFAULT_RDP_OPTIONS).toEqual({ compression: true, colorDepth: 32, wallpaper: false, fullWindowDrag: false, menuAnimations: false, fontSmoothing: true, desktopComposition: false, themes: true });
  });
  it("the three presets are literal and distinct", () => {
    expect(RDP_PRESETS.slow).toEqual({ compression: true, colorDepth: 16, wallpaper: false, fullWindowDrag: false, menuAnimations: false, fontSmoothing: true, desktopComposition: false, themes: false });
    expect(RDP_PRESETS.quality).toEqual({ compression: false, colorDepth: 32, wallpaper: true, fullWindowDrag: true, menuAnimations: true, fontSmoothing: true, desktopComposition: true, themes: true });
    expect(new Set(Object.values(RDP_PRESETS).map((p) => JSON.stringify(p))).size).toBe(3);
  });
  it("presetOf names a preset and calls anything else custom", () => {
    expect(presetOf(RDP_PRESETS.slow)).toBe("slow");
    expect(presetOf(RDP_PRESETS.balanced)).toBe("balanced");
    expect(presetOf(RDP_PRESETS.quality)).toBe("quality");
    expect(presetOf({ ...RDP_PRESETS.balanced, wallpaper: true })).toBe("custom");
  });
  it("the schema is a closed set: depth 16/24/32, booleans only, no extra keys", () => {
    expect(rdpOptionsSchema.safeParse(RDP_PRESETS.slow).success).toBe(true);
    for (const bad of [{ ...RDP_PRESETS.slow, colorDepth: 8 }, { ...RDP_PRESETS.slow, colorDepth: "16" }, { ...RDP_PRESETS.slow, compression: "yes" }, { ...RDP_PRESETS.slow, flags: 4 }]) {
      expect(rdpOptionsSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
    const { themes: _t, ...missing } = RDP_PRESETS.slow;
    expect(rdpOptionsSchema.safeParse(missing).success).toBe(false);
  });
  it("a profile without stored options (quick connect, an old profile) gets the default", () => {
    expect(effectiveRdpOptions(null)).toEqual(DEFAULT_RDP_OPTIONS);
    expect(effectiveRdpOptions(undefined)).toEqual(DEFAULT_RDP_OPTIONS);
    expect(effectiveRdpOptions(RDP_PRESETS.quality)).toEqual(RDP_PRESETS.quality);
  });
});
