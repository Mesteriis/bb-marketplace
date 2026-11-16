import { mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { expect, test, vi } from "vitest";
import { maxDocumentBytes } from "../src/core/contract.ts";
import { streamTelegramFile } from "../src/adapters/bb/telegram-file.ts";
import { registerDocumentDownloads } from "../src/adapters/bb/document-downloads.ts";

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
    videoPart: vi.fn(async (_id: number, offset: number, count: number) => new Uint8Array(count).fill(offset % 251)),
  };
  try {
    const downloads = registerDocumentDownloads(bb, () => session);
    const url = (await downloads.issueVideo(session, "42", "15")).replace("/api/v1/plugins/makosh-telegram/http", "");
    const response = await harness.behavior.fetchHttp("GET", url, { headers: { range: "bytes=0-524287" } });
    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe(`bytes 0-524287/${size}`);
    expect((await response.arrayBuffer()).byteLength).toBe(524_288);
    expect(session.videoPart.mock.calls.map(([, offset, count]) => [offset, count])).toEqual([[0, 262_144], [262_144, 262_144]]);
    const seek = await harness.behavior.fetchHttp("GET", url, { headers: { range: "bytes=-64" } });
    expect(seek.status).toBe(206);
    expect((await seek.arrayBuffer()).byteLength).toBe(64);
    expect(session.videoPart).toHaveBeenLastCalledWith(77, size - 64, 64, expect.any(AbortSignal));
    expect((await harness.behavior.fetchHttp("GET", url, { headers: { range: "bytes=1048576-" } })).status).toBe(416);
    downloads.clear();
    expect((await harness.behavior.fetchHttp("GET", url)).status).toBe(404);
  } finally { await harness.lifecycle.dispose(); }
});
