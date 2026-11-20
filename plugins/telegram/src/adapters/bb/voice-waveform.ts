const barCount = 100;

export function decodeVoiceWaveform(value: unknown) {
  if (typeof value !== "string" || !value || value.length > 1024) return;
  const data = Buffer.from(value, "base64");
  if (!data.length || data.toString("base64") !== value) return;

  const samples: number[] = [];
  let packed = 0;
  let bits = 0;
  for (const byte of data) {
    packed |= byte << bits;
    bits += 8;
    while (bits >= 5) {
      samples.push(packed & 31);
      packed >>>= 5;
      bits -= 5;
    }
  }
  if (samples.length <= barCount) return samples;
  return Array.from({ length: barCount }, (_, index) => {
    const start = Math.floor(index * samples.length / barCount);
    const stop = Math.floor((index + 1) * samples.length / barCount);
    return Math.max(...samples.slice(start, stop));
  });
}

export function encodeVoiceWaveform(pcm: Buffer) {
  const samples = Math.floor(pcm.length / 2);
  if (samples < barCount) return "";
  const peaks = Array.from({ length: barCount }, (_, bar) => {
    const start = Math.floor(bar * samples / barCount);
    const stop = Math.floor((bar + 1) * samples / barCount);
    let peak = 0;
    for (let sample = start; sample < stop; sample++) {
      peak = Math.max(peak, Math.abs(pcm.readInt16LE(sample * 2)));
    }
    return peak;
  });
  const reference = Math.max(512, peaks.reduce((sum, peak) => sum + peak, 0) * 1.5 / barCount);
  const bytes = Buffer.alloc(Math.ceil(barCount * 5 / 8));
  let packed = 0;
  let bits = 0;
  let cursor = 0;
  for (const peak of peaks) {
    const amplitude = Math.min(31, Math.round(peak * 31 / reference));
    packed |= amplitude << bits;
    bits += 5;
    if (bits >= 8) {
      bytes[cursor++] = packed & 255;
      packed >>>= 8;
      bits -= 8;
    }
  }
  if (bits) bytes[cursor] = packed;
  return bytes.toString("base64");
}
