import { mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { expect, test, vi } from "vitest";
import { maxDocumentBytes } from "../src/core/contract.ts";
import { streamTelegramFile } from "../src/adapters/bb/telegram-file.ts";
import { registerDocumentDownloads } from "../src/adapters/bb/document-downloads.ts";

test("waits for cache cleanup before automatic transfers and defers cleanup during a transfer", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "makosh-telegram" });
  const downloads = registerDocumentDownloads(bb, () => undefined);
  let finishCleanup!: (value: number) => void;
  let finishTransfer!: (value: boolean) => void;
  const cleanup = new Promise<number>((resolve) => { finishCleanup = resolve; });
  const transfer = new Promise<boolean>((resolve) => { finishTransfer = resolve; });
  const work = vi.fn(() => transfer);
  try {
    const cleaning = downloads.cleanCache(() => cleanup);
    const fetching = downloads.withCacheTransfer(work);
    await Promise.resolve();
    expect(work).not.toHaveBeenCalled();
    finishCleanup(7);
    await expect(cleaning).resolves.toBe(7);
    await vi.waitFor(() => expect(work).toHaveBeenCalledExactlyOnceWith(expect.any(AbortSignal)));
    const nextCleanup = vi.fn(async () => 2);
    await expect(downloads.cleanCache(nextCleanup)).resolves.toBeUndefined();
    expect(nextCleanup).not.toHaveBeenCalled();
    finishTransfer(true);
    await expect(fetching).resolves.toBe(true);
    await expect(downloads.cleanCache(nextCleanup)).resolves.toBe(2);
  } finally {
    finishCleanup(0);
    finishTransfer(false);
    await harness.lifecycle.dispose();
  }
});

test("cancels a cache-backed transfer before cleanup finishes without starting the transfer", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "makosh-telegram" });
  const downloads = registerDocumentDownloads(bb, () => undefined);
  const controller = new AbortController();
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => { finish = resolve; });
  const requested = vi.fn(async () => 1);
  try {
    const cleaning = downloads.cleanCache(() => gate);
    const waiting = downloads.withCacheTransfer(requested, controller.signal);
    controller.abort();
    await expect(waiting).resolves.toBeUndefined();
    expect(requested).not.toHaveBeenCalled();
    finish();
    await cleaning;
    await expect(downloads.cleanCache(async () => 2)).resolves.toBe(2);
  } finally {
    finish();
    await harness.lifecycle.dispose();
  }
});

test("serves a document above the JSON limit through a private, single-use ticket", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "makosh-telegram" });
  const data = Buffer.alloc(1024 * 1024, 7);
  const session = {
    status: () => ({ state: "ready" as const }),
    openOneView: vi.fn(async () => ({ bytes: data, mime: "image/jpeg" as const })),
    documentName: vi.fn(async () => "Документ.txt"),
    document: vi.fn(async () => ({ name: "Документ.txt", size: data.length, body: new Response(new Uint8Array(data)).body })),
  };
  let now = 0;
  let current: typeof session | undefined = session;
  try {
    const downloads = registerDocumentDownloads(bb, () => current, () => now);
    expect(harness.inspection.registrations.httpRoutes).toMatchObject([
      { path: "/video-stream", auth: "local" }, { path: "/document-download", auth: "local" },
    ]);
    const request = async (url: string) => harness.behavior.fetchHttp("GET", url.replace("/api/v1/plugins/makosh-telegram/http", ""));
    const { url } = await downloads.issue(session, "42", "12");
    expect(session.document).not.toHaveBeenCalled();
    const response = await request(url);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-disposition")).toContain("filename*=UTF-8''%D0%94");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(data);
    expect(session.document).toHaveBeenCalledExactlyOnceWith("42", "12", expect.any(AbortSignal));
    expect((await request(url)).status).toBe(404);

    const expired = await downloads.issue(session, "42", "12");
    now += 60_000;
    expect((await request(expired.url)).status).toBe(404);
    const disconnected = await downloads.issue(session, "42", "12");
    current = undefined;
    expect((await request(disconnected.url)).status).toBe(404);
    expect(session.document).toHaveBeenCalledOnce();
    current = session;
    const playback = await downloads.issue(session, "42", "12", true);
    expect(session.documentName).toHaveBeenLastCalledWith("42", "12", true);
    const media = await request(playback.url);
    await media.arrayBuffer();
    expect(session.document).toHaveBeenLastCalledWith("42", "12", expect.any(AbortSignal), true);
    expect((await request(playback.url)).status).toBe(404);

    const once = await downloads.issue(session, "42", "15", false, true);
    expect(session.openOneView).not.toHaveBeenCalled();
    const view = await request(once.url);
    expect(view.headers.get("content-type")).toBe("image/jpeg");
    expect(view.headers.get("cache-control")).toBe("no-store");
    expect(Buffer.from(await view.arrayBuffer())).toEqual(data);
    expect(session.openOneView).toHaveBeenCalledExactlyOnceWith("42", "15", expect.any(AbortSignal));
    expect((await request(once.url)).status).toBe(404);
  } finally { await harness.lifecycle.dispose(); }
});

