// Dictation: a transcript as the paragraphs the composer inserts. The text
// comes from a voice service, so it is cleaned like any text from outside:
// nothing a reader cannot see, no control characters.
import { removeControls, removeHidden } from "./html-entities.ts";

/** The most characters of one dictation. */
export const DICTATION_CHARS = 20_000;

/** A blank line starts a new paragraph; the lines of a paragraph are joined. Nothing for silence. */
export function dictatedParagraphs(transcript: string): string[] {
  const clean = removeHidden(removeControls(transcript.replace(/\r\n?/g, "\n"))).slice(0, DICTATION_CHARS);
  return clean
    .split(/\n[ \t]*\n+/)
    .map((paragraph) => paragraph.replace(/\s+/g, " ").trim())
    .filter((paragraph) => paragraph !== "");
}
