import { voiceTranscript, type VoiceTranscriptData } from "../../core/contract.ts";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

async function cachedModel() {
  const snapshots = join(homedir(), ".cache/huggingface/hub/models--mlx-community--whisper-large-v3-turbo/snapshots");
  const entries = await readdir(snapshots).catch(() => []);
  return entries.map((name) => join(snapshots, name)).find((directory) =>
    existsSync(join(directory, "config.json")) && existsSync(join(directory, "weights.safetensors")));
}

export async function videoNoteAudio(video: Buffer, signal?: AbortSignal): Promise<Buffer> {
  const ffmpeg = ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg"].find(existsSync);
  if (!ffmpeg || signal?.aborted) throw new Error("Local video transcription is unavailable.");
  const directory = await mkdtemp(join(tmpdir(), "makosh-note-audio-"));
  try {
    const input = join(directory, "note.mp4");
    const output = join(directory, "note.ogg");
    await writeFile(input, video, { mode: 0o600 });
    await run(ffmpeg, ["-nostdin", "-v", "error", "-protocol_whitelist", "file",
      "-enable_drefs", "0", "-f", "mov", "-i", input, "-map", "0:a:0", "-t", "60",
      "-vn", "-ac", "1", "-ar", "16000", "-c:a", "libopus", "-b:a", "24k", "-f", "ogg", output],
    { signal, timeout: 20_000, maxBuffer: 32 * 1024 });
    return await readFile(output);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export function parseLocalTranscript(value: unknown): VoiceTranscriptData {
  const payload = value as { text?: unknown; segments?: unknown } | null;
  if (typeof payload?.text !== "string") throw new Error("Local transcription result is invalid.");
  const segments: VoiceTranscriptData["segments"] = [];
  let remaining = 8192;
  for (const part of (Array.isArray(payload.segments) ? payload.segments : []).slice(0, 256)) {
    if (!remaining) break;
    const start: unknown = part?.start;
    if (typeof start !== "number" || !Number.isFinite(start) || start < 0 || start > 600
      || start < (segments.at(-1)?.start ?? 0) || typeof part?.text !== "string") continue;
    const text = part.text.trim().slice(0, remaining);
    if (!text) continue;
    segments.push({ start, text });
    remaining -= text.length;
  }
  return voiceTranscript.parse({ text: payload.text.trim().slice(0, 8192), segments });
}

export function createLocalTranscription() {
  const cache = new Map<string, { key: string; result: VoiceTranscriptData }>();
  let running: Promise<unknown> = Promise.resolve();
  return {
    transcribe(id: string, key: string, getAudio: () => Promise<Buffer>, signal?: AbortSignal, onSegments?: (segments: VoiceTranscriptData["segments"]) => void) {
      const work = running.then(async () => {
        signal?.throwIfAborted();
        const saved = cache.get(id);
        if (saved?.key === key) {
          onSegments?.(saved.result.segments);
          return saved.result.text;
        }
        const uv = ["/opt/homebrew/bin/uv", "/usr/local/bin/uv"].find(existsSync);
        const model = await cachedModel();
        signal?.throwIfAborted();
        if (!uv || !model) throw new Error("Local MLX Whisper is unavailable.");
        const audio = await getAudio();
        signal?.throwIfAborted();
        const directory = await mkdtemp(join(tmpdir(), "makosh-voice-"));
        try {
          const input = join(directory, "voice.ogg");
          await writeFile(input, audio, { mode: 0o600 });
          signal?.throwIfAborted();
          await run(uv, ["tool", "run", "--offline", "--from", "mlx-whisper", "mlx_whisper", input,
            "--model", model, "--output-dir", directory, "--output-name", "voice", "--output-format", "json", "--verbose", "False"],
          { cwd: directory, signal, timeout: 80_000, maxBuffer: 128 * 1024, env: {
            ...process.env, PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH ?? "/usr/bin:/bin"}`,
            HF_HUB_OFFLINE: "1", UV_OFFLINE: "1",
          } });
          const result = parseLocalTranscript(JSON.parse(await readFile(join(directory, "voice.json"), "utf8")));
          signal?.throwIfAborted();
          if (cache.size >= 128) cache.delete(cache.keys().next().value!);
          cache.set(id, { key, result });
          onSegments?.(result.segments);
          return result.text;
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
      });
      running = work.catch(() => {});
      return work;
    },
    clear() { cache.clear(); },
  };
}
