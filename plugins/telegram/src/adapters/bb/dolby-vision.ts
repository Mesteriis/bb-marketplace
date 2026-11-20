import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { isDeepStrictEqual, promisify } from "node:util";
import { z } from "zod";
import { frameTimescale, writeHevcPacketClock } from "./hevc-packet-clock.ts";

const run = promisify(execFile);
const localMovie = ["-protocol_whitelist", "file", "-enable_drefs", "0", "-f", "mov"];
const offset = z.number().int().min(0).max(8191);
const edges = z.object({ left: offset, right: offset, top: offset, bottom: offset });
const activeArea = z.object({
  presets: z.array(edges.extend({ id: z.number().int().nonnegative() })).min(1),
  edits: z.record(z.string(), z.number().int().nonnegative()),
});
type ActiveArea = z.infer<typeof activeArea>;
type Edges = z.infer<typeof edges>;
type Dimensions = { width: number; height: number };

export function findDolbyVisionTool() {
  return ["/opt/homebrew/bin/dovi_tool", "/usr/local/bin/dovi_tool"].find(existsSync);
}

function completed(child: ChildProcess) {
  return new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve() : reject(new Error("Could not read Dolby Vision metadata.")));
  });
}

async function extractRpu(ffmpeg: string, tool: string, file: string, stream: number, rpu: string, signal?: AbortSignal) {
  const abort = new AbortController();
  const active = AbortSignal.any([AbortSignal.timeout(90_000), abort.signal, ...(signal ? [signal] : [])]);
  active.throwIfAborted();
  const demux = spawn(ffmpeg, ["-nostdin", "-v", "error", ...localMovie, "-i", file, "-map", `0:${stream}`, "-c:v", "copy",
    "-bsf:v", "hevc_mp4toannexb", "-f", "hevc", "pipe:1"], { stdio: ["ignore", "pipe", "ignore"], signal: active });
  const extract = spawn(tool, ["extract-rpu", "-", "-o", rpu], { stdio: ["pipe", "ignore", "ignore"], signal: active });
  const jobs = [completed(demux), completed(extract), pipeline(demux.stdout, extract.stdin, { signal: active })];
  try {
    await Promise.all(jobs);
  } catch (error) {
    abort.abort();
    await Promise.allSettled(jobs);
    throw error;
  }
  if ((await stat(rpu)).size < 1) throw new Error("Missing Dolby Vision metadata.");
}

async function readArea(tool: string, rpu: string, areaPath: string, signal?: AbortSignal) {
  await run(tool, ["export", rpu, "-d", `level5=${areaPath}`], { timeout: 20_000, maxBuffer: 32 * 1024, signal });
  if ((await stat(areaPath)).size > 1024 * 1024) throw new Error("Dolby Vision active area exceeds the processing limit.");
  const value = JSON.parse(await readFile(areaPath, "utf8"));
  const area = activeArea.parse(value?.active_area ?? value);
  const presets = new Set(area.presets.map(({ id }) => id));
  const edits = Object.entries(area.edits);
  if (presets.size !== area.presets.length || !edits.length
    || edits.some(([range, id]) => !/^(all|\d{1,9}(?:-\d{1,9})?)$/.test(range) || !presets.has(id))) {
    throw new Error("Invalid Dolby Vision active area.");
  }
  return area;
}

const fitsFrame = ({ left, right, top, bottom }: Edges, { width, height }: Dimensions) =>
  left + right < width && top + bottom < height;

