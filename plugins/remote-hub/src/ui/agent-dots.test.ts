// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { DOT_FPS, MAX_DOTS, MIN_DOTS, dotCount, readAccent, startDots, waveAt, type DotsEngineModule } from "./agent-dots.ts";

afterEach(() => vi.unstubAllGlobals());

describe("the dot field", () => {
  it("scales with area, with a floor and a hard maximum (literal values)", () => {
    expect(dotCount(0, 0)).toBe(MIN_DOTS);
    expect(dotCount(300, 300)).toBe(100); // 90 000 px / 900
    expect(dotCount(1440, 900)).toBe(MAX_DOTS);
    expect(dotCount(100000, 100000)).toBe(360);
    expect(MIN_DOTS).toBe(24);
    expect(DOT_FPS).toBe(30);
  });

  it("the wave travels: the same point is bright at one moment and dark at another, and it stays in 0..1", () => {
    let min = 1;
    let max = 0;
    for (let t = 0; t < 3; t += 0.05) {
      const w = waveAt(100, 50, t);
      min = Math.min(min, w);
      max = Math.max(max, w);
    }
    expect(min).toBeLessThan(0.01);
    expect(max).toBeGreaterThan(0.95);
    // a wave front: points a quarter wavelength apart along the travel direction differ at the same instant
    expect(Math.abs(waveAt(0, 0, 0) - waveAt(45, 0, 0))).toBeGreaterThan(0.3);
  });

  it("reads the accent from the BB token and falls back to a literal", () => {
    const el = document.createElement("div");
    document.body.appendChild(el);
    expect(readAccent(el)).toBe("#d29922");
    el.style.setProperty("--accent", " #3a7d44 ");
    expect(readAccent(el)).toBe("#3a7d44");
  });
});

/** A stand-in for the engine that records what the overlay asks of it. */
function fakeEngine() {
  const container = { play: vi.fn(), pause: vi.fn(), destroy: vi.fn() };
  const shapes: Array<{ names: string[]; draw: (d: unknown) => void }> = [];
  const updaters: string[] = [];
  const order: string[] = [];
  const loadArgs: Array<{ element: HTMLElement; options: Record<string, any> }> = [];
  const engine = {
    init: vi.fn(async () => void order.push("init")),
    pluginManager: {
      register: vi.fn(async (...loaders: Array<(e: unknown) => void>) => {
        order.push("register");
        for (const l of loaders) l({ pluginManager: { addShape: (names: string[], init: () => Promise<{ draw: (d: unknown) => void }>) => void init().then((d) => shapes.push({ names, draw: d.draw })), addParticleUpdater: (name: string, init: () => Promise<unknown>) => void init().then(() => updaters.push(name)) } });
      }),
    },
    load: vi.fn(async (p: { element: HTMLElement; options: Record<string, any> }) => {
      loadArgs.push(p);
      const canvas = document.createElement("canvas");
      p.element.appendChild(canvas);
      return container;
    }),
  };
  return { engine, container, shapes, updaters, order, loadArgs, module: { tsParticles: engine } as unknown as DotsEngineModule };
}

class FakeIO {
  static last: FakeIO | null = null;
  disconnected = false;
  constructor(readonly cb: (e: Array<{ isIntersecting: boolean }>) => void) {
    FakeIO.last = this;
  }
  observe() {}
  disconnect() {
    this.disconnected = true;
  }
  see(v: boolean) {
    this.cb([{ isIntersecting: v }]);
  }
}

