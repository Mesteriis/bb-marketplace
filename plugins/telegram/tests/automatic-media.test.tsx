// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useRef } from "react";
import { expect, test, vi } from "vitest";
import { defaultAutoMediaPolicy, defaultAutoPlaybackPolicy, disabledAutoPlayback, type AutoMediaLimits, type AutoPlaybackLimits } from "../src/core/contract.ts";
import { ChatAutomaticPlayback, chooseAutoplayVideoQuality, mayAutoplayMessage, playbackLimitsForChat } from "../src/ui/automatic-playback.tsx";
import { MessageContent, NotePlaybackReceipt } from "../src/ui/message-content.tsx";
import { AutomaticMediaSettings, ChatAutomaticMedia, useVisibleMediaPrefetch, visibleMediaCandidates } from "../src/ui/automatic-media.tsx";

const chat = { id: "42", name: "Fixture chat", initials: "F", color: "#246dbd", subtitle: "Direct message", messages: [] };
const policy = { ...defaultAutoMediaPolicy, private: { ...defaultAutoMediaPolicy.private, photo: 1 } };
const photo = { id: "101", author: "Fixture", time: "", text: "", hasPhoto: true };

test("enqueues only eligible photos after they enter a visible chat", async () => {
  const messages = [photo, { ...photo, id: "102" }, { ...photo, id: "103", photoSpoiler: true }];
  const prefetch = vi.fn(async () => true);
  let intersection!: IntersectionObserverCallback;
  const observed = new Set<Element>();
  class Observer {
    constructor(callback: IntersectionObserverCallback) { intersection = callback; }
    observe(row: Element) { observed.add(row); }
    disconnect() { observed.clear(); }
  }
  const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
  vi.stubGlobal("IntersectionObserver", Observer);
  function Conversation() {
    const list = useRef<HTMLOListElement>(null);
    useVisibleMediaPrefetch({ list, chatId: chat.id, enabled: true, policy,
      ids: visibleMediaCandidates(chat, messages, policy), prefetch });
    return <ol ref={list}>{messages.map(({ id }) => <li key={id} data-message-id={id}>{id}</li>)}</ol>;
  }
  try {
    expect(visibleMediaCandidates(chat, messages, defaultAutoMediaPolicy)).toBe("");
    expect(visibleMediaCandidates({ ...chat, subtitle: "Channel" }, messages, policy)).toBe("");
    render(<Conversation />);
    const visible = screen.getByText("101");
    expect([...observed]).toEqual([visible, screen.getByText("102")]);
    const rect = visible.getBoundingClientRect();
    await act(async () => intersection([{ target: visible, isIntersecting: true, intersectionRatio: 1,
      boundingClientRect: rect, intersectionRect: rect, rootBounds: null, time: 0 }],
      {} as IntersectionObserver));
    expect(prefetch).not.toHaveBeenCalled();
    visibility.mockReturnValue("visible");
    fireEvent(document, new Event("visibilitychange"));
    await waitFor(() => expect(prefetch).toHaveBeenCalledExactlyOnceWith("42", "101", undefined));
  } finally {
    visibility.mockRestore();
    vi.unstubAllGlobals();
  }
});

test("saves independent automatic download limits only when submitted", async () => {
  const saved = { ...policy, channel: { ...policy.channel, photo: 5 } };
  const save = vi.fn(async () => saved);
  render(<AutomaticMediaSettings policy={defaultAutoMediaPolicy} save={save} />);
  fireEvent.click(screen.getByText("Automatic media downloads"));
  const photoLimit = (name: string) => within(screen.getByRole("group", { name })).getByRole<HTMLInputElement>("spinbutton", { name: "Photos limit (MiB)" });
  fireEvent.change(photoLimit("Private chats"), { target: { value: "1" } });
  fireEvent.change(photoLimit("Channels"), { target: { value: "5" } });
  expect(photoLimit("Groups").value).toBe("0");
  expect(save).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Save automatic downloads" }));
  await screen.findByText("Automatic download settings saved.");
  expect(save).toHaveBeenCalledExactlyOnceWith(saved);
});

