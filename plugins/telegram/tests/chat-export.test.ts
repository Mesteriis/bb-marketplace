import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { expect, test, vi } from "vitest";
import { registerChatExports } from "../src/adapters/bb/chat-export.ts";
import type { RichMessageLayout } from "../src/core/contract.ts";
import { readRichHtmlArchive } from "../src/ui/rich-html-archive.ts";

const fixture = { id: "12", time: "", author: "Fixture", text: "<script>alert(1)</script>",
  document: { name: "fixture.txt", downloadable: true } };

function setup(profileMime: "audio/mpeg" | "audio/flac" = "audio/mpeg") {
  const { bb, harness } = createFakePluginHost({ pluginId: "makosh-telegram" });
  const body = "fixture attachment";
  const session = {
    status: () => ({ state: "ready" as const }),
    accountExportSources: vi.fn(async () => ({ chats: [{ id: "42", title: "One fixture" }, { id: "-43", title: "Other fixture" }], skipped: 2 })),
    accountExportAudio: vi.fn(async () => ({ tracks: [
      { index: 0, fileId: 77, title: "Fixture track", performer: "Fixture artist", mime: profileMime },
    ], next: null })),
    accountExportTrack: vi.fn(async () => ({ name: "fixture.mp3", size: Buffer.byteLength(body), body: new Response(body).body })),
    chatExportSource: vi.fn(async () => "<Test chat>"),
    chatExportPredecessor: vi.fn(async (_id: string, _signal: AbortSignal): Promise<{ id: string; through: number } | undefined> => undefined),
    chatExportPage: vi.fn(async (_id: string, cursor: number): Promise<{ messages: { id: string; message: typeof fixture | undefined }[]; before: number | null }> => cursor === 0 ? {
      messages: [{ id: "12", message: fixture }, { id: "11", message: undefined }], before: 11,
    } : { messages: [], before: null }),
    document: vi.fn(async () => ({ name: "fixture.txt", size: Buffer.byteLength(body), body: new Response(body).body })),
    formattedArchiveLayout: vi.fn(async (): Promise<RichMessageLayout | undefined> => undefined),
    formattedArchiveDocument: vi.fn(async () => ({ name: "fixture.txt", size: Buffer.byteLength(body), body: new Response(body).body })),
    channelInboxArchiveSource: vi.fn(async () => "Fixture inbox"),
    channelInboxDocument: vi.fn(async () => ({ name: "inbox.txt", size: Buffer.byteLength(body), body: new Response(body).body })),
  };
  let current: typeof session | undefined = session;
  const exports = registerChatExports(bb, () => current);
  const fetch = (url: string) => harness.behavior.fetchHttp("GET", url.replace("/api/v1/plugins/makosh-telegram/http", ""));
  return { exports, fetch, session, body, disconnect() { current = undefined; exports.clear(); } };
}

test("exports all pages as JSON through a private one-use download", async () => {
  const { exports, fetch, session, disconnect } = setup();
  const file = await exports.issue(session, "42", { format: "json", media: false });
  const response = await fetch(file.url);
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toMatchObject({ chat: "<Test chat>", messages: [
    { id: "12", text: fixture.text, attachment: { name: "fixture.txt" } }, { id: "11", withheld: true },
  ] });
  expect(session.chatExportPage.mock.calls.map((call) => call[1])).toEqual([0, 11]);
  expect(session.document).not.toHaveBeenCalled();
  expect((await fetch(file.url)).status).toBe(404);
  const pending = await exports.issue(session, "42", { format: "html", media: false });
  disconnect();
  expect((await fetch(pending.url)).status).toBe(404);
});

