import { gunzipSync } from "node:zlib";
import { maxTgsBytes } from "../../core/contract.ts";

const maxAnimationBytes = 2 * 1024 * 1024;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

export function decodeTgsSticker(data: Buffer): string {
  if (data.length > maxTgsBytes) throw new Error("Sticker is too large.");
  const json = gunzipSync(data, { maxOutputLength: maxAnimationBytes }).toString("utf8");
  const root = record(JSON.parse(json));
  const numberIn = (number: unknown, min: number, max: number): number => {
    if (typeof number !== "number" || !Number.isFinite(number) || number < min || number > max) {
      throw new Error("Invalid sticker dimensions or frame range.");
    }
    return number;
  };
  if (!root || typeof root.v !== "string" || !Array.isArray(root.layers) || root.fonts || root.chars || root.segments) {
    throw new Error("Invalid Telegram sticker.");
  }
  numberIn(root.w, 1, 512);
  numberIn(root.h, 1, 512);
  const rate = numberIn(root.fr, 1, 60);
  const first = numberIn(root.ip, 0, 180);
  numberIn(root.op, first + 1, first + rate * 3 + 1);

  const queue: [unknown, number][] = [[root, 0]];
  for (let count = 0; queue.length; count++) {
    const [value, depth] = queue.pop()!;
    if (depth > 40 || count > 150_000) throw new Error("Sticker is too complex.");
    if (Array.isArray(value)) {
      for (const item of value) queue.push([item, depth + 1]);
    } else {
      const entry = record(value);
      if (!entry) continue;
      if (entry.ty === "rp" || ["__proto__", "constructor", "prototype"].some((key) => Object.hasOwn(entry, key))) {
        throw new Error("Unsupported Telegram sticker property.");
      }
      for (const child of Object.values(entry)) queue.push([child, depth + 1]);
    }
  }

  const assets = new Map<string, unknown[]>();
  if (root.assets !== undefined && !Array.isArray(root.assets)) throw new Error("Invalid sticker assets.");
  for (const value of root.assets ?? []) {
    const asset = record(value);
    if (!asset || typeof asset.id !== "string" || assets.has(asset.id) || !Array.isArray(asset.layers)
      || "p" in asset || "u" in asset) throw new Error("Unsupported sticker asset.");
    assets.set(asset.id, asset.layers);
  }
  let remaining = 4_096;
  function checkLayers(values: unknown[], path: ReadonlySet<string>) {
    remaining -= values.length;
    if (remaining < 0 || path.size > 12 || values.length > 256) throw new Error("Sticker is too complex.");
    const layers = values.map(record);
    const byId = new Map(layers.map((layer) => [layer?.ind, layer]));
    for (const layer of layers) {
      if (!layer || (layer.ty !== 0 && layer.ty !== 3 && layer.ty !== 4)) throw new Error("Unsupported sticker layer.");
      const parents = new Set();
      let parent = layer.parent;
      while (parent !== undefined) {
        if (typeof parent !== "number" || parents.has(parent) || !byId.has(parent)) throw new Error("Invalid sticker parents.");
        parents.add(parent);
        parent = byId.get(parent)?.parent;
      }
      if (layer.ty !== 0) continue;
      const id = layer.refId;
      const children = typeof id === "string" ? assets.get(id) : undefined;
      if (typeof id !== "string" || !children || path.has(id)) throw new Error("Invalid sticker composition.");
      checkLayers(children, new Set([...path, id]));
    }
  }
  checkLayers(root.layers, new Set());
  return json;
}

export function inspectTgsUpload(base64: string): { bytes: Buffer; json: string } | undefined {
  if (base64.length > Math.ceil(maxTgsBytes / 3) * 4) return;
  const bytes = Buffer.from(base64, "base64");
  if (bytes.toString("base64") !== base64) return;
  try {
    const json = decodeTgsSticker(bytes);
    const root = record(JSON.parse(json));
    if (root?.w === 512 && root.h === 512 && root.fr === 60
      && typeof root.ip === "number" && typeof root.op === "number" && root.op - root.ip <= 180) return { bytes, json };
  } catch { /* Invalid data is unavailable. */ }
}