test("can disable downloads for a chat and return it to the chat-type policy", async () => {
  const disabled = defaultAutoMediaPolicy.private;
  const save = vi.fn(async (limits: AutoMediaLimits | null) => limits);
  const view = render(<ChatAutomaticMedia defaults={policy.private} save={save} />);
  const chatSettings = within(view.container);
  expect(visibleMediaCandidates(chat, [photo], policy, disabled)).toBe("");
  expect(visibleMediaCandidates(chat, [photo], defaultAutoMediaPolicy, policy.private)).toBe("101");
  fireEvent.click(chatSettings.getByText("Automatic media downloads"));
  fireEvent.change(chatSettings.getByRole("combobox", { name: "Download policy" }), { target: { value: "disabled" } });
  fireEvent.click(chatSettings.getByRole("button", { name: "Save chat download settings" }));
  await chatSettings.findByText("Chat automatic download settings saved.");
  expect(save).toHaveBeenLastCalledWith(disabled);
  view.rerender(<ChatAutomaticMedia value={disabled} defaults={policy.private} save={save} />);
  fireEvent.change(chatSettings.getByRole("combobox", { name: "Download policy" }), { target: { value: "inherit" } });
  fireEvent.click(chatSettings.getByRole("button", { name: "Save chat download settings" }));
  await waitFor(() => expect(save.mock.calls).toEqual([[disabled], [null]]));
});

test("selects the smallest fitting video quality within budget, with a lower-resolution fallback", () => {
  const variants = [
    { fileId: 11, width: 1280, height: 720, sizeBytes: 800 },
    { fileId: 12, width: 640, height: 360, sizeBytes: 350 },
    { fileId: 13, width: 320, height: 180, sizeBytes: 175 },
  ];
  const budget = { originalBytes: 1400, limitBytes: 1000 };
  expect(chooseAutoplayVideoQuality(variants, budget, { width: 520, height: 300 })).toBe(12);
  expect(chooseAutoplayVideoQuality(variants, budget, { width: 290, height: 170 })).toBe(13);
  expect(chooseAutoplayVideoQuality(variants, { ...budget, limitBytes: 700 }, { width: 1100, height: 620 })).toBe(12);
  expect(chooseAutoplayVideoQuality(variants, { ...budget, limitBytes: 100 }, { width: 520, height: 300 })).toBeUndefined();
  expect(chooseAutoplayVideoQuality(variants, { ...budget, originalBytes: 100 }, { width: 520, height: 300 })).toBeUndefined();
});

test("previews a visible video within the alternate stream budget and keeps the manual original available", async () => {
  const limits = { video: 1, gif: 0, videoNote: 0 };
  const message = { id: "110", author: "Fixture", time: "", text: "",
    document: { name: "Fixture", downloadable: true, playbackMime: "video/mp4" as const, sizeBytes: 2 * 1024 * 1024,
      videoQualities: [{ fileId: 12, width: 640, height: 360, sizeBytes: 512 * 1024 }] } };
  const stream = vi.fn(async (_id: string, _messageId: string, _attachment?: unknown, _motion?: number, fileId?: number) =>
    fileId ? "/fixture/alternate" : "/fixture/original");
  let intersect!: IntersectionObserverCallback;
  vi.stubGlobal("IntersectionObserver", class {
    constructor(callback: IntersectionObserverCallback) { intersect = callback; }
    observe() {}
    disconnect() {}
  });
  const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
  try {
    expect(mayAutoplayMessage(message, limits)).toBe(false);
    expect(mayAutoplayMessage(message, { ...limits, video: 0 }, true)).toBe(false);
    expect(mayAutoplayMessage({ ...message, videoSpoiler: true }, limits, true)).toBe(false);
    const view = render(<MessageContent chatId="42" message={message} autoplayLimits={limits}
      loadVideoStream={stream} loadMedia={async () => new Blob([])} />);
    const tile = view.container.querySelector(".mtg-media-player")!;
    const rect = tile.getBoundingClientRect();
    expect(stream).not.toHaveBeenCalled();
    await act(async () => intersect([{ target: tile, isIntersecting: true, intersectionRatio: 0.8,
      boundingClientRect: rect, intersectionRect: rect, rootBounds: null, time: 0 }], {} as IntersectionObserver));
    const video = await within(view.container).findByLabelText<HTMLVideoElement>("Telegram video");
    expect(video.muted).toBe(true);
    expect(video.getAttribute("src")).toBe("/fixture/alternate");
    expect(stream).toHaveBeenCalledExactlyOnceWith("42", "110", undefined, undefined, 12);
    fireEvent.click(within(view.container).getByRole("button", { name: "Close player" }));
    fireEvent.click(within(view.container).getByRole("button", { name: "Load video player" }));
    const manual = await within(view.container).findByLabelText<HTMLVideoElement>("Telegram video");
    expect(manual.getAttribute("src")).toBe("/fixture/original");
    expect(stream).toHaveBeenLastCalledWith("42", "110");
  } finally {
    play.mockRestore();
    visibility.mockRestore();
    vi.unstubAllGlobals();
  }
});

