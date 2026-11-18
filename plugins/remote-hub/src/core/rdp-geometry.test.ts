import { framebufferToElement } from "./rdp-geometry.ts";
import { describe, expect, it } from "vitest";
import { clientToFramebuffer } from "./rdp-geometry.ts";

describe("rdp-geometry clientToFramebuffer", () => {
  const fb = { width: 1000, height: 500 };

  it("fit: 1:1 element maps the four framebuffer corners exactly (dpr 1)", () => {
    const rect = { left: 0, top: 0, width: 1000, height: 500 };
    expect(clientToFramebuffer(0, 0, rect, 1, "fit", fb)).toEqual({ x: 0, y: 0 });
    expect(clientToFramebuffer(999, 0, rect, 1, "fit", fb)).toEqual({ x: 999, y: 0 });
    expect(clientToFramebuffer(0, 499, rect, 1, "fit", fb)).toEqual({ x: 0, y: 499 });
    expect(clientToFramebuffer(999, 499, rect, 1, "fit", fb)).toEqual({ x: 999, y: 499 });
  });

  it("fit: letterbox bars (taller element) map to null and the framebuffer is centered", () => {
    // Square element around a 2:1 framebuffer -> top/bottom letterbox of 250px.
    const rect = { left: 0, top: 0, width: 1000, height: 1000 };
    expect(clientToFramebuffer(500, 100, rect, 1, "fit", fb)).toBeNull(); // top bar
    expect(clientToFramebuffer(500, 900, rect, 1, "fit", fb)).toBeNull(); // bottom bar
    expect(clientToFramebuffer(0, 250, rect, 1, "fit", fb)).toEqual({ x: 0, y: 0 });
    expect(clientToFramebuffer(999, 749, rect, 1, "fit", fb)).toEqual({ x: 999, y: 499 });
  });

  it("fit: wider element letterboxes left/right", () => {
    const rect = { left: 0, top: 0, width: 2000, height: 500 };
    // 2:1 element, 2:1 framebuffer -> no letterbox actually; use 4:1 instead.
    const wide = { left: 0, top: 0, width: 2000, height: 500 };
    // scale = min(2000/1000, 500/500) = 1; drawW=1000, ox=(2000-1000)/2=500.
    expect(clientToFramebuffer(100, 250, wide, 1, "fit", fb)).toBeNull(); // left bar
    expect(clientToFramebuffer(500, 250, wide, 1, "fit", fb)).toEqual({ x: 0, y: 250 });
    expect(clientToFramebuffer(1499, 250, wide, 1, "fit", fb)).toEqual({ x: 999, y: 250 });
    expect(clientToFramebuffer(1900, 250, wide, 1, "fit", fb)).toBeNull(); // right bar
  });

  it("fit: is DPR-independent (dpr 2 gives the same framebuffer coordinates)", () => {
    const rect = { left: 0, top: 0, width: 1000, height: 500 };
    expect(clientToFramebuffer(500, 250, rect, 2, "fit", fb)).toEqual(
      clientToFramebuffer(500, 250, rect, 1, "fit", fb),
    );
  });

  it("actual: dpr 1 maps device pixel == framebuffer pixel", () => {
    const rect = { left: 0, top: 0, width: 1000, height: 500 };
    expect(clientToFramebuffer(0, 0, rect, 1, "actual", fb)).toEqual({ x: 0, y: 0 });
    expect(clientToFramebuffer(999, 499, rect, 1, "actual", fb)).toEqual({ x: 999, y: 499 });
  });

  it("actual: dpr 2 scales CSS to device pixels and letterboxes past the framebuffer", () => {
    // Element is 500x250 CSS px; at dpr 2 that is 1000x500 device px == fb.
    const rect = { left: 0, top: 0, width: 500, height: 250 };
    expect(clientToFramebuffer(0, 0, rect, 2, "actual", fb)).toEqual({ x: 0, y: 0 });
    expect(clientToFramebuffer(499, 249, rect, 2, "actual", fb)).toEqual({ x: 998, y: 498 });
    // An element larger than the framebuffer letterboxes beyond it.
    const big = { left: 0, top: 0, width: 600, height: 300 };
    expect(clientToFramebuffer(599, 299, big, 2, "actual", fb)).toBeNull(); // 1198 >= 1000
  });

  it("a resized element changes the mapping", () => {
    const rectA = { left: 0, top: 0, width: 1000, height: 500 };
    const rectB = { left: 0, top: 0, width: 1000, height: 1000 };
    // Same client point, same framebuffer, different rect -> different result.
    const a = clientToFramebuffer(500, 250, rectA, 1, "fit", fb);
    const b = clientToFramebuffer(500, 250, rectB, 1, "fit", fb);
    expect(a).not.toEqual(b);
    expect(a).toEqual({ x: 500, y: 250 });
    expect(b).toEqual({ x: 500, y: 0 }); // square: scale=1, oy=250
  });

  it("points outside the element are null", () => {
    const rect = { left: 10, top: 20, width: 1000, height: 500 };
    expect(clientToFramebuffer(9, 250, rect, 1, "fit", fb)).toBeNull();
    expect(clientToFramebuffer(1010, 250, rect, 1, "fit", fb)).toBeNull();
    expect(clientToFramebuffer(500, 19, rect, 1, "fit", fb)).toBeNull();
    expect(clientToFramebuffer(500, 521, rect, 1, "fit", fb)).toBeNull();
  });
});

describe("framebufferToElement", () => {
  it("1:1 puts a point at its device-pixel position, in CSS pixels", () => {
    expect(framebufferToElement(100, 40, { width: 1000, height: 800 }, 2, "actual", { width: 1600, height: 900 })).toEqual({ left: 50, top: 20 });
  });
  it("fit centres the scaled desktop: a 2:1 desktop in a square box has bars above and below", () => {
    // 800x400 in a 400x400 box: scale 0.5, drawn 400x200, top bar 100
    expect(framebufferToElement(0, 0, { width: 400, height: 400 }, 1, "fit", { width: 800, height: 400 })).toEqual({ left: 0, top: 100 });
    expect(framebufferToElement(800, 400, { width: 400, height: 400 }, 1, "fit", { width: 800, height: 400 })).toEqual({ left: 400, top: 300 });
  });
  it("is the inverse of clientToFramebuffer inside the picture", () => {
    const rect = { left: 10, top: 20, width: 500, height: 300 };
    const fb = { width: 1000, height: 400 };
    const at = framebufferToElement(500, 200, rect, 1, "fit", fb)!;
    expect(clientToFramebuffer(rect.left + at.left, rect.top + at.top, rect, 1, "fit", fb)).toEqual({ x: 500, y: 200 });
  });
  it("refuses an empty box or desktop", () => {
    expect(framebufferToElement(1, 1, { width: 0, height: 10 }, 1, "fit", { width: 10, height: 10 })).toBeNull();
  });
});
