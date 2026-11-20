import { expect, test } from "vitest";
import { documentIconKind } from "../src/ui/document-icon.tsx";

test.each([
  ["Agenda.PDF", "pdf"],
  ["Budget.xlsx", "table"],
  ["Minutes.docx", "word"],
  ["Review.pptx", "powerpoint"],
  ["Photos.tar.gz", "zip"],
  ["Cover.webp", "image"],
  ["Notes.md", "markdown"],
  ["untitled", "document"],
] as const)("uses the file type icon for %s", (name, kind) => {
  expect(documentIconKind({ name })).toBe(kind);
});

test("uses Telegram playback metadata when a filename omits its extension", () => {
  expect(documentIconKind({ name: "Recording", playbackMime: "audio/ogg" })).toBe("audio");
  expect(documentIconKind({ name: "Demo", playbackMime: "video/mp4" })).toBe("video");
});
