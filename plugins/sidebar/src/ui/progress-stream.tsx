// Adapted from Plan Progress 0.6.0, MIT, Copyright (c) 2026 Yuri Smirnov.
// Protocol and idea: zycck/claude-mods (MIT). See licenses/plan-progress-MIT.txt.
// Keep the original deterministic dot masks, wave, twinkle and glide timing.
import type {CSSProperties} from 'react';
import type {Plan as Bar} from '../core/progress';
export type Rgb = [number, number, number];
export const hex = (color: string): Rgb => [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16)) as Rgb;
export const mix = (a: Rgb, b: Rgb, t: number): Rgb => a.map((v, i) => Math.round(v + (b[i]! - v) * t)) as Rgb;
export const rgb = (c: Rgb, alpha = 1) => `rgba(${c.join(",")},${alpha})`;
export const WHITE: Rgb = [255, 255, 255];

// ---------- the stream: dots, a slow wave, a twinkle ----------

const COLS = 233; // the wave's length in 3 px columns, prime so its loop does not show
const SPEED = 20; // columns a second; a bar at rest streams at half that

/** Deterministic noise in [0, 1). */
function hash(a: number, b: number, c: number): number {
  let h = Math.imul(a + 1, 374761393) ^ Math.imul(b + 7, 668265263) ^ Math.imul(c + 13, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const svgUrl = (svg: string) => `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;

const DOTS = svgUrl(
  `<svg xmlns="http://www.w3.org/2000/svg" width="3" height="3"><rect width="2" height="2" fill="#fff"/></svg>`,
);

/** Noise smoothed into blobs a few columns wide: where the wave lets dots show. */
const WAVE = (() => {
  const raw = Array.from({ length: COLS }, (_, i) => hash(i, 0, 5));
  const runs: string[] = [];
  for (let i = 0; i < COLS; i++) {
    let sum = 0;
    for (let d = -3; d <= 3; d++) sum += raw[(i + d + COLS) % COLS]!;
    const level = sum / 7;
    if (level > 0.5) runs.push(`<rect x="${i * 3}" width="3" height="22" fill="#fff" fill-opacity="${Math.min(1, (level - 0.5) * 5).toFixed(2)}"/>`);
  }
  return svgUrl(`<svg xmlns="http://www.w3.org/2000/svg" width="${COLS * 3}" height="22">${runs.join("")}</svg>`);
})();

/** Four sparse dot tiles that blink on their own beats. */
export const FLICKER = [0, 1, 2, 3].map((k) => {
  const cells: string[] = [];
  for (let x = 0; x < 16; x++) {
    for (let y = 0; y < 7; y++) {
      if (hash(x, y, 20 + k) < 0.09) cells.push(`<rect x="${x * 3}" y="${y * 3}" width="2" height="2" fill="#fff"/>`);
    }
  }
  return svgUrl(`<svg xmlns="http://www.w3.org/2000/svg" width="48" height="21">${cells.join("")}</svg>`);
});

export const STREAM_STYLE = `
@keyframes mspp-wave { from { mask-position: 0 0; -webkit-mask-position: 0 0 } to { mask-position: -${COLS * 3}px 0; -webkit-mask-position: -${COLS * 3}px 0 } }
@keyframes mspp-blink { 0%, 100% { opacity: 0 } 20% { opacity: .35 } 45% { opacity: .9 } 60% { opacity: .2 } 80% { opacity: .65 } }
.mspp-glide { transition: width .3s cubic-bezier(.2,.8,.2,1), left .3s cubic-bezier(.2,.8,.2,1), transform .3s cubic-bezier(.2,.8,.2,1), background-color .4s; }
.mspp-wave { animation: mspp-wave var(--mspp-wave-dur) steps(${COLS}) infinite; }
.mspp-blink { animation: mspp-blink var(--mspp-blink-dur) step-end infinite; animation-delay: var(--mspp-blink-delay); opacity: 0; }
.mspp-track .mspp-clock { display: none; }
.mspp-track:hover .mspp-clock { display: inline; }
.mspp-track:hover .mspp-label { display: none; }
.mspp-mark .mspp-tip { opacity: 0; transition: opacity .12s; pointer-events: none; }
.mspp-mark:hover .mspp-tip { opacity: 1; }
@media (prefers-reduced-motion: reduce) { .mspp-wave, .mspp-blink, .animate-pulse { animation: none; } .mspp-glide { transition: none; } }
`;

export function mask(image: string, extra: CSSProperties = {}): CSSProperties {
  return { maskImage: image, WebkitMaskImage: image, ...extra } as CSSProperties;
}

export function Stream({ bar, light, effects }: { bar: Bar; light: Rgb; effects: boolean }) {
  const inset:CSSProperties={position:'absolute',inset:0};
  const speed = bar.state === "running" ? SPEED : SPEED / 2;
  const dots: CSSProperties = {
    position: "absolute",
    inset: 0,
    top: 1,
    backgroundColor: rgb(light),
    ...mask(DOTS, { maskSize: "3px 3px", WebkitMaskSize: "3px 3px" } as CSSProperties),
  };
  return (
    <>
      {/* the wave: dots where its blobs pass, fading in along the fill */}
      <div style={{...inset,...mask("linear-gradient(90deg, transparent 0, #000 67%)")}}>
        <div
          className={effects ? 'mspp-wave' : undefined}
          style={{
            ...inset,
            ...mask(WAVE, { maskSize: `${COLS * 3}px 22px`, WebkitMaskSize: `${COLS * 3}px 22px`, maskRepeat: "repeat-x" } as CSSProperties),
            ["--mspp-wave-dur" as string]: `${(COLS / speed).toFixed(1)}s`,
          }}
        >
          <div style={dots} />
        </div>
      </div>
      {/* the twinkle: sparse dots blinking towards the head */}
      {effects ? (
        <div
          style={{...inset,...mask("linear-gradient(90deg, transparent 0, transparent 15%, rgba(0,0,0,.45) 50%, rgba(0,0,0,.9) 80%, #000)")}}
        >
          {FLICKER.map((tile, k) => (
            <div
              key={k}
              className="mspp-blink"
              style={{
                ...inset,
                top: 1,
                backgroundColor: rgb(light),
                ...mask(tile, { maskSize: "48px 21px", WebkitMaskSize: "48px 21px" } as CSSProperties),
                ["--mspp-blink-dur" as string]: `${[2.2, 2.8, 1.9, 3.3][k]! * (bar.state === "done" ? 1.5 : 1)}s`,
                ["--mspp-blink-delay" as string]: `-${[0, 0.7, 1.3, 0.4][k]}s`,
              }}
            />
          ))}
        </div>
      ) : null}
    </>
  );
}


export function progressLight(color:string):Rgb {return mix(hex(color),WHITE,0.32);}
