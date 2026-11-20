import { beforeEach, describe, expect, it } from "vitest";
import { DICTATION_MAX_MS, DICTATION_TEXT, Dictation, type DictationState } from "./dictation.ts";

type Track = { stopped: boolean; stop(): void };
const makeStream = () => {
  const track: Track = { stopped: false, stop() { this.stopped = true; } };
  return { stream: { getTracks: () => [track] } as unknown as MediaStream, track };
};

let now: number;
let ticks: (() => void)[];
let tracks: Track[];
let audio: Blob;
let microphoneFails: boolean;
let transcripts: (string | Error)[];
let sent: Blob[];
let texts: string[];
let states: DictationState[];
let dictation: Dictation;

const tick = (ms: number) => {
  now += ms;
  for (const run of ticks) run();
};
const settle = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

beforeEach(() => {
  now = 0;
  ticks = [];
  tracks = [];
  audio = new Blob(["sound"]);
  microphoneFails = false;
  transcripts = [];
  sent = [];
  texts = [];
  states = [];
  dictation = new Dictation({
    microphone: async () => {
      if (microphoneFails) throw new Error("denied");
      const made = makeStream();
      tracks.push(made.track);
      return made.stream;
    },
    record: () => ({ stop: async () => audio }),
    transcribe: async (blob) => {
      sent.push(blob);
      const next = transcripts.shift() ?? "Hello Ann.";
      if (next instanceof Error) throw next;
      return next;
    },
    onText: (text) => texts.push(text),
    every: (run) => {
      ticks.push(run);
      return () => {
        ticks = ticks.filter((t) => t !== run);
      };
    },
    now: () => now,
  });
  dictation.subscribe((state) => states.push(state));
});

