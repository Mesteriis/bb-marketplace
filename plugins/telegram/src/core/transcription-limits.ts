export const maxTranscriptionBytes = 16 * 1024 * 1024;
export const maxTranscriptionSeconds = { voice: 600, video: 60 } as const;

export function transcriptionLimit(kind: keyof typeof maxTranscriptionSeconds, durationSeconds = 0, sizeBytes = 0) {
  if (sizeBytes > maxTranscriptionBytes) return "size";
  if (durationSeconds > maxTranscriptionSeconds[kind]) return "duration";
}
