// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { parseLocalTranscript } from "../src/adapters/bb/local-transcription.ts";
import { ConversationSearch } from "../src/ui/conversation-search.tsx";
import { PlaybackHistoryProvider } from "../src/ui/media-player.tsx";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

test("keeps valid chronological recognizer segments and preserves plain text", () => {
  expect(parseLocalTranscript({ text: " One Two ", segments: [
    { start: 0, text: " One " }, { start: -1, text: "ignore" }, { start: 3.5, text: " Two " },
    { start: 2, text: "out of order" }, { start: 5, text: "" },
  ] })).toEqual({ text: "One Two", segments: [{ start: 0, text: "One" }, { start: 3.5, text: "Two" }] });
});

test("opens the reader on request, transcribes only after a click, and leaves playback mounted when closed", async () => {
  const note = {
    id: "42", time: "12:00", timestamp: 1795176000, text: "", author: "Synthetic sender", voiceNote: true as const,
    document: { name: "synthetic.ogg", downloadable: true, playbackMime: "audio/ogg" as const, durationSeconds: 45, waveform: [1, 10, 15] },
  };
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:fixture");
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
  const loadMedia = vi.fn(async () => new Blob());
  const transcribeVoice = vi.fn(async () => ({ text: "Hello. Goodbye.", segments: [{ start: 0, text: "Hello." }, { start: 12, text: "Goodbye." }] }));
  const search = vi.fn(async () => ({ before: null, messages: [note] }));
  render(<PlaybackHistoryProvider><ConversationSearch chatId="41" initialFilter="voiceVideoNotes"
    sharedLibrary={{ voiceVideoNotes: 1 }} search={search} loadMedia={loadMedia} transcribeVoice={transcribeVoice} close={() => {}} />
  </PlaybackHistoryProvider>);
  const inspect = await screen.findByRole("button", { name: "Open note details for Synthetic sender" });
  expect(screen.queryByText("synthetic.ogg")).toBeNull();
  fireEvent.click(inspect);
  const reader = within(screen.getByRole("complementary", { name: "Note details" }));
  expect(transcribeVoice).not.toHaveBeenCalled();
  fireEvent.click(reader.getByRole("button", { name: "Transcribe locally" }));
  expect(await reader.findByText("Goodbye.")).toBeTruthy();
  expect(transcribeVoice).toHaveBeenCalledExactlyOnceWith("41", "42", expect.any(AbortSignal), true);
  fireEvent.click(reader.getByRole("button", { name: "Jump to 0:12" }));
  const player = await screen.findByLabelText<HTMLAudioElement>("Telegram audio");
  expect(loadMedia).toHaveBeenCalledTimes(1);
  fireEvent.click(reader.getByRole("button", { name: "Close note details" }));
  expect(screen.queryByRole("complementary", { name: "Note details" })).toBeNull();
  expect(screen.getByLabelText("Telegram audio")).toBe(player);
  expect(document.activeElement).toBe(inspect);
});
