import { gunzipSync } from "node:zlib";
import { maxPhotoBytes, type WallpaperPatternAsset } from "../../core/contract.ts";
import { telegramPhotoMime } from "./photo.ts";

export function wallpaperPatternAsset(bytes: Buffer, format: WallpaperPatternAsset["format"]): WallpaperPatternAsset {
  if (format === "png") {
    if (bytes.length < 33 || telegramPhotoMime(bytes) !== "image/png"
      || bytes.readUInt32BE(8) !== 13 || bytes.toString("ascii", 12, 16) !== "IHDR") {
      throw new Error("Invalid wallpaper pattern PNG.");
    }
    const width = bytes.readUInt32BE(16);
    const height = bytes.readUInt32BE(20);
    if (!width || !height || width > 4096 || height > 4096) throw new Error("Invalid wallpaper pattern size.");
    return { format, base64: bytes.toString("base64") };
  }
  const svg = gunzipSync(bytes, { maxOutputLength: maxPhotoBytes });
  if (!svg.length) throw new Error("Empty wallpaper pattern.");
  return { format, base64: svg.toString("base64") };
}
