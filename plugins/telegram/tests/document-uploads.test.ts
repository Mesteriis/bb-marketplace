import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { expect, test, vi } from "vitest";
import { registerDocumentUploads } from "../src/adapters/bb/document-uploads.ts";
import { createTelegram } from "../src/adapters/bb/telegram.ts";
import { decodeVoiceWaveform } from "../src/adapters/bb/voice-waveform.ts";
import type { connectTdJson, TdObject } from "../src/adapters/bb/tdjson.ts";

test.each([
  {},
  { topic: { id: 17, name: "Fixture topic" } },
  { topic: { id: 17, name: "Fixture topic" }, reply: { messageId: "12", externalReplyChatId: "43" } },
])("streams a document larger than 512 KiB to a private staged file and sends it once (%j)", async ({ topic, reply }) => {
  const { bb, harness } = createFakePluginHost({ pluginId: "makosh-telegram" });
  const directory = await mkdtemp(join(tmpdir(), "makosh-upload-"));
  const bytes = new Uint8Array(1024 * 1024).fill(7);
  let dispatched = 0;
  let confirmDelivery!: () => void;
  let stagedPath = "";
  const open: typeof connectTdJson = (_, update) => ({
    close: async () => {},
    request: async (query): Promise<TdObject> => {
      if (query["@type"] === "getAuthorizationState") return { "@type": "authorizationStateReady" };
      if (query["@type"] === "getOption") return { "@type": "optionValueString", value: "1.8.70" };
      if (query["@type"] === "getChat") return { "@type": "chat", id: query.chat_id };
      if (query["@type"] === "getForumTopic") return { "@type": "forumTopic", info: {
        "@type": "forumTopicInfo", chat_id: query.chat_id, forum_topic_id: topic?.id, name: topic?.name,
      } };
      if (query["@type"] === "getMessage") return {
        "@type": "message", id: 12, chat_id: query.chat_id,
        topic_id: topic ? { "@type": "messageTopicForum", forum_topic_id: topic.id } : undefined,
      };
      if (query["@type"] === "getMessageProperties") {
        expect(query).toMatchObject({ chat_id: 43, message_id: 12 });
        return { "@type": "messageProperties", can_be_replied_in_another_chat: true };
      }
      if (query["@type"] === "getFile") {
        expect(query.file_id).toBe(77);
        return { "@type": "file", id: 77, size: bytes.length,
          remote: { "@type": "remoteFile", is_uploading_active: true, uploaded_size: 256 * 1024 } };
      }
      if (query["@type"] !== "sendMessage") throw new Error("Unexpected fixture call");
      dispatched++;
      expect(query.topic_id).toEqual(topic ? { "@type": "messageTopicForum", forum_topic_id: topic.id } : undefined);
      expect(query.reply_to).toEqual(reply ? { "@type": "inputMessageReplyToExternalMessage", chat_id: 43, message_id: 12 }
        : topic ? { "@type": "inputMessageReplyToMessage", message_id: 12 } : undefined);
      if (reply) expect(query).not.toHaveProperty("reply_to_message_id");
      const content = query.input_message_content as { document: { document: { path: string } } };
      expect(content.document).toMatchObject({ "@type": "inputDocument", disable_content_type_detection: true });
      stagedPath = content.document.document.path;
      expect(await readFile(stagedPath)).toEqual(Buffer.from(bytes));
      const message = { "@type": "message", id: 13, chat_id: 42, topic_id: query.topic_id, reply_to_message_id: query.reply_to_message_id,
        ...(reply ? { reply_to: { "@type": "messageReplyToMessage", chat_id: 43, message_id: 12 } } : {}) };
      confirmDelivery = () => update({ "@type": "updateMessageSendSucceeded", old_message_id: 11, message });
      return { ...message, id: 11, sending_state: { "@type": "messageSendingStatePending" },
        content: { "@type": "messageDocument", document: { "@type": "document", document: { "@type": "file", id: 77 } } } };
    },
  });
  const session = createTelegram({ library: "fixture", directory, key: "fixture", apiId: 1, apiHash: "fixture" }, open);
  try {
    await vi.waitFor(() => expect(session.status().state).toBe("ready"));
    const uploads = registerDocumentUploads(bb, () => session);
    expect(harness.inspection.registrations.httpRoutes).toEqual(expect.arrayContaining([expect.objectContaining({ method: "POST", path: "/document-upload", auth: "local" })]));
    const issue = () => uploads.issue(session, { id: "42", name: "Fixture.bin", caption: "", size: bytes.length, topic, replyTo: topic && !reply ? "12" : undefined, reply })
      .url.replace("/api/v1/plugins/makosh-telegram/http", "");
    const post = (url: string, offset: number, body: Uint8Array) => harness.behavior.fetchHttp("POST", url, {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ offset, base64: Buffer.from(body).toString("base64") }),
    });
    const oversizedUrl = issue();
    const oversized = await harness.behavior.fetchHttp("POST", oversizedUrl, {
      headers: { "Content-Type": "application/json" }, body: " ".repeat(700_000),
    });
    expect(oversized.status).toBe(413);
    expect((await post(oversizedUrl, 0, bytes.subarray(0, 8))).status).toBe(404);
    const short = await post(issue(), 1, bytes.subarray(0, 8));
    expect(await short.json()).toEqual({ state: "failed" });
    expect(dispatched).toBe(0);

    const cancel = (url: string) => harness.behavior.fetchHttp("DELETE", url, {
      headers: { "Content-Type": "application/json" }, body: "{}",
    });
    const partial = issue();
    const partialResponse = await post(partial, 0, bytes.subarray(0, 512 * 1024));
    expect(await partialResponse.json()).toEqual({ received: 512 * 1024 });
    expect(await (await cancel(partial)).json()).toEqual({ cancelled: true });
    await vi.waitFor(async () => expect(await readdir(join(directory, "makosh-outgoing-documents"))).toEqual([]));
    expect((await post(partial, 512 * 1024, bytes.subarray(512 * 1024))).status).toBe(404);
    expect(dispatched).toBe(0);
    const url = issue();
    const first = await post(url, 0, bytes.subarray(0, 512 * 1024));
    expect(await first.json()).toEqual({ received: 512 * 1024 });
    const repeated = await post(url, 0, bytes.subarray(0, 512 * 1024));
    expect(await repeated.json()).toEqual({ received: 512 * 1024 });
    expect(dispatched).toBe(0);
    const response = await post(url, 512 * 1024, bytes.subarray(512 * 1024));
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ received: bytes.length });
    const repeatedLast = await post(url, 512 * 1024, bytes.subarray(512 * 1024));
    expect(repeatedLast.status).toBe(202);
    expect(await repeatedLast.json()).toEqual({ received: bytes.length });
    const outcome = async () => (await harness.behavior.fetchHttp("GET", url)).json();
    await vi.waitFor(async () => expect(await outcome()).toEqual({
      state: "pending", canCancel: false, progress: { uploaded: 256 * 1024, total: bytes.length },
    }));
    expect((await cancel(url)).status).toBe(409);
    expect(confirmDelivery).toBeTypeOf("function");
    confirmDelivery();
    await vi.waitFor(async () => expect(await outcome()).toMatchObject({ state: "sent" }));
    expect(dispatched).toBe(1);
    await expect(readFile(stagedPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await post(url, 0, bytes.subarray(0, 8))).status).toBe(404);
    expect(dispatched).toBe(1);
  } finally {
    await session.close();
    await harness.lifecycle.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test("settles early when Telegram refuses the upload before reading its first chunk", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "makosh-telegram" });
  const session = {
    status: () => ({ state: "ready" as const }),
    sendDocumentStream: async () => ({ state: "failed" as const }),
  };
  try {
    const { issue } = registerDocumentUploads(bb, () => session);
    const url = issue(session, { id: "42", name: "Fixture.txt", caption: "", size: 3 })
      .url.replace("/api/v1/plugins/makosh-telegram/http", "");
    const response = await harness.behavior.fetchHttp("POST", url, {
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ offset: 0, base64: "YWJj" }),
    });
    expect(await response.json()).toEqual({ state: "failed" });
  } finally { await harness.lifecycle.dispose(); }
});