export async function inspectDolbyVisionArea(ffmpeg: string, tool: string, file: string, stream: number, frame: Dimensions, signal?: AbortSignal) {
  const directory = await mkdtemp(join(dirname(file), ".dovi-"));
  try {
    const rpu = join(directory, "area.rpu");
    await extractRpu(ffmpeg, tool, file, stream, rpu, signal);
    const area = await readArea(tool, rpu, join(directory, "area.json"), signal);
    if (!area.presets.every((preset) => fitsFrame(preset, frame))) throw new Error("Dolby Vision active area is outside the frame.");
    return { fullFrame: area.presets.every(({ left, right, top, bottom }) => !left && !right && !top && !bottom),
      offsets: area.presets.map(({ id, ...offsets }) => offsets) };
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

function frameAreas(area: ActiveArea, count: number) {
  const presets = new Map(area.presets.map(({ id, ...offsets }) => [id, offsets]));
  const result: Edges[] = Array(count);
  let processed = 0;
  for (const [range, id] of Object.entries(area.edits)) {
    const [from, to = from] = range === "all" ? [0, count - 1] : range.split("-").map(Number);
    if (from === undefined || to === undefined || from > to || to >= count) throw new Error("Invalid Dolby Vision RPU frame range.");
    const offsets = presets.get(id)!;
    for (let i = from; i <= to; i++) {
      if (result[i]) throw new Error("Overlapping Dolby Vision RPU frame ranges.");
      result[i] = offsets;
      processed++;
    }
  }
  if (processed !== count) throw new Error("Incomplete Dolby Vision RPU frame ranges.");
  return result;
}

async function packetClock(ffprobe: string, file: string, signal?: AbortSignal) {
  const { stdout } = await run(ffprobe, ["-v", "error", ...localMovie, "-select_streams", "v:0", "-show_entries",
    "packet=pts_time,dts_time,duration_time", "-of", "json", file], { timeout: 90_000, maxBuffer: 64 * 1024 * 1024, signal });
  const packets = (JSON.parse(stdout) as { packets?: { pts_time?: string; dts_time?: string; duration_time?: string }[] }).packets;
  if (!packets?.length) throw new Error("Missing Dolby Vision packet timing.");
  const times: number[] = [], durations: number[] = [];
  for (const { pts_time, dts_time, duration_time } of packets) {
    const time = Math.round(Number(pts_time) * frameTimescale);
    const duration = Math.round(Number(duration_time) * frameTimescale);
    if (pts_time !== dts_time || !Number.isSafeInteger(time) || time < 0 || time <= (times.at(-1) ?? -1)
      || !Number.isInteger(duration) || duration < 1 || duration > 2147483647) throw new Error("Unsupported Dolby Vision packet clock.");
    times.push(time);
    durations.push(duration);
  }
  for (let i = 0; i < times.length - 1; i++) {
    const interval = times[i + 1]! - times[i]!;
    if (Math.abs(interval - durations[i]!) > 2 || interval > 2147483647) {
      throw new Error("Discontinuous Dolby Vision packet clock.");
    }
    durations[i] = interval;
  }
  return { times, durations };
}

export async function rescaleDolbyVisionArea(ffmpeg: string, ffprobe: string, tool: string, encoded: string, output: string,
  source: Dimensions, destination: Dimensions, sourceOffsets: readonly Edges[], maxBytes: number, signal?: AbortSignal) {
  const directory = await mkdtemp(join(dirname(encoded), ".dovi-resize-"));
  const path = (name: string) => join(directory, name);
  const options = { timeout: 180_000, maxBuffer: 32 * 1024, signal };
  const convert = (args: string[]) => run(ffmpeg, ["-nostdin", "-v", "error", "-n", ...args], options);
  try {
    const clock = await packetClock(ffprobe, encoded, signal);
    const raw = path("encoded.hevc"), rpu = path("encoded.rpu");
    await convert([...localMovie, "-i", encoded, "-map", "0:v:0", "-c:v", "copy", "-bsf:v", "hevc_mp4toannexb", "-f", "hevc", raw]);
    await run(tool, ["extract-rpu", raw, "-o", rpu], options);
    const input = await readArea(tool, rpu, path("input.json"), signal);
    const knownOffsets = new Set(sourceOffsets.map((area) => JSON.stringify(area)));
    if (input.presets.some(({ id, ...area }) => !knownOffsets.has(JSON.stringify(area)))) {
      throw new Error("Resizing changed the Dolby Vision active area before it could be remapped.");
    }
    const scaled = { edits: input.edits, presets: input.presets.map(({ id, left, right, top, bottom }) => ({
      id, left: Math.round(left * destination.width / source.width), right: Math.round(right * destination.width / source.width),
      top: Math.round(top * destination.height / source.height), bottom: Math.round(bottom * destination.height / source.height),
    })) };
    if (scaled.presets.some((preset) => !fitsFrame(preset, destination))) throw new Error("Rescaled Dolby Vision active area is empty.");
    const expected = frameAreas(scaled, clock.times.length);
    await writeFile(path("scale.json"), JSON.stringify({ active_area: scaled }));
    await run(tool, ["editor", rpu, "-j", path("scale.json"), "-o", path("scaled.rpu")], options);
    await run(tool, ["inject-rpu", "-i", raw, "--rpu-in", path("scaled.rpu"), "--no-add-aud", "-o", path("scaled.hevc")], options);
    const clockFilter = path("clock.bsf");
    await writeHevcPacketClock(clockFilter, clock.times, clock.durations, "dovi_rpu=compression=none");
    await convert(["-protocol_whitelist", "file", "-r", String(frameTimescale), "-f", "hevc", "-i", path("scaled.hevc"),
      ...localMovie, "-i", encoded, "-map", "0:v:0", "-map", "1:a?", "-copyts", "-c", "copy", "-tag:v", "hvc1",
      "-strict", "unofficial", "-/bsf:v", clockFilter, "-video_track_timescale", String(frameTimescale),
      "-map_metadata", "-1", "-movflags", "+faststart+write_colr", "-fs", String(maxBytes + 1), "-f", "mp4", output]);
    const actualClock = await packetClock(ffprobe, output, signal);
    if (!isDeepStrictEqual(actualClock, clock)) throw new Error("Dolby Vision active-area edit changed the packet clock.");
    const verifiedRpu = path("verified.rpu");
    await extractRpu(ffmpeg, tool, output, 0, verifiedRpu, signal);
    const verified = await readArea(tool, verifiedRpu, path("verified.json"), signal);
    if (!isDeepStrictEqual(frameAreas(verified, clock.times.length), expected)) throw new Error("Dolby Vision active-area verification failed.");
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}
