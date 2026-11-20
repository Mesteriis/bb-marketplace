// @vitest-environment jsdom
import { gzipSync } from "node:zlib";
import { expect, test } from "vitest";
import { maxPhotoBytes } from "../src/core/contract.ts";
import { wallpaperPatternAsset } from "../src/adapters/bb/wallpaper-pattern.ts";
import { wallpaperPatternUrl } from "../src/ui/wallpaper-pattern.ts";

const svg = (body: string) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">${body}</svg>`;
const tgv = (xml: string) => wallpaperPatternAsset(gzipSync(xml), "svg");

test("renders a bounded TGV as an inert mask using only shapes and paint attributes", () => {
  const url = wallpaperPatternUrl(tgv(svg('<g opacity=".7"><path d="M2 2h12v12Z" style="fill:none;stroke:#000" onload="fixture"/></g>')));
  expect(url).toMatch(/^data:image\/svg\+xml;base64,/);
  const xml = Buffer.from(url!.split(",")[1]!, "base64").toString();
  expect(xml).toContain('viewBox="0 0 16 16"');
  expect(xml).toContain('stroke="#000"');
  expect(xml).not.toMatch(/onload|style=/);
});

test("rejects unsupported SVG resources and oversized patterns", () => {
  const source = '<circle cx="8" cy="8" r="3"/>';
  expect(wallpaperPatternUrl(tgv(svg(`${source}<image href="https://example.invalid/fixture.png"/>`)))).toBeUndefined();
  expect(wallpaperPatternUrl(tgv(`<!DOCTYPE svg>${svg(source)}`))).toBeUndefined();
  expect(() => tgv(" ".repeat(maxPhotoBytes + 1))).toThrow();
  const png = Buffer.alloc(33);
  Buffer.from("89504e470d0a1a0a0000000d49484452", "hex").copy(png);
  png.writeUInt32BE(4097, 16);
  png.writeUInt32BE(16, 20);
  expect(() => wallpaperPatternAsset(png, "png")).toThrow("Invalid wallpaper pattern size.");
});
