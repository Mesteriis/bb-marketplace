// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { audioPeaks, canDecodeAudioWaveform } from "../src/ui/audio-waveform.ts";
import { ConversationSearch } from "../src/ui/conversation-search.tsx";
import { PlaybackHistoryProvider } from "../src/ui/media-player.tsx";
import { MusicPlaybackProvider, MusicPlayerPanel } from "../src/ui/music-playback.tsx";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

test("the waveform reflects both channels and bounds decoding to short files", () => {
  const channels = [Float32Array.of(0, .25, 0, .5), Float32Array.of(0, .5, 0, .25)];
  const buffer = { numberOfChannels: 2, length: 4, getChannelData: (channel: number) => channels[channel] } as AudioBuffer;
  expect(audioPeaks(buffer, 2)).toEqual([.5, .5]);
  expect(canDecodeAudioWaveform(200_000, 60)).toBe(true);
  expect(canDecodeAudioWaveform(200_000, 301)).toBe(false);
  expect(canDecodeAudioWaveform(10_000_000, 60)).toBe(false);
  expect(canDecodeAudioWaveform(200_000)).toBe(false);
});

test("shared audio opens a modal and keeps the same player and position on close and reopen", async () => {
  Object.defineProperties(HTMLDialogElement.prototype, {
    showModal: { configurable: true, value(this: HTMLDialogElement) { this.open = true; } },
    close: { configurable: true, value(this: HTMLDialogElement) { this.open = false; } },
  });
  const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(function (this: HTMLMediaElement) { fireEvent.pause(this); });
  const save = vi.fn(async () => true);
  const stream = vi.fn(async () => "/fixture.mp3");
  const message = {
    id: "42", time: "", text: "", author: "Fixture",
    document: { name: "fixture.mp3", downloadable: true, playbackMime: "audio/mpeg" as const, durationSeconds: 60 },
  };
  const { container } = render(<PlaybackHistoryProvider><MusicPlaybackProvider>
    <MusicPlayerPanel />
    <ConversationSearch chatId="41" initialFilter="audio" sharedLibrary={{ audio: 1 }}
      search={async () => ({ before: null, messages: [message] })}
      loadMedia={async () => new Blob()} loadVideoStream={stream} saveDocument={save} close={() => {}} />
  </MusicPlaybackProvider></PlaybackHistoryProvider>);
  const row = await screen.findByRole("button", { name: "Play fixture.mp3" });
  row.focus();
  fireEvent.click(row);
  const dialog = within(await screen.findByRole("dialog", { name: "fixture.mp3" }));
  await waitFor(() => expect(container.querySelector("audio")).toBeTruthy());
  const audio = container.querySelector<HTMLAudioElement>('audio[aria-label="Telegram audio"]')!;
  await waitFor(() => expect(play.mock.instances).toContain(audio));
  audio.currentTime = 20;
  await act(async () => { fireEvent.click(dialog.getByRole("button", { name: "Download" })); });
  expect(save).toHaveBeenCalledExactlyOnceWith("41", "42");
  fireEvent.click(dialog.getByRole("button", { name: "Close player" }));
  await waitFor(() => expect(document.activeElement).toBe(row));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(container.querySelector("audio")).toBe(audio);
  expect(audio.controls).toBe(false);
  const mini = within(screen.getByRole("region", { name: "Telegram music player" }));
  expect(mini.queryByText("Queue")).toBeNull();
  fireEvent.click(mini.getByRole("button", { name: "Open audio player" }));
  expect(screen.getByRole("dialog")).toBeTruthy();
  expect(screen.getByRole("slider", { name: "Audio position" })).toBeTruthy();
  expect(audio.currentTime).toBe(20);
  expect(stream).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "Track details" }));
  expect(screen.getByText("Queue", { selector: "summary" })).toBeTruthy();
});
