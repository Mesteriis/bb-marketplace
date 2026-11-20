import type { WallpaperPatternAsset } from "../core/contract.ts";

const svgNamespace = "http://www.w3.org/2000/svg";
const shapes = new Set(["g", "path", "rect", "circle", "ellipse", "line", "polygon", "polyline"]);
const ignored = new Set(["title", "desc", "metadata"]);
const dimensions = /^[0-9eE.,%+\-\s]+(?:px)?$/;
const geometry = new Set(["width", "height", "x", "y", "x1", "y1", "x2", "y2", "cx", "cy", "r", "rx", "ry", "points"]);
const paint = new Map<string, RegExp>([
  ["fill", /^(?:[a-z]+|#[0-9a-f]{3,8}|rgba?\([\d.,%\s]+\))$/i],
  ["stroke", /^(?:[a-z]+|#[0-9a-f]{3,8}|rgba?\([\d.,%\s]+\))$/i],
  ["opacity", dimensions], ["fill-opacity", dimensions], ["stroke-opacity", dimensions],
  ["stroke-width", dimensions], ["stroke-miterlimit", dimensions],
  ["stroke-linecap", /^(butt|round|square)$/],
  ["stroke-linejoin", /^(miter|round|bevel)$/],
  ["fill-rule", /^(nonzero|evenodd)$/],
]);

function safeAttribute(name: string, value: string) {
  if (geometry.has(name) || name === "viewBox") return dimensions.test(value);
  if (name === "d") return /^[MmZzLlHhVvCcSsQqTtAa0-9eE.,+\-\s]+$/.test(value);
  if (name === "transform") return /^[a-z0-9eE.,()+\-\s]+$/i.test(value);
  if (name === "preserveAspectRatio") return /^(?:none|x(?:Min|Mid|Max)Y(?:Min|Mid|Max)(?: (?:meet|slice))?)$/.test(value);
  return paint.get(name)?.test(value) === true;
}

export function wallpaperPatternUrl(asset: WallpaperPatternAsset): string | undefined {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(asset.base64)) return;
  if (asset.format === "png") return `data:image/png;base64,${asset.base64}`;
  try {
    const bytes = Uint8Array.from(atob(asset.base64), (value) => value.charCodeAt(0));
    const svg = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (/<!DOCTYPE/i.test(svg)) return;
    const document = new DOMParser().parseFromString(svg, "image/svg+xml");
    const root = document.documentElement;
    if (root.namespaceURI !== svgNamespace || root.localName !== "svg" || document.querySelector("parsererror")) return;
    let count = 0;
    function copy(source: Element, depth: number): Element | undefined {
      if (depth > 24 || ++count > 6000 || source.namespaceURI !== svgNamespace || depth && !shapes.has(source.localName)) return;
      const result = document.createElementNS(svgNamespace, source.localName);
      for (const { localName, namespaceURI, value } of Array.from(source.attributes)) {
        if (!namespaceURI && safeAttribute(localName, value)) result.setAttribute(localName, value);
      }
      for (const declaration of (source.getAttribute("style") ?? "").split(";")) {
        const [name, value, extra] = declaration.split(":").map((part) => part.trim());
        if (name && value && extra === undefined && paint.get(name)?.test(value)) result.setAttribute(name, value);
      }
      for (const child of Array.from(source.children)) {
        if (child.namespaceURI === svgNamespace && ignored.has(child.localName)) continue;
        const shape = copy(child, depth + 1);
        if (!shape) return;
        result.append(shape);
      }
      return result;
    }
    // Serialize only shapes and vetted paint values into an inert image URL.
    const sanitized = copy(root, 0);
    if (sanitized?.querySelector("path,rect,circle,ellipse,line,polygon,polyline")) {
      return `data:image/svg+xml;base64,${btoa(new XMLSerializer().serializeToString(sanitized))}`;
    }
  } catch { return; }
}
