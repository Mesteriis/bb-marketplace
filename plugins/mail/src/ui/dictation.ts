// Dictation in the composer: record, then let BB's voice service turn the
// recording into text. Browser APIs only (MediaRecorder, getUserMedia),
// both injected, so the page stays host-free and the tests need no audio.
// The microphone is released at every end: stop, cancel, an error, the
// time limit, dispose. A recording is kept in memory only until its text
// arrived, or for one retry after a failure.
import { useEffect, useMemo, useRef, useState } from "react";

/** A recording stops and is transcribed by itself after this long. */
export const DICTATION_MAX_MS = 5 * 60_000;

export type DictationState =
  | { status: "idle" }
  | { status: "recording"; seconds: number }
  | { status: "transcribing" }
  /** `retry`: the recording is still held and can be sent again. */
  | { status: "failed"; message: string; retry: boolean };

/** One recording in progress. */
export interface DictationRecorder {
  /** Ends the recording and gives its audio. */
  stop(): Promise<Blob>;
}

export interface DictationDeps {
  /** Asks for the microphone; rejects when there is none or the owner refused. */
  microphone: () => Promise<MediaStream>;
  /** Starts recording the stream. */
  record: (stream: MediaStream) => DictationRecorder;
  /** BB's voice service. */
  transcribe: (audio: Blob, signal: AbortSignal) => Promise<string>;
  /** The text of a finished dictation. */
  onText: (text: string) => void;
  /** Runs `run` every `ms` until the answer is called. */
  every?: (run: () => void, ms: number) => () => void;
  now?: () => number;
}

export const DICTATION_TEXT = {
  microphone: "The microphone is not available. Allow it for BB and try again.",
  failed: "The recording could not be turned into text.",
  empty: "Nothing was heard.",
} as const;

const defaultEvery = (run: () => void, ms: number) => {
  const timer = setInterval(run, ms);
  return () => clearInterval(timer);
};

export class Dictation {
  private state: DictationState = { status: "idle" };
  private stream: MediaStream | null = null;
  private recorder: DictationRecorder | null = null;
  private stopTicking: (() => void) | null = null;
  private startedAt = 0;
  private abort: AbortController | null = null;
  private kept: Blob | null = null;
  /** Bumped at every start and cancel: an answer of an older run is dropped. */
  private run = 0;
  private listener: ((state: DictationState) => void) | null = null;

  constructor(private readonly deps: DictationDeps) {}

  current(): DictationState {
    return this.state;
  }

  subscribe(listener: (state: DictationState) => void): () => void {
    this.listener = listener;
    return () => {
      if (this.listener === listener) this.listener = null;
    };
  }

  /** The button: starts from idle or a failure, stops and transcribes while recording. */
  async toggle(): Promise<void> {
    if (this.state.status === "recording") return this.finish();
    if (this.state.status === "transcribing") return;
    await this.start();
  }

  /** Throws the recording (or the pending transcription, or a kept failure) away. */
  cancel(): void {
    this.run++;
    this.abort?.abort();
    this.abort = null;
    this.kept = null;
    const recorder = this.recorder;
    this.recorder = null;
    this.release();
    // The recorder is ended so the browser drops its buffer; its audio is not used.
    void recorder?.stop().catch(() => {});
    this.set({ status: "idle" });
  }

  /** Sends a failed recording once more. */
  async retry(): Promise<void> {
    if (this.state.status !== "failed" || this.kept === null) return;
    const audio = this.kept;
    this.kept = null;
    await this.send(audio, ++this.run, false);
  }

  /** The composer is closing: everything stops. */
  dispose(): void {
    this.cancel();
    this.listener = null;
  }

  private set(state: DictationState): void {
    this.state = state;
    this.listener?.(state);
  }

  private release(): void {
    this.stopTicking?.();
    this.stopTicking = null;
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    this.stream = null;
  }