test("cancels a sealed upload while Telegram has yet to dispatch the message", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "makosh-telegram" });
  const directory = await mkdtemp(join(tmpdir(), "makosh-cancel-upload-"));
  let resume!: () => void;
  const blocked = new Promise<void>((resolve) => { resume = resolve; });
  let staging = false;
  const request = vi.fn(async (query: TdObject): Promise<TdObject> => {
    if (query["@type"] === "getAuthorizationState") return { "@type": "authorizationStateReady" };
    if (query["@type"] === "getChat") return { "@type": "chat", id: 42 };
    if (query["@type"] === "getOption") {
      staging = true;
      await blocked;
      return { "@type": "optionValueString", value: "1.8.70" };
    }
    throw new Error("Unexpected fixture request");
  });
  const open: typeof connectTdJson = () => ({ request, close: async () => {} });
  const session = createTelegram({ library: "fixture", directory, key: "fixture", apiId: 1, apiHash: "fixture" }, open);
  try {
    await vi.waitFor(() => expect(session.status().state).toBe("ready"));
    const { issue } = registerDocumentUploads(bb, () => session);
    const url = issue(session, { id: "42", name: "Fixture.bin", caption: "", size: 3 })
      .url.replace("/api/v1/plugins/makosh-telegram/http", "");
    const response = await harness.behavior.fetchHttp("POST", url, {
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ offset: 0, base64: "YWJj" }),
    });
    expect(response.status).toBe(202);
    await vi.waitFor(() => expect(staging).toBe(true));
    expect(await (await harness.behavior.fetchHttp("GET", url)).json()).toEqual({ state: "pending", canCancel: true });
    expect(await (await harness.behavior.fetchHttp("DELETE", url, {
      headers: { "Content-Type": "application/json" }, body: "{}",
    })).json()).toEqual({ cancelled: true });
    resume();
    await vi.waitFor(async () => expect(await readdir(join(directory, "makosh-outgoing-documents"))).toEqual([]));
    expect(request.mock.calls.some(([query]) => query["@type"] === "sendMessage")).toBe(false);
  } finally {
    resume();
    await session.close();
    await harness.lifecycle.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test("aborts a sealed album during preparation, clears both staged media files, and never dispatches", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "makosh-telegram" });
  const directory = await mkdtemp(join(tmpdir(), "makosh-cancel-album-"));
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 8, 8, 0, 1, 0, 1, 1, 0xff, 0xd9]).toString("base64");
  let waiting = false;
  let aborted = false;
  const request = vi.fn(async (query: TdObject, _time?: number, signal?: AbortSignal): Promise<TdObject> => {
    if (query["@type"] === "getAuthorizationState") return { "@type": "authorizationStateReady" };
    if (query["@type"] === "getChat") return { "@type": "chat", id: 42, type: { "@type": "chatTypePrivate", user_id: 42 } };
    if (query["@type"] === "getOption") {
      waiting = true;
      if (!signal) throw new Error("Album preparation needs an abort signal.");
      return new Promise((_, reject) => {
        signal.addEventListener("abort", () => {
          aborted = true;
          reject(new Error("Cancelled"));
        }, { once: true });
      });
    }
    throw new Error("Unexpected fixture request");
  });
  const open: typeof connectTdJson = () => ({ request, close: async () => {} });
  const session = createTelegram({ library: "fixture", directory, key: "fixture", apiId: 1, apiHash: "fixture" }, open);
  const uploads = registerDocumentUploads(bb, () => session);
  try {
    await vi.waitFor(() => expect(session.status().state).toBe("ready"));
    const url = uploads.issue(session, { id: "42", name: "album", caption: "", size: 3, album: {
      id: "42", caption: "", items: [{ kind: "photo", base64: jpeg }, { kind: "video", name: "fixture.mp4", size: 3 }],
    } }).url.replace("/api/v1/plugins/makosh-telegram/http", "");
    const http = (method: string, value: object) => harness.behavior.fetchHttp(method, url, {
      headers: { "Content-Type": "application/json" }, body: JSON.stringify(value),
    });
    expect((await http("POST", { offset: 0, base64: "YWJj" })).status).toBe(202);
    await vi.waitFor(() => expect(waiting).toBe(true));
    expect(await (await harness.behavior.fetchHttp("GET", url)).json()).toEqual({ state: "pending", canCancel: true });
    expect(await (await http("DELETE", {})).json()).toEqual({ cancelled: true });
    await vi.waitFor(async () => {
      expect(aborted).toBe(true);
      expect(await readdir(join(directory, "makosh-outgoing-documents"))).toEqual([]);
      expect(await readdir(join(directory, "makosh-outgoing-photos"))).toEqual([]);
    });
    expect(request.mock.calls.some(([query]) => query["@type"] === "sendMessageAlbum")).toBe(false);
    expect((await harness.behavior.fetchHttp("GET", url)).status).toBe(404);
  } finally {
    uploads.clear();
    await session.close();
    await harness.lifecycle.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

const richVideoTestBin = ["/opt/homebrew/bin", "/usr/local/bin"].find((bin) =>
  existsSync(`${bin}/ffmpeg`) && existsSync(`${bin}/ffprobe`));

async function verifyRichUpload(videoBin?: string, welcome = false) {
  const { bb, harness } = createFakePluginHost({ pluginId: "makosh-telegram" });
  const directory = await mkdtemp(join(tmpdir(), "makosh-rich-upload-"));
  const jpeg = Buffer.from("ffd8ffc00008080001000100ffd9", "hex");
  const document = Buffer.from("Fixture document");
  const draft = [
    { kind: "paragraph" as const, text: "Fixture heading" },
    { kind: "photo" as const, name: "photo.jpg", size: jpeg.length, caption: "Photo caption", spoiler: true,
      styles: [{ offset: 0, length: 5, style: "bold" as const }] },
    { kind: "document" as const, name: "fixture.txt", size: document.length, caption: "", spoiler: false },
  ];
  let video: Buffer | undefined;
  let sends = 0;
  let allowed = true;
  const welcomeId = "-1000000000010";
  const open: typeof connectTdJson = () => ({
    close: async () => {},
    request: async (query): Promise<TdObject> => {
      switch (query["@type"]) {
        case "getAuthorizationState": return { "@type": "authorizationStateReady" };
        case "getMe": return { "@type": "user", is_premium: true };
        case "getOption": return { "@type": "optionValueInteger", value: 100 };
        case "getChat": return welcome ? { "@type": "chat", id: query.chat_id, type: { "@type": "chatTypeSupergroup" } }
          : { "@type": "chat", id: 42 };
        case "loadChatWelcomeMessages": return { "@type": allowed ? "ok" : "error" };
        case "getCurrentState": return { "@type": "updates", updates: [] };
        case "addChatWelcomeMessage":
        case "sendMessage": {
          sends++;
          if (welcome) expect(query).toMatchObject({ "@type": "addChatWelcomeMessage", chat_id: Number(welcomeId),
            input_message_content: { message: { detect_automatic_blocks: false } } });
          const input = query.input_message_content as { message: { source: { blocks: [
            unknown, { photo: { photo: { path: string } } }, { document: { document: { path: string } } },
            { video: { video: { path: string } } }?,
          ] } } };
          const blocks = input.message.source.blocks;
          expect(blocks).toMatchObject([
            { "@type": "inputPageBlockParagraph" },
            { "@type": "inputPageBlockPhoto", has_spoiler: true, caption: { text: { "@type": "richTexts", texts: [
              { "@type": "richTextBold", text: { "@type": "richTextPlain", text: "Photo" } },
              { "@type": "richTextPlain", text: " caption" },
            ] } } },
            { "@type": "inputPageBlockDocument" },
            ...(video ? [{ "@type": "inputPageBlockVideo", has_spoiler: true, video: {
              "@type": "inputVideo", width: 160, height: 90, duration: 1, supports_streaming: true,
            } }] : []),
          ]);
          expect(await readFile(blocks[1].photo.photo.path)).toEqual(jpeg);
          expect(await readFile(blocks[2].document.document.path)).toEqual(document);
          if (video) expect(await readFile(blocks[3]!.video.video.path)).toEqual(video);
          return welcome ? { "@type": "ok" } : { "@type": "message", id: 13, chat_id: 42, is_outgoing: true };
        }
        default: throw new Error("Unexpected fixture query");
      }
    },
  });
  const session = createTelegram({ library: "fixture", directory, key: "fixture", apiId: 1, apiHash: "fixture" }, open);
  try {
    await vi.waitFor(() => expect(session.status().state).toBe("ready"));
    const uploads = registerDocumentUploads(bb, () => session);
    if (videoBin) {
      const clip = join(directory, "fixture.mp4");
      await promisify(execFile)(`${videoBin}/ffmpeg`, ["-v", "error", "-f", "lavfi", "-i", "color=blue:s=160x90:r=15",
        "-t", "0.5", "-c:v", "libx264", "-pix_fmt", "yuv420p", clip]);
      video = await readFile(clip);
    }
    const blocks = video ? [...draft, { kind: "video" as const, name: "fixture.mp4", size: video.length,
      caption: "Video caption", spoiler: true }] : draft;
    const size = jpeg.length + document.length + (video?.length ?? 0);
    const issue = () => uploads.issue(session, welcome ? { size, welcomeRich: { id: welcomeId, draft: blocks } }
      : { id: "42", name: "formatted-message", caption: "", size, rich: { id: "42", draft: blocks } })
      .url.replace("/api/v1/plugins/makosh-telegram/http", "");
    await expect(session.sendRichMessage("42", draft)).resolves.toEqual({ state: "failed" });
    const post = (url: string, offset: number, chunk: Buffer) => harness.behavior.fetchHttp("POST", url, {
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ offset, base64: chunk.toString("base64") }),
    });
    const prefix = Buffer.concat([jpeg, document.subarray(0, 2)]);
    const suffix = video ? Buffer.concat([document.subarray(2), video]) : document.subarray(2);
    if (welcome && !video) {
      const refused = issue();
      expect((await post(refused, 0, prefix)).status).toBe(200);
      allowed = false;
      expect((await post(refused, prefix.length, suffix)).status).toBe(202);
      await vi.waitFor(async () => expect(await (await harness.behavior.fetchHttp("GET", refused)).json()).toEqual({ state: "failed" }));
      expect(sends).toBe(0);
      expect(await readdir(join(directory, "makosh-outgoing-photos"))).toEqual([]);
      expect(await readdir(join(directory, "makosh-outgoing-documents"))).toEqual([]);
      allowed = true;
    }
    const url = issue();
    expect((await post(url, 0, prefix)).status).toBe(200);
    expect(sends).toBe(0);
    expect((await post(url, prefix.length, suffix)).status).toBe(202);
    await vi.waitFor(async () => expect(await (await harness.behavior.fetchHttp("GET", url)).json())
      .toMatchObject({ state: welcome ? "submitted" : "sent" }));
    expect(sends).toBe(1);
    expect(await readdir(join(directory, "makosh-outgoing-photos"))).toEqual([]);
    expect(await readdir(join(directory, "makosh-outgoing-documents"))).toEqual([]);
    uploads.clear();
  } finally {
    await session.close();
    await harness.lifecycle.dispose();
    await rm(directory, { recursive: true, force: true });
  }
}

