import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { isDeepStrictEqual, promisify } from "node:util";
import { frameTimescale, writeHevcPacketClock } from "./hevc-packet-clock.ts";

const run = promisify(execFile);
const hdr10Plus = "HDR Dynamic Metadata SMPTE2094-40 (HDR10+)";
const maxMetadataBytes = 64 * 1024 * 1024;
const localMovie = ["-protocol_whitelist", "file", "-enable_drefs", "0", "-f", "mov"];

type FrameDynamicMetadata = {
  side_data_type?: string;
  num_windows?: number;
  average_maxrgb?: string;
  targeted_system_display_maximum_luminance?: string;
  knee_point_x?: string;
  knee_point_y?: string;
  fraction_bright_pixels?: string;
  num_rows_targeted_system_display_actual_peak_luminance?: number;
  num_rows_mastering_display_actual_peak_luminance?: number;
  color_saturation_weight?: string;
};

export function findHdr10PlusTool() {
  return ["/opt/homebrew/bin/hdr10plus_tool", "/usr/local/bin/hdr10plus_tool"].find(existsSync);
}

async function probeFrames(ffprobe: string, path: string, stream: number, signal?: AbortSignal) {
  const { stdout } = await run(ffprobe, ["-v", "error", ...localMovie, "-select_streams", String(stream),
    "-show_entries", "frame=best_effort_timestamp_time,duration_time:frame_side_data=side_data_type,num_windows,fraction_bright_pixels,"
      + "num_rows_targeted_system_display_actual_peak_luminance,num_rows_mastering_display_actual_peak_luminance,color_saturation_weight,"
      + "average_maxrgb,targeted_system_display_maximum_luminance,knee_point_x,knee_point_y",
    "-of", "json", path], { timeout: 180_000, maxBuffer: maxMetadataBytes, signal });
  const result = JSON.parse(stdout) as { frames?: Array<{ best_effort_timestamp_time?: string; duration_time?: string;
    side_data_list?: FrameDynamicMetadata[] }> };
  if (!result.frames?.length) throw new Error("Could not inspect HDR video frames.");
  return result.frames.map((frame) => ({
    at: Number(frame.best_effort_timestamp_time),
    duration: Number(frame.duration_time),
    dynamic: frame.side_data_list?.filter(({ side_data_type }) => side_data_type === hdr10Plus) ?? [],
  }));
}

export async function planHdr10PlusEdit(ffprobe: string, path: string, stream: number, origin: number,
  rate: string | undefined, start: number, end: number, signal?: AbortSignal) {
  const frames = await probeFrames(ffprobe, path, stream, signal);
  if (!frames.some(({ dynamic }) => dynamic.length > 0)) return;
  const match = rate?.match(/^([1-9]\d{0,8})\/([1-9]\d{0,8})$/);
  const fps = match ? Number(match[1]) / Number(match[2]) : NaN;
  if (!rate || !Number.isFinite(fps) || fps < 1 || fps > 240 || !Number.isFinite(origin)
    || frames.some(({ at, dynamic }, i) => !Number.isFinite(at) || (i > 0 && at <= frames[i - 1]!.at)
      || dynamic.length !== 1)) {
    throw new Error("Unsupported HDR10+ frame layout.");
  }
  const first = frames.findIndex(({ at }) => at - origin >= start - 0.000001);
  const stop = frames.findIndex(({ at }) => at - origin >= end - 0.000001);
  const last = stop < 0 ? frames.length : stop;
  if (first < 0 || first >= last) throw new Error("No HDR10+ frames are inside this trim.");
  const selected = frames.slice(first, last);
  // hdr10plus_tool's JSON does not represent these optional bitstream fields.
  if (selected.some(({ dynamic: [metadata] }) => !metadata || metadata.num_windows !== 1
    || !/^0\/[1-9]\d*$/.test(metadata.fraction_bright_pixels ?? "")
    || metadata.num_rows_targeted_system_display_actual_peak_luminance !== undefined
    || metadata.num_rows_mastering_display_actual_peak_luminance !== undefined
    || metadata.color_saturation_weight !== undefined)) {
    throw new Error("Unsupported HDR10+ metadata for editing.");
  }
  const firstTime = selected[0]!.at;
  const timestamps = selected.map(({ at }) => Math.round((at - firstTime) * frameTimescale));
  const lastFrame = selected.at(-1)!;
  const next = frames[last]?.at;
  const finalDuration = Math.round((next === undefined ? lastFrame.duration : next - lastFrame.at) * frameTimescale);
  const nominalDuration = frameTimescale / fps;
  const variable = timestamps.some((pts, i) => Math.abs(pts - i * nominalDuration) > 2)
    || (Number.isFinite(finalDuration) && Math.abs(finalDuration - nominalDuration) > 2);
  let durations: number[] | undefined;
  if (variable) {
    durations = timestamps.map((pts, i) => i === timestamps.length - 1 ? finalDuration : timestamps[i + 1]! - pts);
    if (timestamps.some((pts) => !Number.isSafeInteger(pts))
      || durations.some((duration) => !Number.isInteger(duration) || duration <= 0 || duration > 2147483647)) {
      throw new Error("Unsupported HDR10+ frame clock.");
    }
  }
  return { first, last, sourceCount: frames.length, rate, start: Math.max(0, firstTime - origin), end,
    timestamps, durations, displayMetadata: selected.map(({ dynamic }) => dynamic) };
}

type EditPlan = NonNullable<Awaited<ReturnType<typeof planHdr10PlusEdit>>>;
type DynamicMetadata = Record<string, unknown> & { NumberOfWindows?: number; SequenceFrameIndex?: number;
  SceneFrameIndex?: number; SceneId?: number };