  private async start(): Promise<void> {
    const run = ++this.run;
    this.kept = null;
    let stream: MediaStream;
    try {
      stream = await this.deps.microphone();
    } catch {
      if (run === this.run) this.set({ status: "failed", message: DICTATION_TEXT.microphone, retry: false });
      return;
    }
    if (run !== this.run) {
      // Cancelled while the browser asked for permission.
      for (const track of stream.getTracks()) track.stop();
      return;
    }
    this.stream = stream;
    try {
      this.recorder = this.deps.record(stream);
    } catch {
      this.release();
      this.set({ status: "failed", message: DICTATION_TEXT.microphone, retry: false });
      return;
    }
    const now = this.deps.now ?? Date.now;
    this.startedAt = now();
    this.set({ status: "recording", seconds: 0 });
    this.stopTicking = (this.deps.every ?? defaultEvery)(() => {
      if (run !== this.run || this.state.status !== "recording") return;
      const elapsed = now() - this.startedAt;
      if (elapsed >= DICTATION_MAX_MS) void this.finish();
      else this.set({ status: "recording", seconds: Math.floor(elapsed / 1000) });
    }, 1000);
  }

  private async finish(): Promise<void> {
    const recorder = this.recorder;
    if (recorder === null) return;
    const run = this.run;
    this.recorder = null;
    this.set({ status: "transcribing" });
    let audio: Blob;
    try {
      audio = await recorder.stop();
    } catch {
      this.release();
      if (run === this.run) this.set({ status: "failed", message: DICTATION_TEXT.failed, retry: false });
      return;
    }
    this.release();
    if (run !== this.run) return;
    if (audio.size === 0) {
      this.set({ status: "failed", message: DICTATION_TEXT.empty, retry: false });
      return;
    }
    await this.send(audio, run, true);
  }

  private async send(audio: Blob, run: number, mayRetry: boolean): Promise<void> {
    this.set({ status: "transcribing" });
    this.abort = new AbortController();
    try {
      const text = await this.deps.transcribe(audio, this.abort.signal);
      if (run !== this.run) return;
      this.abort = null;
      if (text.trim() === "") {
        this.set({ status: "failed", message: DICTATION_TEXT.empty, retry: false });
        return;
      }
      this.set({ status: "idle" });
      this.deps.onText(text);
    } catch {
      if (run !== this.run) return;
      this.abort = null;
      this.kept = mayRetry ? audio : null;
      this.set({ status: "failed", message: DICTATION_TEXT.failed, retry: mayRetry });
    }
  }
}

/** The browser's microphone and recorder. */
export const browserDictation: Pick<DictationDeps, "microphone" | "record"> = {
  microphone: () => {
    const media = typeof navigator === "undefined" ? undefined : navigator.mediaDevices;
    if (media === undefined || typeof MediaRecorder === "undefined") return Promise.reject(new Error("no microphone"));
    return media.getUserMedia({ audio: true });
  },
  record: (stream) => {
    const recorder = new MediaRecorder(stream);
    const chunks: Blob[] = [];
    recorder.addEventListener("dataavailable", (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    });
    recorder.start();
    return {
      stop: () =>
        new Promise<Blob>((resolve, reject) => {
          recorder.addEventListener("stop", () => resolve(new Blob(chunks, { type: recorder.mimeType || "audio/webm" })), { once: true });
          recorder.addEventListener("error", () => reject(new Error("recording failed")), { once: true });
          if (recorder.state === "inactive") resolve(new Blob(chunks, { type: recorder.mimeType || "audio/webm" }));
          else recorder.stop();
        }),
    };
  },
};

/** One dictation for a composer; it ends with the component. */
export function useDictation(deps: DictationDeps): { state: DictationState; toggle: () => void; cancel: () => void; retry: () => void } {
  const latest = useRef(deps);
  latest.current = deps;
  const dictation = useMemo(
    () =>
      new Dictation({
        microphone: () => latest.current.microphone(),
        record: (stream) => latest.current.record(stream),
        transcribe: (audio, signal) => latest.current.transcribe(audio, signal),
        onText: (text) => latest.current.onText(text),
        ...(deps.every !== undefined ? { every: deps.every } : {}),
        ...(deps.now !== undefined ? { now: deps.now } : {}),
      }),
    // One instance per component: the dependencies are read through the ref.
    [],
  );
  const [state, setState] = useState<DictationState>(dictation.current());
  useEffect(() => {
    const off = dictation.subscribe(setState);
    return () => {
      off();
      dictation.dispose();
    };
  }, [dictation]);
  return {
    state,
    toggle: () => void dictation.toggle(),
    cancel: () => dictation.cancel(),
    retry: () => void dictation.retry(),
  };
}
