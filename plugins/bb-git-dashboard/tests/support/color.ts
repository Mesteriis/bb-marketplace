// Colour arithmetic for the token tests: hex and OKLCH to sRGB, gamut mapping by chroma, WCAG contrast.
export type Oklch = {l: number; c: number; h: number};
type Rgb = [number, number, number];

const toLinear = (v: number) => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
const toGamma = (v: number) => v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;

export function hexToOklch(hex: string): Oklch {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(v => toLinear(v / 255)) as Rgb;
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s;
  const a = 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s;
  const h = (Math.atan2(B, a) * 180 / Math.PI + 360) % 360;
  return {l: L, c: Math.hypot(a, B), h};
}

function linearRgb({l: L, c, h}: Oklch): Rgb {
  const a = c * Math.cos(h * Math.PI / 180), b = c * Math.sin(h * Math.PI / 180);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.2914855480 * b) ** 3;
  return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s];
}

/** sRGB in 0..1, chroma reduced until the colour fits, as browsers map out-of-gamut OKLCH. */
export function toSrgb(color: Oklch): Rgb {
  const fits = (rgb: Rgb) => rgb.every(v => v >= -1e-4 && v <= 1 + 1e-4);
  let rgb = linearRgb(color);
  if (!fits(rgb)) {
    let low = 0, high = color.c;
    for (let i = 0; i < 30; i++) {
      const mid = (low + high) / 2;
      if (fits(linearRgb({...color, c: mid}))) low = mid; else high = mid;
    }
    rgb = linearRgb({...color, c: low});
  }
  return rgb.map(v => toGamma(Math.min(1, Math.max(0, v)))) as Rgb;
}

const luminance = (rgb: Rgb) => {
  const [r, g, b] = rgb.map(toLinear) as Rgb;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
export function contrast(a: Oklch, b: Oklch): number {
  const [x, y] = [luminance(toSrgb(a)), luminance(toSrgb(b))].sort((p, q) => q - p) as [number, number];
  return (x + 0.05) / (y + 0.05);
}