describe("Dictation", () => {
  it("records, counts the seconds, then gives the text and releases the microphone", async () => {
    await dictation.toggle();
    expect(dictation.current()).toEqual({ status: "recording", seconds: 0 });
    tick(3_400);
    expect(dictation.current()).toEqual({ status: "recording", seconds: 3 });
    await dictation.toggle();
    expect(texts).toEqual(["Hello Ann."]);
    expect(sent).toEqual([audio]);
    expect(dictation.current()).toEqual({ status: "idle" });
    expect(tracks.map((t) => t.stopped)).toEqual([true]);
    expect(ticks).toEqual([]);
    expect(states.map((s) => s.status)).toEqual(["starting", "recording", "recording", "transcribing", "transcribing", "idle"]);
  });

  it("cancel throws the recording away: nothing is sent, the microphone is released", async () => {
    await dictation.toggle();
    dictation.cancel();
    await settle();
    expect(sent).toEqual([]);
    expect(texts).toEqual([]);
    expect(tracks[0]!.stopped).toBe(true);
    expect(dictation.current()).toEqual({ status: "idle" });
  });

  it("stops by itself after five minutes and transcribes", async () => {
    await dictation.toggle();
    tick(DICTATION_MAX_MS);
    await settle();
    expect(texts).toEqual(["Hello Ann."]);
    expect(tracks[0]!.stopped).toBe(true);
  });

  it("says why when the microphone is refused, and records nothing", async () => {
    microphoneFails = true;
    await dictation.toggle();
    expect(dictation.current()).toEqual({ status: "failed", message: DICTATION_TEXT.microphone, retry: false });
    expect(tracks).toEqual([]);
    // The button starts again from the failure.
    microphoneFails = false;
    await dictation.toggle();
    expect(dictation.current().status).toBe("recording");
  });

  it("a failed transcription can be sent once more, then the recording is gone", async () => {
    transcripts.push(new Error("offline"), new Error("offline"));
    await dictation.toggle();
    await dictation.toggle();
    expect(dictation.current()).toEqual({ status: "failed", message: DICTATION_TEXT.failed, retry: true });
    await dictation.retry();
    expect(dictation.current()).toEqual({ status: "failed", message: DICTATION_TEXT.failed, retry: false });
    await dictation.retry();
    expect(sent).toHaveLength(2);
    expect(texts).toEqual([]);
    expect(tracks[0]!.stopped).toBe(true);
  });

  it("silence gives no text: an empty recording or an empty transcript", async () => {
    audio = new Blob([]);
    await dictation.toggle();
    await dictation.toggle();
    expect(dictation.current()).toEqual({ status: "failed", message: DICTATION_TEXT.empty, retry: false });
    expect(sent).toEqual([]);
    audio = new Blob(["sound"]);
    transcripts.push("   ");
    await dictation.toggle();
    await dictation.toggle();
    expect(dictation.current()).toEqual({ status: "failed", message: DICTATION_TEXT.empty, retry: false });
    expect(texts).toEqual([]);
  });

  it("an answer that arrives after cancel or dispose is dropped", async () => {
    let answer!: (text: string) => void;
    const slow = new Dictation({
      microphone: async () => makeStream().stream,
      record: () => ({ stop: async () => audio }),
      transcribe: () => new Promise<string>((resolve) => { answer = resolve; }),
      onText: (text) => texts.push(text),
      every: () => () => {},
      now: () => now,
    });
    await slow.toggle();
    void slow.toggle();
    await settle();
    expect(slow.current()).toEqual({ status: "transcribing" });
    slow.dispose();
    answer("Too late.");
    await settle();
    expect(texts).toEqual([]);
    expect(slow.current()).toEqual({ status: "idle" });
  });

  it("waits in 'starting' while the browser asks: a second press asks nothing more, Cancel releases the late stream", async () => {
    let asked = 0;
    let give: (stream: MediaStream) => void = () => {};
    const made = makeStream();
    const pending = new Dictation({
      microphone: () => {
        asked++;
        return new Promise<MediaStream>((resolve) => (give = resolve));
      },
      record: () => ({ stop: async () => audio }),
      transcribe: async () => "x",
      onText: (text) => texts.push(text),
    });
    void pending.toggle();
    await settle();
    expect(pending.current()).toEqual({ status: "starting" });
    void pending.toggle();
    await settle();
    expect(asked).toBe(1);
    pending.cancel();
    expect(pending.current()).toEqual({ status: "idle" });
    give(made.stream);
    await settle();
    expect(made.track.stopped).toBe(true);
    expect(pending.current()).toEqual({ status: "idle" });
  });

  it("with no voice service in BB it says so and never asks for the microphone", async () => {
    let asked = 0;
    const off = new Dictation({
      ready: async () => false,
      microphone: async () => {
        asked++;
        return makeStream().stream;
      },
      record: () => ({ stop: async () => audio }),
      transcribe: async () => "x",
      onText: () => {},
    });
    await off.toggle();
    expect(off.current()).toEqual({ status: "failed", message: "Dictation needs a voice service: choose one in BB's settings.", retry: false });
    expect(asked).toBe(0);
  });

  it("when BB cannot say whether a voice service is set, recording goes on", async () => {
    const unknown = new Dictation({
      ready: async () => Promise.reject(new Error("no config")),
      microphone: async () => makeStream().stream,
      record: () => ({ stop: async () => audio }),
      transcribe: async () => "x",
      onText: () => {},
      every: () => () => {},
    });
    await unknown.toggle();
    expect(unknown.current()).toEqual({ status: "recording", seconds: 0 });
  });

  it("a recorder that cannot start or cannot stop releases the microphone and says why", async () => {
    const first = makeStream();
    const noStart = new Dictation({
      microphone: async () => first.stream,
      record: () => {
        throw new Error("unsupported");
      },
      transcribe: async () => "x",
      onText: () => {},
    });
    await noStart.toggle();
    expect(noStart.current()).toEqual({ status: "failed", message: DICTATION_TEXT.microphone, retry: false });
    expect(first.track.stopped).toBe(true);

    const second = makeStream();
    const noStop = new Dictation({
      microphone: async () => second.stream,
      record: () => ({ stop: async () => Promise.reject(new Error("broken")) }),
      transcribe: async () => "x",
      onText: () => {},
      every: () => () => {},
    });
    await noStop.toggle();
    await noStop.toggle();
    expect(noStop.current()).toEqual({ status: "failed", message: DICTATION_TEXT.failed, retry: false });
    expect(second.track.stopped).toBe(true);
  });
});
