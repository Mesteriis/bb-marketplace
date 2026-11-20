// Dictation: a transcript as the paragraphs the composer inserts. The text
// comes from a voice service, so it is cleaned like any text from outside:
// nothing a reader cannot see, no control characters.
import { removeControls, removeHidden, truncateText } from "./html-entities.ts";

/** The most characters of one dictation. */
export const DICTATION_CHARS = 20_000;

/** A blank line starts a new paragraph; the lines of a paragraph are joined. Nothing for silence. */
export function dictatedParagraphs(transcript: string): string[] {
  const clean = truncateText(removeHidden(removeControls(transcript.replace(/\r\n?/g, "\n"))), DICTATION_CHARS);
  return clean
    .split(/\n[ \t]*\n+/)
    .map((paragraph) => paragraph.replace(/\s+/g, " ").trim())
    .filter((paragraph) => paragraph !== "");
}

const AUDIO_ENDINGS: Record<string, string> = { "audio/webm": "webm", "audio/mp4": "m4a", "audio/ogg": "ogg", "audio/wav": "wav", "audio/mpeg": "mp3" };

/**
 * The name and plain type a recording is handed over with: a voice service
 * often tells the format by the file's ending, and a type with codec
 * parameters ("audio/webm;codecs=opus") is not always known to it.
 */
export function dictationFile(recordedType: string): { name: string; type: string } {
  const plain = recordedType.split(";")[0]!.trim().toLowerCase();
  const type = AUDIO_ENDINGS[plain] !== undefined ? plain : "audio/webm";
  return { name: `dictation.${AUDIO_ENDINGS[type]}`, type };
}