describe("startDots", () => {
  it("loads nothing until it is called (the engine import is lazy) and asks for a capped, small, static field", async () => {
    const f = fakeEngine();
    const loadEngine = vi.fn(async () => f.module);
    expect(loadEngine).not.toHaveBeenCalled();
    const host = document.createElement("div");
    document.body.appendChild(host);
    const handle = await startDots(host, { loadEngine, IntersectionObserver: FakeIO as unknown as typeof IntersectionObserver });
    expect(handle).not.toBeNull();
    expect(loadEngine).toHaveBeenCalledTimes(1);
    const { options } = f.loadArgs[0]!;
    expect(options.fpsLimit).toBe(30);
    expect(options.particles.number.value).toBeLessThanOrEqual(360);
    expect(options.particles.move.enable).toBe(false);
    expect(options.fullScreen.enable).toBe(false);
    expect(options.particles.shape.type).toBe("rh-dot");
    expect(f.shapes[0]?.names).toEqual(["rh-dot"]);
    expect(f.updaters).toEqual(["rh-paint"]); // the particles need a fill marker in engine 4.x
    expect(f.order).toEqual(["register", "init"]); // the engine refuses registration after init
    const canvas = host.querySelector("canvas")!;
    expect(canvas.style.pointerEvents).toBe("none");
    expect(canvas.getAttribute("aria-hidden")).toBe("true");
    handle!.destroy();
  });

  it("the shape draws with the accent, an alpha that follows the wave and never a blur or a fill over the whole field", async () => {
    const f = fakeEngine();
    const host = document.createElement("div");
    host.style.setProperty("--accent", "#3a7d44");
    let t = 0;
    await startDots(host, { loadEngine: async () => f.module, now: () => t, IntersectionObserver: FakeIO as unknown as typeof IntersectionObserver });
    const calls: string[] = [];
    const ctx = { globalAlpha: 1, fillStyle: "", beginPath: () => calls.push("begin"), arc: (_x: number, _y: number, r: number) => calls.push("arc:" + r.toFixed(2)), fill: () => calls.push("fill"), filter: "none" };
    f.shapes[0]!.draw({ context: ctx, particle: { position: { x: 100, y: 50 } } });
    expect(ctx.fillStyle).toBe("#3a7d44");
    expect(ctx.globalAlpha).toBeGreaterThanOrEqual(0.07);
    expect(ctx.globalAlpha).toBeLessThanOrEqual(0.67);
    expect(ctx.filter).toBe("none");
    expect(calls).toEqual(["begin", calls[1], "fill"]);
    const first = ctx.globalAlpha;
    t = 1500;
    f.shapes[0]!.draw({ context: ctx, particle: { position: { x: 100, y: 50 } } });
    expect(ctx.globalAlpha).not.toBe(first);
  });

  it("pauses while the document is hidden or the host is off screen, and plays again when both are fine", async () => {
    const f = fakeEngine();
    const host = document.createElement("div");
    let state: "visible" | "hidden" = "visible";
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
    const handle = await startDots(host, { loadEngine: async () => f.module, IntersectionObserver: FakeIO as unknown as typeof IntersectionObserver });
    expect(f.container.play).toHaveBeenCalled();
    f.container.pause.mockClear();
    state = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    expect(f.container.pause).toHaveBeenCalledTimes(1);
    state = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    FakeIO.last!.see(false);
    expect(f.container.pause).toHaveBeenCalledTimes(2);
    f.container.play.mockClear();
    FakeIO.last!.see(true);
    expect(f.container.play).toHaveBeenCalledTimes(1);
    handle!.destroy();
  });

  it("destroy stops the loop, removes the canvas through the engine and every listener; a second call does nothing", async () => {
    const f = fakeEngine();
    const host = document.createElement("div");
    const handle = await startDots(host, { loadEngine: async () => f.module, IntersectionObserver: FakeIO as unknown as typeof IntersectionObserver });
    handle!.destroy();
    handle!.destroy();
    expect(f.container.destroy).toHaveBeenCalledTimes(1);
    expect(f.container.destroy).toHaveBeenCalledWith(true);
    expect(FakeIO.last!.disconnected).toBe(true);
    f.container.play.mockClear();
    f.container.pause.mockClear();
    document.dispatchEvent(new Event("visibilitychange"));
    expect(f.container.play).not.toHaveBeenCalled();
    expect(f.container.pause).not.toHaveBeenCalled();
  });

  it("a library that fails to load or to start gives null (the static dots stay)", async () => {
    const host = document.createElement("div");
    expect(await startDots(host, { loadEngine: async () => Promise.reject(new Error("chunk")) })).toBeNull();
    const f = fakeEngine();
    f.engine.load.mockRejectedValueOnce(new Error("boom"));
    expect(await startDots(host, { loadEngine: async () => f.module })).toBeNull();
  });
});