test("streams an extractable TAR with a safe HTML index and the original attachment bytes", async () => {
  const { exports, fetch, session, body } = setup();
  const folder = await mkdtemp(join(tmpdir(), "makosh-export-fixture-"));
  try {
    const file = await exports.issue(session, "42", { format: "html", media: true });
    expect(file.name).toBe("telegram-history.tar");
    const response = await fetch(file.url);
    expect(response.headers.get("content-type")).toBe("application/x-tar");
    const path = join(folder, file.name);
    await writeFile(path, Buffer.from(await response.arrayBuffer()));
    expect(execFileSync("tar", ["-tf", path], { encoding: "utf8" }).trim().split("\n"))
      .toEqual(["media/12-fixture.txt", "history.html"]);
    expect(execFileSync("tar", ["-xOf", path, "media/12-fixture.txt"], { encoding: "utf8" })).toBe(body);
    const html = execFileSync("tar", ["-xOf", path, "history.html"], { encoding: "utf8" });
    expect(html).toContain('href="media/12-fixture.txt"');
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("Protected message");
    expect(html).not.toContain("<script>");
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test("exports migrated history and separates attachments with overlapping message IDs", async () => {
  const { exports, fetch, session, body } = setup();
  session.chatExportPredecessor.mockResolvedValue({ id: "-43", through: 24 });
  const folder = await mkdtemp(join(tmpdir(), "makosh-migrated-export-fixture-"));
  try {
    const file = await exports.issue(session, "-42", { format: "json", media: true });
    const response = await fetch(file.url);
    const path = join(folder, file.name);
    await writeFile(path, Buffer.from(await response.arrayBuffer()));
    const read = (name: string) => execFileSync("tar", ["-xOf", path, name], { encoding: "utf8" });
    expect(JSON.parse(read("history.json")).messages).toMatchObject([
      { id: "12", attachment: { path: "media/12-fixture.txt" } },
      { id: "11", withheld: true },
      { id: "12", sourceChatId: "-43", attachment: { path: "media/legacy-12-fixture.txt" } },
      { id: "11", sourceChatId: "-43", withheld: true },
    ]);
    expect(read("media/12-fixture.txt")).toBe(body);
    expect(read("media/legacy-12-fixture.txt")).toBe(body);
    expect(session.document).toHaveBeenNthCalledWith(1, "-42", "12", expect.any(AbortSignal));
    expect(session.document).toHaveBeenNthCalledWith(2, "-43", "12", expect.any(AbortSignal));
  } finally { await rm(folder, { recursive: true, force: true }); }
});


test("streams only selected attachments and indexes unavailable files without exporting messages", async () => {
  const { exports, fetch, session, body } = setup();
  const folder = await mkdtemp(join(tmpdir(), "makosh-selected-attachments-"));
  try {
    const options = { format: "json" as const, media: true };
    await expect(exports.issue(session, "42", options, ["12", "12"])).rejects.toThrow("Invalid attachment selection");
    session.document.mockRejectedValueOnce(new Error("Unavailable fixture attachment"));
    const file = await exports.issue(session, "42", options, ["11", "12"]);
    expect(file.name).toBe("telegram-attachments.tar");
    const response = await fetch(file.url);
    expect(response.headers.get("content-type")).toBe("application/x-tar");
    const path = join(folder, file.name);
    await writeFile(path, Buffer.from(await response.arrayBuffer()));
    expect(execFileSync("tar", ["-tf", path], { encoding: "utf8" }).trim().split("\n"))
      .toEqual(["media/12-fixture.txt", "index.json"]);
    expect(execFileSync("tar", ["-xOf", path, "media/12-fixture.txt"], { encoding: "utf8" })).toBe(body);
    const index = execFileSync("tar", ["-xOf", path, "index.json"], { encoding: "utf8" });
    expect(JSON.parse(index)).toEqual({ attachments: [{ id: "11", unavailable: true },
      { id: "12", file: "media/12-fixture.txt", originalName: "fixture.txt" }] });
    expect(session.chatExportPage).not.toHaveBeenCalled();
    expect(session.document.mock.calls).toHaveLength(2);
    expect((await fetch(file.url)).status).toBe(404);
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test("streams a formatted selection with links to the exact embedded files and skips media spoilers", async () => {
  const { exports, fetch, session, body } = setup();
  const folder = await mkdtemp(join(tmpdir(), "makosh-formatted-selection-"));
  try {
    session.formattedArchiveLayout.mockResolvedValue({ rtl: false, complete: true, blocks: [
      { kind: "heading", headingSize: 3, content: { text: "Fixture heading" } },
      { kind: "photo", reference: { index: 1, fileId: 70 }, content: { text: "Fixture caption" },
        dimensions: { width: 10, height: 10 }, spoiler: false },
      { kind: "photo", reference: { index: 2, fileId: 71 }, content: { text: "" },
        dimensions: { width: 10, height: 10 }, spoiler: true },
      { kind: "document", reference: { index: 3, fileId: 72 }, content: { text: "File caption" },
        document: { name: "fixture.txt", downloadable: true }, media: "file", spoiler: false, loop: false },
      { kind: "document", reference: { index: 4, fileId: 73 }, content: { text: "Unavailable file caption" },
        document: { name: "unavailable.txt", downloadable: true }, media: "file", spoiler: false, loop: false },
    ] });
    session.formattedArchiveDocument.mockResolvedValueOnce({ name: "fixture.jpg", size: 4, body: new Response("jpeg").body })
      .mockResolvedValueOnce({ name: "fixture.txt", size: Buffer.byteLength(body), body: new Response(body).body })
      .mockRejectedValueOnce(new Error("Fixture file unavailable"));
    const file = await exports.issue(session, "42", { format: "html", media: true }, ["12"]);
    expect(file.name).toBe("telegram-messages.tar");
    const response = await fetch(file.url);
    const path = join(folder, file.name);
    const bytes = await response.arrayBuffer();
    await writeFile(path, Buffer.from(bytes));
    const read = (member: string) => execFileSync("tar", ["-xOf", path, member], { encoding: "utf8" });
    expect(execFileSync("tar", ["-tf", path], { encoding: "utf8" }).trim().split("\n"))
      .toEqual(["media/12-1-fixture.jpg", "media/12-3-fixture.txt", "messages.html"]);
    expect(read("media/12-1-fixture.jpg")).toBe("jpeg");
    expect(read("media/12-3-fixture.txt")).toBe(body);
    expect(read("messages.html")).toContain('<h3>Fixture heading</h3><figure data-bb-attachment="photo"><a download href="media/12-1-fixture.jpg"');
    expect(read("messages.html")).toContain("<figcaption>Fixture caption</figcaption>");
    expect(read("messages.html")).toContain("<p>Unavailable file caption</p><p>Attachment unavailable</p>");
    const signal = new AbortController().signal;
    const archived = await readRichHtmlArchive(new Blob([bytes]), 524288, signal);
    expect(archived?.html).toBe(read("messages.html"));
    expect(await archived?.files.get("media/12-3-fixture.txt")?.text()).toBe(body);
    const unsafe = Buffer.from(bytes.slice(0));
    unsafe.fill(0, 0, 100);
    unsafe.write("../unsafe.txt", 0, "ascii");
    unsafe.fill(32, 148, 156);
    const sum = unsafe.subarray(0, 512).reduce((total, byte) => total + byte, 0);
    unsafe.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "ascii");
    await expect(readRichHtmlArchive(new Blob([new Uint8Array(unsafe)]), 524288, signal)).resolves.toBeUndefined();
    expect(session.formattedArchiveDocument.mock.calls).toEqual([
      ["42", "12", { index: 1, fileId: 70 }, expect.any(AbortSignal), undefined],
      ["42", "12", { index: 3, fileId: 72 }, expect.any(AbortSignal), undefined],
      ["42", "12", { index: 4, fileId: 73 }, expect.any(AbortSignal), undefined],
    ]);
    session.formattedArchiveDocument.mockClear();
    session.formattedArchiveLayout.mockResolvedValueOnce(undefined);
    const blocked = await exports.issue(session, "42", { format: "html", media: true }, ["12"]);
    const failed = await fetch(blocked.url);
    await expect(failed.arrayBuffer()).rejects.toThrow("Telegram export did not complete");
    expect(session.formattedArchiveDocument).not.toHaveBeenCalled();
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test("binds an inbox attachment archive to its selected messages and never falls back to a whole-chat download", async () => {
  const { exports, fetch, session, body } = setup();
  const scope = { id: "-42", inboxId: "-43", topicId: "8", ids: ["11", "12"] };
  const folder = await mkdtemp(join(tmpdir(), "makosh-inbox-attachments-"));
  try {
    session.channelInboxDocument.mockRejectedValueOnce(new Error("Fixture protected attachment"));
    const file = await exports.issueInboxAttachments(session, scope);
    expect(session.channelInboxArchiveSource).toHaveBeenCalledExactlyOnceWith(scope);
    scope.ids.push("13");
    const response = await fetch(file.url);
    expect(response.headers.get("content-type")).toBe("application/x-tar");
    const path = join(folder, file.name);
    await writeFile(path, Buffer.from(await response.arrayBuffer()));
    expect(execFileSync("tar", ["-tf", path], { encoding: "utf8" }).trim().split("\n")).toEqual(["media/12-inbox.txt", "index.json"]);
    expect(execFileSync("tar", ["-xOf", path, "media/12-inbox.txt"], { encoding: "utf8" })).toBe(body);
    expect(JSON.parse(execFileSync("tar", ["-xOf", path, "index.json"], { encoding: "utf8" }))).toEqual({
      attachments: [{ id: "11", unavailable: true }, { id: "12", file: "media/12-inbox.txt", originalName: "inbox.txt" }],
    });
    expect(session.document).not.toHaveBeenCalled();
    expect(session.chatExportSource).not.toHaveBeenCalled();
    expect(session.channelInboxDocument.mock.calls).toEqual(["11", "12"].map((messageId) => [
      { id: "-42", inboxId: "-43", topicId: "8", messageId }, expect.any(AbortSignal),
    ]));
    expect((await fetch(file.url)).status).toBe(404);
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test("exports separate account histories and a top-level index in one TAR", async () => {
  const { exports, fetch, session } = setup();
  const folder = await mkdtemp(join(tmpdir(), "makosh-account-export-fixture-"));
  try {
    const file = await exports.issue(session, undefined, { format: "json", media: false });
    expect(file.name).toBe("telegram-account.tar");
    const response = await fetch(file.url);
    expect(response.headers.get("content-type")).toBe("application/x-tar");
    const path = join(folder, file.name);
    await writeFile(path, Buffer.from(await response.arrayBuffer()));
    expect(execFileSync("tar", ["-tf", path], { encoding: "utf8" }).trim().split("\n"))
      .toEqual(["index.json", "chats/42/history.json", "chats/-43/history.json"]);
    const index = execFileSync("tar", ["-xOf", path, "index.json"], { encoding: "utf8" });
    expect(JSON.parse(index)).toEqual({ chats: [
      { id: "42", title: "One fixture", path: "chats/42/history.json" },
      { id: "-43", title: "Other fixture", path: "chats/-43/history.json" },
    ], skippedChats: 2 });
    expect(session.chatExportPage.mock.calls.map(([id, cursor]) => [id, cursor]))
      .toEqual([["42", 0], ["42", 11], ["-43", 0], ["-43", 11]]);
    expect(session.document).not.toHaveBeenCalled();
    expect(session.accountExportAudio).not.toHaveBeenCalled();
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test.each([
  { media: false, mime: "audio/mpeg", extension: "mp3" },
  { media: true, mime: "audio/mpeg", extension: "mp3" },
  { media: true, mime: "audio/flac", extension: "flac" },
] as const)("exports opt-in profile music with media $media and type $mime", async ({ media, mime, extension }) => {
  const { exports, fetch, session, body } = setup(mime);
  const folder = await mkdtemp(join(tmpdir(), "makosh-music-export-fixture-"));
  try {
    const file = await exports.issue(session, undefined, { format: "json", media, profileMusic: true });
    const response = await fetch(file.url);
    const path = join(folder, file.name);
    await writeFile(path, Buffer.from(await response.arrayBuffer()));
    const read = (name: string) => execFileSync("tar", ["-xOf", path, name], { encoding: "utf8" });
    expect(JSON.parse(read("index.json")).profileMusic).toBe("profile-music/index.json");
    const name = `track-1.${extension}`;
    expect(JSON.parse(read("profile-music/index.json"))).toEqual({ available: true, tracks: [{
      title: "Fixture track", performer: "Fixture artist", ...(media && { path: name }),
    }] });
    if (media) {
      expect(read(`profile-music/${name}`)).toBe(body);
      expect(session.accountExportTrack).toHaveBeenCalledExactlyOnceWith(0, 77, expect.any(AbortSignal));
    } else expect(session.accountExportTrack).not.toHaveBeenCalled();
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test("streams 10,000 messages without fetching pages ahead of the reader", async () => {
  const { exports, fetch, session } = setup();
  const count = 10_000;
  session.chatExportPage.mockImplementation(async (_id, cursor) => {
    const start = cursor ? cursor - 1 : count;
    const messages = Array.from({ length: Math.min(50, start) }, (_, index) => {
      const id = String(start - index);
      return { id, message: { ...fixture, id } };
    });
    return { messages, before: start > 50 ? start - 49 : null };
  });
  const ticket = await exports.issue(session, "42", { format: "json", media: false });
  const response = await fetch(ticket.url);
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const chunks = [decoder.decode((await reader.read()).value)];
  expect(session.chatExportPage).not.toHaveBeenCalled();
  chunks.push(decoder.decode((await reader.read()).value));
  expect(session.chatExportPage).toHaveBeenCalledTimes(1);
  for (;;) {
    const result = await reader.read();
    if (result.done) break;
    chunks.push(decoder.decode(result.value));
  }
  expect(JSON.parse(chunks.join("")).messages.map(({ id }: { id: string }) => id))
    .toEqual(Array.from({ length: count }, (_, index) => String(count - index)));
  expect(session.chatExportPage).toHaveBeenCalledTimes(200);
  expect(session.document).not.toHaveBeenCalled();
});

test("disconnect stops an export paused mid-attachment and releases its reader", async () => {
  const { exports, fetch, session, disconnect } = setup();
  const cancel = vi.fn();
  session.document.mockResolvedValueOnce({
    name: "fixture.txt", size: 10,
    body: new ReadableStream<Uint8Array<ArrayBuffer>>({ cancel }, { highWaterMark: 0 }),
  });
  const ticket = await exports.issue(session, "42", { format: "json", media: true });
  const response = await fetch(ticket.url);
  const reader = response.body!.getReader();
  expect((await reader.read()).value).toHaveLength(512);
  disconnect();
  await expect(reader.read()).rejects.toThrow("Telegram export did not complete");
  await vi.waitFor(() => expect(cancel).toHaveBeenCalledTimes(1));
});