test("streams an article attachment through a single-use download ticket", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "makosh-telegram" });
  const session = {
    status: () => ({ state: "ready" as const }),
    document: vi.fn(), documentName: vi.fn(), openOneView: vi.fn(),
    instantViewDocumentName: vi.fn(async () => "Article.txt"),
    instantViewDocument: vi.fn(async () => ({ name: "Article.txt", size: 7, body: new Response("fixture").body })),
  };
  try {
    const downloads = registerDocumentDownloads(bb, () => session);
    const article = "https://example.com/article";
    const { name, url } = await downloads.issueArticleDocument(session, article, 51);
    expect(name).toBe("Article.txt");
    expect(session.instantViewDocumentName).toHaveBeenCalledExactlyOnceWith(article, 51);
    expect(session.instantViewDocument).not.toHaveBeenCalled();
    const path = url.replace("/api/v1/plugins/makosh-telegram/http", "");
    const response = await harness.behavior.fetchHttp("GET", path);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/octet-stream");
    expect(await response.text()).toBe("fixture");
    expect(session.instantViewDocument).toHaveBeenCalledExactlyOnceWith(article, 51, expect.any(AbortSignal));
    expect((await harness.behavior.fetchHttp("GET", path)).status).toBe(404);
  } finally { await harness.lifecycle.dispose(); }
});

test("streams a quick reply document through a single-use download ticket", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "makosh-telegram" });
  const session = {
    status: () => ({ state: "ready" as const }),
    document: vi.fn(), documentName: vi.fn(), openOneView: vi.fn(),
    quickReplyDocumentName: vi.fn(async () => "Shortcut.txt"),
    quickReplyDocument: vi.fn(async () => ({ name: "Shortcut.txt", size: 7, body: new Response("fixture").body })),
  };
  try {
    const downloads = registerDocumentDownloads(bb, () => session);
    const { name, url } = await downloads.issueQuickReplyDocument(session, 4, 92, 84);
    expect(name).toBe("Shortcut.txt");
    expect(session.quickReplyDocumentName).toHaveBeenCalledExactlyOnceWith(4, 92, 84);
    expect(session.quickReplyDocument).not.toHaveBeenCalled();
    const path = url.replace("/api/v1/plugins/makosh-telegram/http", "");
    const response = await harness.behavior.fetchHttp("GET", path);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("fixture");
    expect(session.quickReplyDocument).toHaveBeenCalledExactlyOnceWith(4, 92, 84, expect.any(AbortSignal));
    expect((await harness.behavior.fetchHttp("GET", path)).status).toBe(404);
  } finally { await harness.lifecycle.dispose(); }
});

