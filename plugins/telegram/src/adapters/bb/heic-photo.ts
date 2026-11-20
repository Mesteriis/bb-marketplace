import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { maxPhotoBytes, maxPhotoEdge } from "../../core/contract.ts";
import { inspectJpeg } from "./photo-upload.ts";

const run = promisify(execFile);

export async function prepareHeicPhoto(path: string, signal: AbortSignal) {
  const sips = "/usr/bin/sips";
  const ffmpeg = ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg"].find(existsSync);
  if (process.platform !== "darwin" || !ffmpeg || !existsSync(sips) || signal.aborted) return;
  const folder = dirname(path);
  const raster = join(folder, "still.png");
  const jpeg = join(folder, "still.jpg");
  const options = { signal, timeout: 30_000, maxBuffer: 16 * 1024 };
  try {
    const { stdout } = await run(sips, ["-g", "format", "-g", "pixelWidth", "-g", "pixelHeight", path], options);
    if (!/^\s*format:\s*heic\s*$/im.test(stdout)) return;
    const width = Number(stdout.match(/^\s*pixelWidth:\s*(\d+)\s*$/im)?.[1]);
    const height = Number(stdout.match(/^\s*pixelHeight:\s*(\d+)\s*$/im)?.[1]);
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) return;
    const resize = Math.max(width, height) > maxPhotoEdge ? ["-Z", String(maxPhotoEdge)] : [];
    await run(sips, [...resize, "-s", "format", "png", path, "--out", raster], options);
    // Encode the pixels without source metadata, including embedded location and Motion Photo XMP.
    for (const quality of [4, 8, 12]) {
      await run(ffmpeg, ["-nostdin", "-v", "error", "-y", "-protocol_whitelist", "file",
        "-f", "png_pipe", "-i", raster, "-map", "0:v:0", "-map_metadata", "-1", "-frames:v", "1",
        "-c:v", "mjpeg", "-q:v", String(quality), "-f", "image2", jpeg], options);
      if ((await stat(jpeg)).size <= maxPhotoBytes) return inspectJpeg(await readFile(jpeg));
    }
  } catch {
    // A malformed or unsupported input is reported by the upload caller.
  }
}
