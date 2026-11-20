import { useTelegramLocale } from "./i18n/index.tsx";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { VoiceTrim } from "../core/contract.ts";

import { audioPeaks } from "./audio-waveform.ts";

const showSeconds = (ms: number) => `${(ms / 1000).toFixed(2)} s`;

export function VoiceTrimPreview({ blob, decoded, trim, change, disabled }: {
  blob: Blob;
  decoded?: AudioBuffer;
  trim?: VoiceTrim;
  change: (trim: VoiceTrim | undefined) => void;
  disabled: boolean;
}) {
  const { t: tr } = useTelegramLocale();
  const [result, setResult] = useState<{ blob: Blob; audio?: AudioBuffer }>();
  const [playing, setPlaying] = useState(false);
  const [playFailed, setPlayFailed] = useState(false);
  const playback = useRef<{ context: AudioContext; source: AudioBufferSourceNode }>(undefined);
  const audio = decoded ?? (result?.blob === blob ? result.audio : undefined);
  const stop = useCallback((stopSource = true) => {
    const active = playback.current;
    if (!active) return;
    playback.current = undefined;
    active.source.onended = null;
    if (stopSource) active.source.stop();
    void active.context.close().catch(() => undefined);
    setPlaying(false);
  }, []);

  useEffect(() => {
    if (decoded) return;
    let active = true;
    async function decode() {
      let context: AudioContext | undefined;
      try {
        context = new AudioContext();
        const audio = await context.decodeAudioData(await blob.arrayBuffer());
        if (active) setResult({ blob, audio });
      } catch {
        if (active) setResult({ blob });
      } finally {
        if (context) await context.close().catch(() => undefined);
      }
    }
    void decode();
    return () => { active = false; };
  }, [blob, decoded]);

  useEffect(() => stop, [blob, stop]);
  useEffect(() => { if (disabled) stop(); }, [disabled, stop]);

  const waveform = useMemo(() => audio ? audioPeaks(audio, 56) : [], [audio]);
  const end = Math.floor(Math.min(audio?.duration ?? 0, 120) * 1000);
  const startMs = trim?.startMs ?? 0;
  const endMs = trim?.endMs ?? end;
  const range = endMs - startMs;

  function update(next: VoiceTrim) {
    stop();
    change(next.startMs === 0 && next.endMs === end ? undefined : next);
  }

  function play() {
    if (!audio || !range || disabled) return;
    if (playback.current) { stop(); return; }
    let context: AudioContext | undefined;
    try {
      context = new AudioContext();
      const source = context.createBufferSource();
      source.buffer = audio;
      source.connect(context.destination);
      source.onended = () => stop(false);
      source.start(0, startMs / 1000, range / 1000);
      playback.current = { context, source };
      setPlayFailed(false);
      setPlaying(true);
      void context.resume().catch(() => {
        if (playback.current?.source !== source) return;
        stop();
        setPlayFailed(true);
      });
    } catch {
      if (context) void context.close().catch(() => undefined);
      setPlayFailed(true);
    }
  }

  if (!audio) return <p role="status">{result?.blob === blob ? tr("Voice preview unavailable.") : tr("Preparing voice preview…")}</p>;
  return <fieldset className="mtg-voice-trim" disabled={disabled}>
    <legend>{tr("Voice preview")}</legend>
    <div className="mtg-voice-trim-wave" aria-hidden="true">
      {waveform.map((peak, index) => {
        const sampleTime = (index + 0.5) / waveform.length * end;
        return <span key={index} data-selected={sampleTime >= startMs && sampleTime <= endMs || undefined}
          style={{ height: `${12 + peak * 88}%` }} />;
      })}
    </div>
    {end >= 100 && <>
      <label>{tr("Start")}<input type="range" min={0} max={endMs - 100} step={1} value={startMs} aria-valuetext={showSeconds(startMs)}
          onChange={(event) => update({ startMs: event.currentTarget.valueAsNumber, endMs })} />
      </label>
      <label>{tr("End")}<input type="range" min={startMs + 100} max={end} step={1} value={endMs} aria-valuetext={showSeconds(endMs)}
          onChange={(event) => update({ startMs, endMs: event.currentTarget.valueAsNumber })} />
      </label>
    </>}
    <div className="mtg-media-choices">
      <button type="button" className="mtg-action" onClick={play} disabled={range === 0}>{playing ? tr("Stop voice preview") : tr("Play voice preview")}</button>
      {trim && <button type="button" className="mtg-action" onClick={() => update({ startMs: 0, endMs: end })}>{tr("Reset trim")}</button>}
      <output aria-label={tr("Selected duration")}>{showSeconds(range)}</output>
    </div>
    {playFailed && <p role="status">{tr("Could not play the voice preview.")}</p>}
  </fieldset>;
}
