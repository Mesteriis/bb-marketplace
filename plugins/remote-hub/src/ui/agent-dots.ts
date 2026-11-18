// The dots over a session an agent drives, drawn with tsParticles (@tsparticles/engine 4.6.0, MIT; only the engine: the one
// shape drawer this needs is written here, so no shape/updater/colour bundle is loaded). The wave is computed in the drawer
// from each dot's position and the clock; the library supplies the canvas, the particle field, the frame loop and its
// FPS cap. Everything is a picture: the canvas takes no pointer events, nothing is blurred or dimmed.
//
// Loaded lazily (dynamic import), only when an agent lease first appears. If it cannot load or start, or the system asks for
// reduced motion, the caller keeps the static CSS dots. Host-free: no BB import, and the engine is injectable for tests.
import type { Container, Engine, IParticleUpdater, IShapeDrawData, IShapeDrawer } from "@tsparticles/engine";

export const MAX_DOTS = 360;
export const MIN_DOTS = 24;
/** One dot per this many square pixels. */
export const PIXELS_PER_DOT = 900;
export const DOT_FPS = 30;
const DEFAULT_ACCENT = "#d29922";

/** How many dots a field of this size gets: scaled by area, with a floor and a hard maximum. */
export function dotCount(width: number, height: number): number {
  const wanted = Math.round((Math.max(0, width) * Math.max(0, height)) / PIXELS_PER_DOT);
  return Math.min(MAX_DOTS, Math.max(MIN_DOTS, wanted));
}

/** 0..1: where a point is on the travelling wave at `seconds` (a diagonal wave, about 180 px long, crossing in ~3 s). */
export function waveAt(x: number, y: number, seconds: number): number {
  const phase = (x * 0.8 + y * 0.6) / 180 - seconds / 3;
  const s = 0.5 + 0.5 * Math.sin(phase * Math.PI * 2);
  return s * s;
}

/** The accent colour of the BB theme as a CSS colour string, read once (any CSS colour works for a canvas fill). */
export function readAccent(el: Element): string {
  const value = typeof getComputedStyle === "function" ? getComputedStyle(el).getPropertyValue("--accent").trim() : "";
  return value === "" ? DEFAULT_ACCENT : value;
}

export interface DotsEngineModule {
  tsParticles: Engine;
}

export interface DotsEnv {
  loadEngine?: () => Promise<DotsEngineModule>;
  now?: () => number;
  document?: Document;
  IntersectionObserver?: typeof IntersectionObserver;
}

export interface DotsHandle {
  /** Stops the loop, removes the canvas and every listener. Safe to call twice. */
  destroy(): void;
}

// In engine 4.x a particle's fill colour comes from an updater (the paint updater, which is not part of the engine). The real
// colour is set by the drawer below, so this one only has to mark the particle as filled: any white will do.
const channel = { enable: false, value: 0, min: 0, max: 0 };
const paintUpdater: IParticleUpdater = {
  init(particle) {
    particle.fillColor = { h: { ...channel }, s: { ...channel }, l: { ...channel, value: 100, min: 100, max: 100 } };
    particle.fillEnabled = true;
    particle.fillOpacity = 1;
  },
  isEnabled: () => false,
  update: () => undefined,
};

let counter = 0;

/**
 * Starts the dot field inside `host`. Resolves to null when the library cannot be loaded or started (the caller keeps the
 * static dots). Pauses while the document is hidden or the host is off screen.
 */
export async function startDots(host: HTMLElement, env: DotsEnv = {}): Promise<DotsHandle | null> {
  const doc = env.document ?? (typeof document === "undefined" ? undefined : document);
  const now = env.now ?? (() => performance.now());
  let engineModule: DotsEngineModule;
  try {
    engineModule = await (env.loadEngine ?? (() => import("@tsparticles/engine") as Promise<DotsEngineModule>))();
  } catch {
    return null;
  }
  const { tsParticles } = engineModule;
  const accent = readAccent(host);
  const t0 = now();
  const drawer: IShapeDrawer = {
    draw(data: IShapeDrawData) {
      const { context, particle } = data;
      const w = waveAt(particle.position.x, particle.position.y, (now() - t0) / 1000);
      context.globalAlpha = 0.07 + 0.6 * w;
      context.fillStyle = accent;
      context.beginPath();
      context.arc(0, 0, 1.2 + 1.9 * w, 0, Math.PI * 2);
      context.fill();
    },
  };
  let container: Container | undefined;
  let destroyed = false;
  const observers: Array<() => void> = [];
  try {
    // Registration comes first: the engine refuses it once it has been initialised.
    await tsParticles.pluginManager.register((e: Engine) => {
      e.pluginManager.addShape(["rh-dot"], () => Promise.resolve(drawer));
      e.pluginManager.addParticleUpdater("rh-paint", () => Promise.resolve(paintUpdater));
    });
    await tsParticles.init();
    const rect = host.getBoundingClientRect();
    container = await tsParticles.load({
      id: "rh-agent-dots-" + ++counter,
      element: host,
      options: {
        fullScreen: { enable: false },
        fpsLimit: DOT_FPS,
        detectRetina: true,
        pauseOnBlur: true,
        pauseOnOutsideViewport: true,
        particles: {
          number: { value: dotCount(rect.width || 640, rect.height || 360) },
          shape: { type: "rh-dot" },
          move: { enable: false },
          size: { value: 2 },
        },
      },
    });
  } catch {
    return null;
  }
  if (container === undefined) return null;
  if (destroyed) {
    container.destroy();
    return null;
  }
  const c = container;
  // The canvas is a picture: it takes no pointer events and sits under the card.
  const canvas = host.querySelector("canvas");
  if (canvas !== null) {
    canvas.style.pointerEvents = "none";
    canvas.setAttribute("aria-hidden", "true");
  }
  let visible = true;
  let pageShown = doc === undefined || doc.visibilityState !== "hidden";
  const apply = (): void => {
    if (destroyed) return;
    if (visible && pageShown) c.play();
    else c.pause();
  };
  if (doc !== undefined) {
    const on = (): void => {
      pageShown = doc.visibilityState !== "hidden";
      apply();
    };
    doc.addEventListener("visibilitychange", on);
    observers.push(() => doc.removeEventListener("visibilitychange", on));
  }
  const IO = env.IntersectionObserver ?? (typeof IntersectionObserver === "undefined" ? undefined : IntersectionObserver);
  if (IO !== undefined) {
    const io = new IO((entries) => {
      const last = entries[entries.length - 1];
      if (last !== undefined) {
        visible = last.isIntersecting;
        apply();
      }
    });
    io.observe(host);
    observers.push(() => io.disconnect());
  }
  apply();
  return {
    destroy() {
      if (destroyed) return;
      destroyed = true;
      for (const off of observers) off();
      observers.length = 0;
      c.destroy(true);
    },
  };
}
