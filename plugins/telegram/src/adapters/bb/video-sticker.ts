import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import { maxWebmStickerBytes } from "../../core/contract.ts";

function ebmlInteger(data: Buffer, offset: number, end: number, marker: boolean) {
  const first = data[offset] ?? 0;
  if (!first || offset >= end) return;
  const width = Math.clz32(first) - 23;
  if (width > 6 || offset + width > end) return;
  const value = data.readUIntBE(offset, width) - (marker ? 0 : 2 ** (7 * width));
  return { value, next: offset + width };
}

export function webmStickerBytes(base64: string): Buffer | undefined {
  if (base64.length > Math.ceil(maxWebmStickerBytes / 3) * 4) return;
  const data = Buffer.from(base64, "base64");
  if (data.length < 12 || data.length > maxWebmStickerBytes || data.toString("base64") !== base64
    || data.readUInt32BE(0) !== 0x1a45dfa3) return;
  const header = ebmlInteger(data, 4, data.length, false);
  if (!header) return;
  const end = header.next + header.value;
  if (end > data.length) return;
  for (let offset = header.next; offset < end;) {
    const id = ebmlInteger(data, offset, end, true);
    const size = id && ebmlInteger(data, id.next, end, false);
    if (!id || !size || size.next + size.value > end) return;
    offset = size.next + size.value;
    if (id.value === 0x4282) return size.value === 4 && data.toString("latin1", size.next, offset) === "webm" ? data : undefined;
  }
}

const run = promisify(execFile);

export async function validateWebmStickerFile(path: string): Promise<"valid" | "invalid" | "unavailable"> {
  const ffprobe = ["/opt/homebrew/bin/ffprobe", "/usr/local/bin/ffprobe"].find(existsSync);
  if (!ffprobe) return "unavailable";
  try {
    const { stdout } = await run(ffprobe, ["-v", "error", "-protocol_whitelist", "file", "-f", "matroska",
      "-count_packets", "-show_entries", "stream=codec_type,codec_name,width,height,avg_frame_rate,r_frame_rate,nb_read_packets:format=duration",
      "-of", "json", path], { timeout: 5000, maxBuffer: 16 * 1024 });
    const data = JSON.parse(stdout) as {
      streams?: { codec_type?: string; codec_name?: string; width?: number; height?: number; avg_frame_rate?: string;
        r_frame_rate?: string; nb_read_packets?: string }[];
      format?: { duration?: string };
    };
    const video = data.streams?.[0];
    if (data.streams?.length !== 1 || video?.codec_type !== "video" || video.codec_name !== "vp9") return "invalid";
    const width = video.width ?? 0;
    const height = video.height ?? 0;
    const duration = Number(data.format?.duration);
    const packets = Number(video.nb_read_packets);
    const rates = [video.avg_frame_rate, video.r_frame_rate].flatMap((rate) => {
      const [numerator, denominator] = rate?.split("/").map(Number) ?? [];
      return numerator && denominator ? [numerator / denominator] : [];
    });
    return Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0 && Math.max(width, height) === 512
      && duration > 0 && duration <= 3 && Number.isInteger(packets) && packets > 0 && packets <= 90
      && rates.length > 0 && rates.every((rate) => rate > 0 && rate <= 30) ? "valid" : "invalid";
  } catch { return "invalid"; }
}
