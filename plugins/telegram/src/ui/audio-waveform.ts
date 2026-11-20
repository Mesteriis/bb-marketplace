export function audioPeaks(audio: AudioBuffer, bars: number) {
  const channels = Array.from({ length: audio.numberOfChannels }, (_, index) => audio.getChannelData(index));
  return Array.from({ length: bars }, (_, index) => {
    const from = Math.floor(index * audio.length / bars);
    const to = Math.max(from + 1, Math.floor((index + 1) * audio.length / bars));
    const stride = Math.max(1, Math.floor((to - from) / 200));
    let peak = 0;
    for (const samples of channels) {
      for (let sample = from; sample < to; sample += stride) peak = Math.max(peak, Math.abs(samples[sample] ?? 0));
    }
    return Math.min(1, peak);
  });
}

export function canDecodeAudioWaveform(bytes?: number, duration?: number) {
  return bytes !== undefined && bytes > 0 && bytes <= 8 * 1024 * 1024 &&
    duration !== undefined && duration > 0 && duration <= 5 * 60;
}

export async function decodeAudioWaveform(blob: Blob, signal: AbortSignal) {
  if (typeof AudioContext !== "function" || blob.size > 8 * 1024 * 1024) return;
  const context = new AudioContext({ sampleRate: 16000 });
  try {
    const bytes = await blob.arrayBuffer();
    if (signal.aborted) return;
    const audio = await context.decodeAudioData(bytes);
    if (!signal.aborted) return audioPeaks(audio, 112);
  } finally {
    void context.close().catch(() => {});
  }
}
