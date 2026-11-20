import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { expect, test, vi } from "vitest";
import { registerDocumentDownloads } from "../src/adapters/bb/document-downloads.ts";
import { registerStoryMedia } from "../src/adapters/bb/story-media.ts";

type StorySession = NonNullable<ReturnType<Parameters<typeof registerStoryMedia>[1]>>;

test("revokes a story media ticket and its active transfer when switching accounts", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "makosh-telegram" });
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array<ArrayBuffer>>({
    start(controller) { controller.enqueue(new Uint8Array([7, 8, 9])); },
    cancel,
  });
  let downloadSignal: AbortSignal | undefined;
  const session = {
    status: () => ({ state: "ready" as const }),
    storyMediaReference: vi.fn(async () => ({
      kind: "video" as const, fileId: 12, caption: "", reaction: undefined, canDelete: false, canReply: false,
      canEditCaption: false, editableAudience: undefined, counts: undefined, canGetInteractions: false, canCopyLink: false,
      profileVisibility: undefined, reference: { story_poster_chat_id: 42, story_id: 8 },
    })),
    storyMedia: vi.fn(async (_id: string, _story: number, signal: AbortSignal) => {
      downloadSignal = signal;
      return { mime: "video/mp4", size: 6, body };
    }),
  };
  try {
    let current: StorySession | undefined = session;
    const media = registerStoryMedia(bb, () => current);
    const { url } = await media.issue(session, "42", 8);
    const route = url.replace("/api/v1/plugins/makosh-telegram/http", "");
    const response = await harness.behavior.fetchHttp("GET", route);
    const reader = response.body!.getReader();
    await expect(reader.read()).resolves.toEqual({ done: false, value: new Uint8Array([7, 8, 9]) });
    const rest = expect(reader.read()).rejects.toMatchObject({ name: "AbortError" });
    media.clear();
    current = undefined;
    await rest;
    expect(downloadSignal?.aborted).toBe(true);
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
    expect((await harness.behavior.fetchHttp("GET", route)).status).toBe(404);
  } finally { await harness.lifecycle.dispose(); }
});


test("seeks a story video with a byte range and refuses an edited replacement", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "makosh-telegram" });
  let fileId = 12;
  const session = {
    status: () => ({ state: "ready" as const }),
    storyMediaReference: vi.fn(async () => ({
      kind: "video" as const, fileId, videoSize: 1024, caption: "", reaction: undefined, canDelete: false, canReply: false,
      canEditCaption: false, editableAudience: undefined, counts: undefined, canGetInteractions: false, canCopyLink: false,
      profileVisibility: undefined, reference: { story_poster_chat_id: 42, story_id: 8 },
    })),
    storyVideoReference: vi.fn(async () => ({ id: fileId, size: 1024, mime: "video/mp4" as const })),
    storyMedia: vi.fn(),
    document: vi.fn(), documentName: vi.fn(), openOneView: vi.fn(),
    videoPart: vi.fn(async (_id: number, _offset: number, count: number) => new Uint8Array(count)),
  };
  try {
    const downloads = registerDocumentDownloads(bb, () => session);
    const media = registerStoryMedia(bb, () => session, Date.now,
      (current, id, story, expected) => downloads.issueStoryVideo(current, id, story, expected));
    const { url } = await media.issue(session, "42", 8);
    expect(url).toContain("/video-stream?");
    const route = url.replace("/api/v1/plugins/makosh-telegram/http", "");
    const response = await harness.behavior.fetchHttp("GET", route, { headers: { range: "bytes=800-863" } });
    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe("bytes 800-863/1024");
    expect((await response.arrayBuffer()).byteLength).toBe(64);
    expect(session.videoPart).toHaveBeenCalledExactlyOnceWith(12, 800, 64, expect.any(AbortSignal));
    fileId = 13;
    const replacement = await harness.behavior.fetchHttp("GET", route, { headers: { range: "bytes=864-895" } });
    expect(replacement.status).toBe(409);
    expect(session.videoPart).toHaveBeenCalledTimes(1);
    expect(session.storyMedia).not.toHaveBeenCalled();
  } finally { await harness.lifecycle.dispose(); }
});