test("uploads an embedded photo and document together in block order", () => verifyRichUpload());
test.skipIf(!richVideoTestBin)("uploads an embedded H.264 video in the same formatted message", () => verifyRichUpload(richVideoTestBin));
test("uploads embedded media to a welcome message and rechecks rights after staging", () => verifyRichUpload(undefined, true));
test.skipIf(!richVideoTestBin)("adds an embedded H.264 video to a structured welcome message", () => verifyRichUpload(richVideoTestBin, true));

test("replaces and adds files in one welcome edit while retaining reviewed blocks", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "makosh-telegram" });
  const directory = await mkdtemp(join(tmpdir(), "bb-rich-welcome-edit-"));
  const id = "-1000000000010";
  const jpeg = Buffer.from("ffd8ffc00008080001000100ffd9", "hex");
  const document = Buffer.from("Fixture addition");
  const caption = { "@type": "pageBlockCaption", text: { "@type": "richTextPlain", text: "Original caption" },
    credit: { "@type": "richTextPlain", text: "Original credit" } };
  let intro = "Original introduction";
  let edits = 0;
  const open: typeof connectTdJson = () => ({ close: async () => {}, async request(query): Promise<TdObject> {
    switch (query["@type"]) {
      case "getAuthorizationState": return { "@type": "authorizationStateReady" };
      case "getMe": return { "@type": "user", id: 7, is_premium: true };
      case "getOption": return { "@type": "optionValueInteger", value: 1000 };
      case "getChat": return { "@type": "chat", id: query.chat_id, type: { "@type": "chatTypeSupergroup" } };
      case "loadChatWelcomeMessages": return { "@type": "ok" };
      case "getCurrentState": return { "@type": "updates", updates: [{ "@type": "updateChatWelcomeMessages", chat_id: Number(id), messages: [
        { "@type": "welcomeMessage", id: 7, content: { "@type": "messageRichMessage", message: { "@type": "richMessage", is_full: true,
          is_rtl: true, blocks: [
            { "@type": "pageBlockParagraph", text: { "@type": "richTextPlain", text: intro } },
            { "@type": "pageBlockPhoto", caption, has_spoiler: true, photo: { "@type": "photo", sizes: [{ "@type": "photoSize", width: 1,
              height: 1, photo: { "@type": "file", id: 48, size: jpeg.length } }] } },
            { "@type": "pageBlockDocument", document: { "@type": "document", file_name: "kept.txt", document: { "@type": "file", id: 49, size: 2 } } },
          ] } } },
      ] }] };
      case "editChatWelcomeMessage": {
        edits++;
        expect(query).toMatchObject({ chat_id: Number(id), welcome_message_id: 7, input_message_content: { message: { is_rtl: true,
          source: { blocks: [{ "@type": "inputPageBlockDocument", document: { document: { "@type": "inputFileId", id: 49 } } },
            { "@type": "inputPageBlockPhoto", caption: { ...caption, text: { "@type": "richTextPlain", text: "Updated with replacement" } }, has_spoiler: true },
            { "@type": "inputPageBlockDocument", document: { document: { "@type": "inputFileLocal" } } }] } } } });
        const { message: { source: { blocks } } } = query.input_message_content as { message: { source: { blocks: [unknown,
          { photo: { photo: { path: string } } }, { document: { document: { path: string } } }] } } };
        expect(await readFile(blocks[1].photo.photo.path)).toEqual(jpeg);
        expect(await readFile(blocks[2].document.document.path)).toEqual(document);
        return { "@type": "ok" };
      }
      default: throw new Error("Unexpected fixture query");
    }
  } });
  const session = createTelegram({ library: "fixture", directory, key: "fixture", apiId: 1, apiHash: "fixture" }, open);
  const uploads = registerDocumentUploads(bb, () => session);
  try {
    await vi.waitFor(() => expect(session.status().state).toBe("ready"));
    const draft = [
      { kind: "existingMedia" as const, index: 2, caption: "Ignored supplied caption", label: "Kept" },
      { kind: "photo" as const, name: "replacement.jpg", size: jpeg.length, caption: "Ignored replacement caption", spoiler: false, replaces: 1,
        captionEdit: { text: "Updated with replacement" } },
      { kind: "document" as const, name: "added.txt", size: document.length, caption: "", spoiler: false },
    ];
    const issue = async () => {
      const [row] = (await session.chatWelcomeMessages(id))!;
      expect(row).toMatchObject({ editable: true });
      return uploads.issue(session, { size: jpeg.length + document.length, welcomeRich: { id, draft,
        replace: { messageId: 7, revision: row!.revision } } }).url.replace("/api/v1/plugins/makosh-telegram/http", "");
    };
    const post = (url: string, offset: number, part: Buffer) => harness.behavior.fetchHttp("POST", url,
      { body: JSON.stringify({ offset, base64: part.toString("base64") }) });
    const stale = await issue();
    expect((await post(stale, 0, jpeg)).status).toBe(200);
    intro = "Changed elsewhere";
    expect((await post(stale, jpeg.length, document)).status).toBe(202);
    await vi.waitFor(async () => expect(await (await harness.behavior.fetchHttp("GET", stale)).json()).toEqual({ state: "changed" }));
    expect(edits).toBe(0);
    const current = await issue();
    expect((await post(current, 0, Buffer.concat([jpeg, document]))).status).toBe(202);
    await vi.waitFor(async () => expect(await (await harness.behavior.fetchHttp("GET", current)).json()).toEqual({ state: "submitted" }));
    expect(edits).toBe(1);
    expect(await readdir(join(directory, "makosh-outgoing-photos"))).toEqual([]);
    expect(await readdir(join(directory, "makosh-outgoing-documents"))).toEqual([]);
  } finally {
    uploads.clear();
    await session.close();
    await harness.lifecycle.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

async function verifySavedAttachment(bin?: string, kind: "video" | "mp3" | "m4a" | "gif" | "ogg" | "videoNote" = "video", welcome = false) {
  const video = !!bin && kind === "video";
  const videoNote = !!bin && kind === "videoNote";
  const animation = !!bin && kind === "gif";
  const voice = !!bin && kind === "ogg";
  const audio = !!bin && !video && !videoNote && !animation && !voice;
  const { bb, harness } = createFakePluginHost({ pluginId: "makosh-telegram" });
  const directory = await mkdtemp(join(tmpdir(), "bb-shortcut-document-"));
  let bytes = Buffer.alloc(512 * 1024 + 4, 11);
  const filename = video || videoNote ? "fixture.mp4" : audio || animation || voice ? `fixture.${kind}` : "fixture.bin";
  if (bin) {
    const fixture = join(directory, filename);
    const options = video || videoNote
      ? ["-f", "lavfi", "-i", "color=blue:s=160x90:r=15", "-t", "1", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart"]
      : animation ? ["-f", "lavfi", "-i", "testsrc=size=64x48:rate=5", "-t", "1"]
      : voice ? ["-f", "lavfi", "-i", "sine=frequency=440", "-t", "0.5", "-c:a", "libopus", "-ac", "1"]
      : ["-f", "lavfi", "-i", "sine=frequency=440", "-t", "0.5", "-c:a", kind === "mp3" ? "libmp3lame" : "aac",
        "-metadata", "title=Audio fixture", "-metadata", "artist=Fixture performer"];
    await promisify(execFile)(`${bin}/ffmpeg`, ["-v", "error", ...options, fixture]);
    bytes = await readFile(fixture);
  }
  const file = { "@type": "file", id: 84, size: bytes.length, remote: { "@type": "remoteFile", is_uploading_completed: false } };
  let stagedPath = "";
  let dispatches = 0;
  let updateFile = () => {};
  let confirmWelcome!: () => void;
  const welcomeConfirmation = new Promise<void>((resolve) => { confirmWelcome = resolve; });
  const welcomeChat = "-1000000000010";
  let welcomeCaption = "Original caption";
  const previousContent = () => ({ "@type": "messageDocument", document: { "@type": "document", document: file, file_name: filename },
    caption: { "@type": "formattedText", text: welcomeCaption, entities: [] } });
  const open: typeof connectTdJson = (_, update) => {
    updateFile = () => update({ "@type": "updateFile", file: { ...file, remote: { ...file.remote, is_uploading_completed: true } } });
    return { close: async () => {}, request: async (query): Promise<TdObject> => {
      switch (query["@type"]) {
        case "getAuthorizationState": return { "@type": "authorizationStateReady" };
        case "getMe": return { "@type": "user", id: 7 };
        case "getOption": return { "@type": "optionValueString", value: "1.8.70" };
        case "getChat": return { "@type": "chat", id: query.chat_id, type: { "@type": "chatTypeSupergroup" } };
        case "loadChatWelcomeMessages": return { "@type": "ok" };
        case "checkQuickReplyShortcutName":
        case "loadQuickReplyShortcuts": return { "@type": "ok" };
        case "getCurrentState": return { "@type": "updates", updates: welcome ? [
          { "@type": "updateChatWelcomeMessages", chat_id: Number(welcomeChat), messages: [
            { "@type": "welcomeMessage", id: 4, content: previousContent() },
          ] },
        ] : [
          { "@type": "updateQuickReplyShortcuts", shortcut_ids: [4] },
          { "@type": "updateQuickReplyShortcut", shortcut: {
            "@type": "quickReplyShortcut", id: 4, name: "fixture", message_count: 1,
          } },
        ] };
        case "getFile": return file;
        case "addChatWelcomeMessage":
        case "editChatWelcomeMessage":
        case "addQuickReplyShortcutMessage": {
          dispatches++;
          if (welcome) {
            expect(query.chat_id).toBe(Number(welcomeChat));
            if (!bin) expect(query).toMatchObject({ "@type": "editChatWelcomeMessage", welcome_message_id: 4 });
          } else expect(query.shortcut_name).toBe("fixture");
          const input = query.input_message_content as {
            video?: { video: { path: string } }; audio?: { audio: { path: string } }; document?: { document: { path: string } };
            animation?: { animation: { path: string } }; voice_note?: { voice_note: { path: string }; waveform: string };
            video_note?: { video_note: { path: string } };
          };
          expect(input).toMatchObject(video
            ? { "@type": "inputMessageVideo", caption: { text: "An attachment" }, video: { "@type": "inputVideo",
              duration: 1, width: 160, height: 90, supports_streaming: true, video: { "@type": "inputFileLocal" } } }
            : videoNote ? { "@type": "inputMessageVideoNote", video_note: { "@type": "inputVideoNote",
              video_note: { "@type": "inputFileLocal" }, length: 384 } }
            : audio ? { "@type": "inputMessageAudio", caption: { text: "An attachment" },
              audio: { "@type": "inputAudio", audio: { "@type": "inputFileLocal" }, duration: 1,
                title: "Audio fixture", performer: "Fixture performer" } }
            : animation ? { "@type": "inputMessageAnimation", caption: { text: "An attachment" },
              animation: { "@type": "inputAnimation", animation: { "@type": "inputFileLocal" }, duration: 1, width: 64, height: 48 } }
            : voice ? { "@type": "inputMessageVoiceNote", caption: { text: "An attachment" },
              voice_note: { "@type": "inputVoiceNote", voice_note: { "@type": "inputFileLocal" }, duration: 1 } }
            : { "@type": "inputMessageDocument", caption: { text: "An attachment" },
              document: { "@type": "inputDocument", disable_content_type_detection: true, document: { "@type": "inputFileLocal" } } });
          stagedPath = video ? input.video!.video.path : videoNote ? input.video_note!.video_note.path : audio ? input.audio!.audio.path : animation ? input.animation!.animation.path
            : voice ? input.voice_note!.voice_note.path : input.document!.document.path;
          if (voice) {
            const waveform = decodeVoiceWaveform(input.voice_note?.waveform);
            expect(waveform).toHaveLength(100);
            expect(waveform?.some((bar) => bar > 0)).toBe(true);
          }
          if (videoNote) expect((await readFile(stagedPath)).subarray(4, 8).toString()).toBe("ftyp");
          else expect(await readFile(stagedPath)).toEqual(bytes);
          if (welcome) {
            await welcomeConfirmation;
            return { "@type": "ok" };
          }
          return { "@type": "quickReplyMessage", id: 92, sending_state: { "@type": "messageSendingStatePending" },
            content: video ? { "@type": "messageVideo", video: { "@type": "video", mime_type: "video/mp4", video: file } }
              : audio ? { "@type": "messageAudio", audio: { "@type": "audio", audio: file } }
              : animation ? { "@type": "messageAnimation", animation: { "@type": "animation", mime_type: "image/gif", animation: file } }
              : voice ? { "@type": "messageVoiceNote", voice_note: { "@type": "voiceNote", mime_type: "audio/ogg", voice: file } }
              : { "@type": "messageDocument", document: { "@type": "document", document: file } } };
        }
        default: throw new Error("Unexpected fixture query");
      }
    } };
  };
  const session = createTelegram({ library: "fixture", directory, key: "fixture", apiId: 1, apiHash: "fixture" }, open);
  const uploads = registerDocumentUploads(bb, () => session);
  try {
    await vi.waitFor(() => expect(session.status().state).toBe("ready"));
    const attachment = { filename, size: bytes.length, caption: videoNote ? "" : "An attachment", ...(video && { video: true as const }),
      ...(videoNote && { videoNote: true as const }), ...(audio && { audio: true as const }),
      ...(animation && { animation: true as const }), ...(voice && { voice: true as const }) };
    const issue = (id: number) => uploads.issue(session, { size: bytes.length, shortcut: { id, name: "fixture", ...attachment } })
      .url.replace("/api/v1/plugins/makosh-telegram/http", "");
    const issueWelcome = (revision?: string) => uploads.issue(session, { size: bytes.length, welcome: { id: welcomeChat, ...attachment,
      ...(revision && { replace: { messageId: 4, revision } }) } }).url.replace("/api/v1/plugins/makosh-telegram/http", "");
    const send = (url: string, offset: number, chunk: Buffer) => harness.behavior.fetchHttp("POST", url, {
      body: JSON.stringify({ offset, base64: chunk.toString("base64") }),
    });
    const lastOffset = bytes.length > 512 * 1024 ? 512 * 1024 : 0;
    const sendAll = async (url: string) => {
      if (lastOffset) expect(await (await send(url, 0, bytes.subarray(0, lastOffset))).json()).toEqual({ received: lastOffset });
      expect((await send(url, lastOffset, bytes.subarray(lastOffset))).status).toBe(202);
    };
    if (!welcome) {
      const stale = issue(5);
      await sendAll(stale);
      await vi.waitFor(async () => expect(await (await harness.behavior.fetchHttp("GET", stale)).json()).toEqual({ state: "changed" }));
      expect(dispatches).toBe(0);
    }
    if (welcome && !bin) {
      const [reviewed] = (await session.chatWelcomeMessages(welcomeChat))!;
      const changed = issueWelcome(reviewed!.revision);
      expect(await (await send(changed, 0, bytes.subarray(0, lastOffset))).json()).toEqual({ received: lastOffset });
      welcomeCaption = "Changed elsewhere";
      expect((await send(changed, lastOffset, bytes.subarray(lastOffset))).status).toBe(202);
      await vi.waitFor(async () => expect(await (await harness.behavior.fetchHttp("GET", changed)).json()).toEqual({ state: "changed" }));
      const cancelled = issueWelcome();
      expect(await (await send(cancelled, 0, bytes.subarray(0, lastOffset))).json()).toEqual({ received: lastOffset });
      expect(await (await harness.behavior.fetchHttp("DELETE", cancelled)).json()).toEqual({ cancelled: true });
      await vi.waitFor(async () => expect(await readdir(join(directory, "makosh-outgoing-documents"))).toEqual([]));
      expect(dispatches).toBe(0);
    }
    const current = welcome && !bin ? (await session.chatWelcomeMessages(welcomeChat))![0] : undefined;
    const url = welcome ? issueWelcome(current?.revision) : issue(4);
    await sendAll(url);
    if (welcome) {
      await vi.waitFor(() => expect(stagedPath).not.toBe(""));
      expect(existsSync(stagedPath)).toBe(true);
      expect((await harness.behavior.fetchHttp("DELETE", url)).status).toBe(409);
      confirmWelcome();
    }
    await vi.waitFor(async () => expect(await (await harness.behavior.fetchHttp("GET", url)).json()).toEqual({ state: "submitted" }));
    expect((await send(url, lastOffset, bytes.subarray(lastOffset))).status).toBe(202);
    expect(dispatches).toBe(1);
    if (!welcome) {
      expect(existsSync(stagedPath)).toBe(true);
      updateFile();
    }
    await vi.waitFor(() => expect(existsSync(stagedPath)).toBe(false));
  } finally {
    confirmWelcome();
    uploads.clear();
    await session.close();
    await rm(directory, { recursive: true, force: true });
  }
}
test("streams a quick reply document once and keeps the staged file until TDLib finishes", () => verifySavedAttachment());
test.skipIf(!richVideoTestBin)("adds an MP4 as playable video to a quick reply", () => verifySavedAttachment(richVideoTestBin));
test.skipIf(!richVideoTestBin).each(["mp3", "m4a"] as const)("adds %s as playable audio to a quick reply", (kind) =>
  verifySavedAttachment(richVideoTestBin, kind));
test.skipIf(!richVideoTestBin)("adds an animated GIF to a quick reply", () => verifySavedAttachment(richVideoTestBin, "gif"));
test.skipIf(!richVideoTestBin)("adds mono Ogg Opus as a quick reply voice message", () => verifySavedAttachment(richVideoTestBin, "ogg"));
test("replaces a welcome document once and stops an upload when its review becomes stale or it is cancelled", () =>
  verifySavedAttachment(undefined, "video", true));
test.skipIf(!richVideoTestBin).each(["video", "mp3", "m4a", "gif", "ogg", "videoNote"] as const)("streams %s into a welcome message", (kind) =>
  verifySavedAttachment(richVideoTestBin, kind, true));