test("video notes preview muted only while visible and register playback only after taking control", async () => {
  const note = { id: "110", author: "Fixture", time: "", text: "", videoNote: true as const, notePlayed: false,
    document: { name: "Fixture", downloadable: true, playbackMime: "video/mp4" as const, sizeBytes: 512 * 1024 } };
  const limits = { video: 0, gif: 0, videoNote: 1 };
  const stream = vi.fn(async () => "/fixture/video");
  const mark = vi.fn(async () => true);
  let intersect!: IntersectionObserverCallback;
  vi.stubGlobal("IntersectionObserver", class {
    constructor(callback: IntersectionObserverCallback) { intersect = callback; }
    observe() {}
    disconnect() {}
  });
  let paused = true;
  const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(async () => { paused = false; });
  const pause = vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => { paused = true; });
  const pausedProperty = vi.spyOn(HTMLMediaElement.prototype, "paused", "get").mockImplementation(() => paused);
  const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
  try {
    expect(mayAutoplayMessage({ ...note, videoSpoiler: true }, limits)).toBe(false);
    expect(mayAutoplayMessage({ ...note, oneView: "video" }, limits)).toBe(false);
    expect(mayAutoplayMessage({ ...note, document: { ...note.document, sizeBytes: 2 * 1024 * 1024 } }, limits)).toBe(false);
    expect(mayAutoplayMessage({ ...note, videoNote: undefined, animation: true }, { video: 0, gif: 1, videoNote: 0 })).toBe(true);
    const view = render(<NotePlaybackReceipt.Provider value={mark}><MessageContent chatId="42" message={note} autoplayLimits={limits}
      loadVideoStream={stream} loadMedia={async () => new Blob(["fixture"])} /></NotePlaybackReceipt.Provider>);
    const tile = view.container.querySelector(".mtg-media-player")!;
    const rect = tile.getBoundingClientRect();
    const show = (visible: boolean) => act(() => intersect([{ target: tile, isIntersecting: visible, intersectionRatio: visible ? 0.8 : 0,
      boundingClientRect: rect, intersectionRect: rect, rootBounds: null, time: 0 }], {} as IntersectionObserver));
    show(true);
    expect(stream).not.toHaveBeenCalled();
    visibility.mockReturnValue("visible");
    fireEvent(document, new Event("visibilitychange"));
    const player = await within(view.container).findByLabelText<HTMLVideoElement>("Telegram video note");
    expect(player.muted).toBe(true);
    await waitFor(() => expect(play).toHaveBeenCalledOnce());
    fireEvent.playing(player);
    expect(mark).not.toHaveBeenCalled();
    show(false);
    expect(pause).toHaveBeenCalledOnce();
    show(true);
    expect(play).toHaveBeenCalledTimes(2);
    fireEvent.click(within(view.container).getByRole("button", { name: "Play with sound" }));
    expect(player.muted).toBe(false);
    fireEvent.playing(player);
    await waitFor(() => expect(mark).toHaveBeenCalledExactlyOnceWith("42", "110"));
    show(false);
    expect(pause).toHaveBeenCalledTimes(2);
  } finally {
    play.mockRestore();
    pause.mockRestore();
    pausedProperty.mockRestore();
    visibility.mockRestore();
    vi.unstubAllGlobals();
  }
});

test("overrides playback limits for a chat and then returns to the default", async () => {
  const defaults = { video: 2, gif: 0, videoNote: 1 };
  const global = { ...defaultAutoPlaybackPolicy, private: defaults };
  expect(playbackLimitsForChat(chat, global, disabledAutoPlayback)).toEqual(disabledAutoPlayback);
  expect(playbackLimitsForChat(chat, global)).toEqual(defaults);
  const save = vi.fn(async (limits: AutoPlaybackLimits | null) => limits);
  const view = render(<ChatAutomaticPlayback defaults={defaults} value={disabledAutoPlayback} save={save} />);
  const settings = within(view.container);
  fireEvent.click(settings.getByText("Automatic playback"));
  const mode = settings.getByRole<HTMLSelectElement>("combobox", { name: "Playback policy" });
  expect(mode.value).toBe("disabled");
  fireEvent.change(mode, { target: { value: "custom" } });
  fireEvent.change(settings.getByRole("spinbutton", { name: "GIFs limit (MiB)" }), { target: { value: "3" } });
  fireEvent.click(settings.getByRole("button", { name: "Save chat playback settings" }));
  await settings.findByText("Chat automatic playback settings saved.");
  const custom = { ...defaults, gif: 3 };
  expect(playbackLimitsForChat(chat, global, custom)).toEqual(custom);
  view.rerender(<ChatAutomaticPlayback defaults={defaults} value={custom} save={save} />);
  fireEvent.change(mode, { target: { value: "inherit" } });
  fireEvent.click(settings.getByRole("button", { name: "Save chat playback settings" }));
  await waitFor(() => expect(save.mock.calls).toEqual([[custom], [null]]));
});