test("issues a single-use download ticket for the reviewed welcome document", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "makosh-telegram" });
  const reference = ["-1000000000010", 7, "a".repeat(64)] as const;
  const session = {
    status: () => ({ state: "ready" as const }), document: vi.fn(), documentName: vi.fn(), openOneView: vi.fn(),
    chatWelcomeDocumentName: vi.fn(async () => "Welcome.txt"),
    chatWelcomeDocument: vi.fn(async () => ({ name: "Welcome.txt", size: 7, body: new Response("fixture").body })),
  };
  try {
    const downloads = registerDocumentDownloads(bb, () => session);
    const { name, url } = await downloads.issueWelcomeDocument(session, ...reference);
    expect(name).toBe("Welcome.txt");
    expect(session.chatWelcomeDocumentName).toHaveBeenCalledExactlyOnceWith(...reference);
    expect(session.chatWelcomeDocument).not.toHaveBeenCalled();
    const path = url.replace("/api/v1/plugins/makosh-telegram/http", "");
    const response = await harness.behavior.fetchHttp("GET", path);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toContain("Welcome.txt");
    expect(await response.text()).toBe("fixture");
    expect(session.chatWelcomeDocument).toHaveBeenCalledExactlyOnceWith(...reference, expect.any(AbortSignal));
    expect((await harness.behavior.fetchHttp("GET", path)).status).toBe(404);
  } finally { await harness.lifecycle.dispose(); }
});

test("opens a sparse 4 GiB document and serves the first chunk without reading the entire file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "makosh-large-file-"));
  try {
    const path = join(directory, "fixture");
    await writeFile(path, "start");
    await truncate(path, maxDocumentBytes);
    const { body, size } = await streamTelegramFile(directory, path, maxDocumentBytes);
    expect(size).toBe(4_294_967_296);
    const reader = body!.getReader();
    try {
      const first = await reader.read();
      expect(first.done).toBe(false);
      expect(first.value?.byteLength).toBeLessThanOrEqual(64 * 1024);
      expect(Buffer.from(first.value!.subarray(0, 5)).toString()).toBe("start");
    } finally { await reader.cancel(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("video streaming uses bounded byte ranges and a reusable private ticket", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "makosh-telegram" });
  const size = 1024 * 1024;
  const session = {
    status: () => ({ state: "ready" as const }),
    documentName: vi.fn(),
    document: vi.fn(),
    openOneView: vi.fn(),
    videoReference: vi.fn(async () => ({ id: 77, size, mime: "video/mp4" as const })),
    instantViewPlaybackReference: vi.fn(async () => ({ id: 78, size, mime: "audio/ogg" as const })),
    videoPart: vi.fn(async (_id: number, offset: number, count: number) => new Uint8Array(count).fill(offset % 251)),
  };
  try {
    const downloads = registerDocumentDownloads(bb, () => session);
    const attachment = { index: 1, fileId: 77 };
    const url = (await downloads.issueVideo(session, "42", "15", attachment)).replace("/api/v1/plugins/makosh-telegram/http", "");
    const response = await harness.behavior.fetchHttp("GET", url, { headers: { range: "bytes=0-524287" } });
    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe(`bytes 0-524287/${size}`);
    expect((await response.arrayBuffer()).byteLength).toBe(524_288);
    expect(session.videoPart.mock.calls.map(([, offset, count]) => [offset, count])).toEqual([[0, 262_144], [262_144, 262_144]]);
    const seek = await harness.behavior.fetchHttp("GET", url, { headers: { range: "bytes=-64" } });
    expect(seek.status).toBe(206);
    expect(session.videoReference).toHaveBeenLastCalledWith("42", "15", attachment);
    expect((await seek.arrayBuffer()).byteLength).toBe(64);
    expect(session.videoPart).toHaveBeenLastCalledWith(77, size - 64, 64, expect.any(AbortSignal));
    expect((await harness.behavior.fetchHttp("GET", url, { headers: { range: "bytes=1048576-" } })).status).toBe(416);
    const article = "https://example.com/article";
    const articleUrl = (await downloads.issueArticlePlayback(session, article, 78)).replace("/api/v1/plugins/makosh-telegram/http", "");
    const articleSeek = await harness.behavior.fetchHttp("GET", articleUrl, { headers: { range: "bytes=7-22" } });
    expect(articleSeek.status).toBe(206);
    expect(articleSeek.headers.get("content-type")).toBe("audio/ogg");
    expect((await articleSeek.arrayBuffer()).byteLength).toBe(16);
    expect(session.instantViewPlaybackReference.mock.calls).toEqual([[article, 78, true], [article, 78]]);
    expect(session.videoPart).toHaveBeenLastCalledWith(78, 7, 16, expect.any(AbortSignal));
    downloads.clear();
    expect((await harness.behavior.fetchHttp("GET", url)).status).toBe(404);
  } finally { await harness.lifecycle.dispose(); }
});

test.each([undefined, { index: 3, fileId: 51 }])("rechecks the selected welcome message before serving another playback range (%j)", async (attachment) => {
  const { bb, harness } = createFakePluginHost({ pluginId: "makosh-telegram" });
  const id = "-1000000000010";
  const revision = "c".repeat(64);
  let readable = true;
  const session = {
    status: () => ({ state: "ready" as const }), documentName: vi.fn(), document: vi.fn(), openOneView: vi.fn(),
    chatWelcomePlaybackReference: vi.fn(async (_id: string, _messageId: number, _revision: string) => {
      if (!readable) throw new Error("Welcome playback unavailable.");
      return { id: 51, size: 1024, mime: "video/mp4" as const };
    }),
    videoPart: vi.fn(async (_id: number, _offset: number, count: number) => new Uint8Array(count).fill(7)),
  };
  try {
    const downloads = registerDocumentDownloads(bb, () => session);
    const url = (await downloads.issueWelcomePlayback(session, id, 1, revision, attachment)).replace("/api/v1/plugins/makosh-telegram/http", "");
    const result = await harness.behavior.fetchHttp("GET", url, { headers: { range: "bytes=8-39" } });
    expect(result.status).toBe(206);
    expect(result.headers.get("content-type")).toBe("video/mp4");
    expect(new Uint8Array(await result.arrayBuffer())).toEqual(new Uint8Array(32).fill(7));
    readable = false;
    expect((await harness.behavior.fetchHttp("GET", url, { headers: { range: "bytes=40-63" } })).status).toBe(409);
    const reference = attachment ? [id, 1, revision, attachment] : [id, 1, revision];
    expect(session.chatWelcomePlaybackReference.mock.calls).toEqual(Array.from({ length: 3 }, () => reference));
    expect(session.videoPart).toHaveBeenCalledOnce();
  } finally { await harness.lifecycle.dispose(); }
});

test("binds a regular video stream to the file shown in history", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "makosh-telegram" });
  let fileId = 77;
  const session = {
    status: () => ({ state: "ready" as const }),
    documentName: vi.fn(),
    document: vi.fn(),
    openOneView: vi.fn(),
    videoReference: vi.fn(async () => ({ id: fileId, size: 1024, mime: "video/mp4" as const })),
    videoPart: vi.fn(async (_id: number, _offset: number, count: number) => new Uint8Array(count)),
  };
  try {
    const downloads = registerDocumentDownloads(bb, () => session);
    const issue = (id: number) => downloads.issueVideo(session, "42", "15", undefined, undefined, id);
    const path = (url: string) => url.replace("/api/v1/plugins/makosh-telegram/http", "");
    const fetchRange = (url: string) => harness.behavior.fetchHttp("GET", url, { headers: { range: "bytes=0-63" } });
    const original = path(await issue(77));
    fileId = 78;
    await expect(issue(77)).rejects.toThrow("Media changed");
    expect((await fetchRange(original)).status).toBe(409);
    expect(session.videoPart).not.toHaveBeenCalled();
    const replacement = await fetchRange(path(await issue(78)));
    expect(replacement.status).toBe(206);
    expect((await replacement.arrayBuffer()).byteLength).toBe(64);
    expect(session.videoPart).toHaveBeenCalledExactlyOnceWith(78, 0, 64, expect.any(AbortSignal));
  } finally { await harness.lifecycle.dispose(); }
});