async function extract(ffmpeg: string, tool: string, movie: string, stream: number, json: string, signal?: AbortSignal) {
  const abort = new AbortController();
  const active = AbortSignal.any([AbortSignal.timeout(90_000), abort.signal, ...(signal ? [signal] : [])]);
  const demux = spawn(ffmpeg, ["-nostdin", "-v", "error", ...localMovie, "-i", movie, "-map", `0:${stream}`,
    "-c:v", "copy", "-bsf:v", "hevc_mp4toannexb", "-f", "hevc", "pipe:1"],
  { stdio: ["ignore", "pipe", "ignore"], signal: active });
  const read = spawn(tool, ["extract", "-o", json, "-"], { stdio: ["pipe", "ignore", "ignore"], signal: active });
  const jobs = [demux, read].map((child) => new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve() : reject(new Error("Could not extract HDR10+ metadata.")));
  }));
  jobs.push(pipeline(demux.stdout, read.stdin, { signal: active }));
  try {
    await Promise.all(jobs);
  } catch (error) {
    abort.abort();
    await Promise.allSettled(jobs);
    throw error;
  }
  if ((await stat(json)).size > maxMetadataBytes) throw new Error("HDR10+ metadata exceeds the processing limit.");
  return JSON.parse(await readFile(json, "utf8")) as { SceneInfo?: DynamicMetadata[]; SceneInfoSummary?: unknown };
}

function frameMetadata({ SequenceFrameIndex, SceneFrameIndex, SceneId, ...metadata }: DynamicMetadata) {
  return metadata;
}

export async function restoreHdr10Plus(ffmpeg: string, ffprobe: string, tool: string,
  source: string, sourceStream: number, encoded: string, output: string, plan: EditPlan, maxBytes: number, signal?: AbortSignal) {
  const directory = await mkdtemp(join(dirname(encoded), ".hdr10plus-"));
  const path = (name: string) => join(directory, name);
  const options = { timeout: 180_000, maxBuffer: 32 * 1024, signal };
  try {
    const frameCount = plan.last - plan.first;
    const sameClock = (frames: Awaited<ReturnType<typeof probeFrames>>) => frames.length === frameCount
      && frames.every(({ at }, i) => Math.abs(at * frameTimescale - plan.timestamps[i]!) <= 2);
    if (!sameClock(await probeFrames(ffprobe, encoded, 0, signal))) throw new Error("Edited HDR10+ frame timing changed.");
    const metadata = await extract(ffmpeg, tool, source, sourceStream, path("source.json"), signal);
    if (metadata.SceneInfo?.length !== plan.sourceCount || metadata.SceneInfo.some((frame, i) =>
      frame?.SequenceFrameIndex !== i || frame.NumberOfWindows !== 1)) throw new Error("HDR10+ metadata does not match the source frames.");
    const selected = metadata.SceneInfo.slice(plan.first, plan.last);
    const sceneStart: number[] = [];
    const sceneLengths: number[] = [];
    const scenes = selected.map((frame, i) => {
      if (i === 0 || frame.SceneId !== selected[i - 1]?.SceneId) {
        sceneStart.push(i);
        sceneLengths.push(0);
      }
      const scene = sceneStart.length - 1;
      sceneLengths[scene]!++;
      return { ...frame, SequenceFrameIndex: i, SceneId: scene, SceneFrameIndex: i - sceneStart[scene]! };
    });
    await writeFile(path("edit.json"), JSON.stringify({ ...metadata, SceneInfo: scenes,
      SceneInfoSummary: { SceneFirstFrameIndex: sceneStart, SceneFrameNumbers: sceneLengths } }));
    const convert = (args: string[]) => run(ffmpeg, ["-nostdin", "-v", "error", "-n", ...args], options);
    await convert([...localMovie, "-i", encoded, "-map", "0:v:0", "-c:v", "copy", "-bsf:v", "hevc_mp4toannexb",
      "-f", "hevc", path("encoded.hevc")]);
    await run(tool, ["inject", "-i", path("encoded.hevc"), "-j", path("edit.json"), "-o", path("attached.hevc")], options);
    const clockFilter = path("clock.bsf");
    if (plan.durations) {
      await writeHevcPacketClock(clockFilter, plan.timestamps, plan.durations);
    }
    // For a non-uniform clock, match the raw input tick to the setts and MP4 ticks.
    await convert(["-protocol_whitelist", "file", "-r", plan.durations ? String(frameTimescale) : plan.rate,
      "-f", "hevc", "-i", path("attached.hevc"),
      ...localMovie, "-i", encoded, "-copyts", "-map", "0:v:0", "-map", "1:a?", "-c", "copy", "-tag:v", "hvc1",
      ...(plan.durations ? ["-/bsf:v", clockFilter, "-video_track_timescale", String(frameTimescale)] : []),
      "-map_metadata", "-1", "-movflags", "+faststart+write_colr", "-fs", String(maxBytes + 1), "-f", "mp4", output]);
    const outputFrames = await probeFrames(ffprobe, output, 0, signal);
    const durations = plan.durations;
    if (!sameClock(outputFrames) || (durations && outputFrames.some(({ duration }, i) =>
      Math.round(duration * frameTimescale) !== durations[i]))
      || !isDeepStrictEqual(outputFrames.map(({ dynamic }) => dynamic), plan.displayMetadata)) {
      throw new Error("HDR10+ output changed frame timing or presentation metadata.");
    }
    const restored = await extract(ffmpeg, tool, output, 0, path("output.json"), signal);
    if (restored.SceneInfo?.length !== frameCount || !isDeepStrictEqual(
      restored.SceneInfo.map(frameMetadata), selected.map(frameMetadata))) throw new Error("HDR10+ output changed frame metadata.");
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}