test("serves a new seek without returning bytes from an in-flight range after its ticket is cleared", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "makosh-telegram" });
  let finish!: (bytes: Uint8Array<ArrayBuffer>) => void;
  const pending = new Promise<Uint8Array<ArrayBuffer>>((resolve) => { finish = resolve; });
  let originalSignal: AbortSignal | undefined;
  const session = {
    status: () => ({ state: "ready" as const }),
    documentName: vi.fn(),
    document: vi.fn(),
    openOneView: vi.fn(),
    videoReference: vi.fn(async () => ({ id: 77, size: 1024, mime: "video/mp4" as const })),
    videoPart: vi.fn(async (_id: number, offset: number, count: number, signal: AbortSignal) => {
      if (offset !== 0) return new Uint8Array(count).fill(7);
      originalSignal = signal;
      return pending;
    }),
  };
  try {
    const downloads = registerDocumentDownloads(bb, () => session);
    const url = (await downloads.issueVideo(session, "42", "15")).replace("/api/v1/plugins/makosh-telegram/http", "");
    const original = await harness.behavior.fetchHttp("GET", url, { headers: { range: "bytes=0-63" } });
    const reader = original.body!.getReader();
    const result = expect(reader.read()).rejects.toThrow("Video stream ended.");
    await vi.waitFor(() => expect(session.videoPart).toHaveBeenCalledOnce());

    const seek = await harness.behavior.fetchHttp("GET", url, { headers: { range: "bytes=800-863" } });
    expect(seek.headers.get("content-range")).toBe("bytes 800-863/1024");
    expect(new Uint8Array(await seek.arrayBuffer())).toEqual(new Uint8Array(64).fill(7));

    expect(originalSignal?.aborted).toBe(false);
    downloads.clear();
    expect(originalSignal?.aborted).toBe(true);
    finish(new Uint8Array(64));
    await result;
    expect((await harness.behavior.fetchHttp("GET", url)).status).toBe(404);
  } finally { await harness.lifecycle.dispose(); }
});

test("rejects a seek with an old ticket after the video in the message is replaced", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "makosh-telegram" });
  let fileId = 77;
  const session = {
    status: () => ({ state: "ready" as const }),
    documentName: vi.fn(), document: vi.fn(), openOneView: vi.fn(),
    videoReference: vi.fn(async () => ({ id: fileId, size: 1024, mime: "video/mp4" as const })),
    videoPart: vi.fn(),
  };
  try {
    const downloads = registerDocumentDownloads(bb, () => session);
    const url = (await downloads.issueVideo(session, "42", "15")).replace("/api/v1/plugins/makosh-telegram/http", "");
    fileId = 78;
    const seek = await harness.behavior.fetchHttp("GET", url, { headers: { range: "bytes=800-863" } });
    expect(seek.status).toBe(409);
    expect(session.videoPart).not.toHaveBeenCalled();
    expect((await harness.behavior.fetchHttp("GET", url)).status).toBe(404);
  } finally { await harness.lifecycle.dispose(); }
});

test("retains a busy download ticket and cancels a document body on session close", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "makosh-telegram" });
  let finishPreparation!: () => void;
  const preparing = new Promise<void>((resolve) => { finishPreparation = resolve; });
  let block = true;
  const cancel = vi.fn();
  const session = {
    status: () => ({ state: "ready" as const }),
    documentName: vi.fn(async () => "fixture.bin"),
    openOneView: vi.fn(),
    document: vi.fn(async () => {
      if (block) {
        await preparing;
        return { name: "fixture.bin", size: 0, body: null };
      }
      return { name: "fixture.bin", size: 2, body: new ReadableStream<Uint8Array<ArrayBuffer>>({
        start(controller) { controller.enqueue(new Uint8Array([1])); },
        cancel,
      }) };
    }),
  };
  const downloads = registerDocumentDownloads(bb, () => session);
  const request = async (id: string) => (await downloads.issue(session, "42", id)).url
    .replace("/api/v1/plugins/makosh-telegram/http", "");
  try {
    const first = harness.behavior.fetchHttp("GET", await request("10"));
    const second = harness.behavior.fetchHttp("GET", await request("11"));
    await vi.waitFor(() => expect(session.document).toHaveBeenCalledTimes(2));
    const third = await request("12");
    const blocked = await harness.behavior.fetchHttp("GET", third);
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).toBe("1");
    finishPreparation();
    await Promise.all([first, second]);

    block = false;
    const accepted = await harness.behavior.fetchHttp("GET", third);
    expect(accepted.status).toBe(200);
    const reader = accepted.body!.getReader();
    await expect(reader.read()).resolves.toEqual({ done: false, value: new Uint8Array([1]) });
    const remaining = expect(reader.read()).rejects.toMatchObject({ name: "AbortError" });
    downloads.clear();
    await remaining;
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
    expect((await harness.behavior.fetchHttp("GET", third)).status).toBe(404);
  } finally {
    finishPreparation();
    downloads.clear();
    await harness.lifecycle.dispose();
  }
});
