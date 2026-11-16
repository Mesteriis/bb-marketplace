import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { expect, test, vi } from "vitest";
import { registerDocumentUploads } from "../src/adapters/bb/document-uploads.ts";
import { createTelegram } from "../src/adapters/bb/telegram.ts";
import type { connectTdJson, TdObject } from "../src/adapters/bb/tdjson.ts";

test.each([undefined, { id: 17, name: "Fixture topic" }])(
  "streams a document larger than 512 KiB to a private staged file and sends it once (%j)", async (topic) => {
  const { bb, harness } = createFakePluginHost({ pluginId: "makosh-telegram" });
  const directory = await mkdtemp(join(tmpdir(), "makosh-upload-"));
  const bytes = new Uint8Array(1024 * 1024).fill(7);
  let dispatched = 0;
  let confirmDelivery!: () => void;
  let stagedPath = "";
  const open: typeof connectTdJson = () => ({
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
      if (query["@type"] !== "sendMessage") throw new Error("Unexpected fixture call");
      dispatched++;
      expect(query.topic_id).toEqual(topic ? { "@type": "messageTopicForum", forum_topic_id: topic.id } : undefined);
      expect(query.reply_to).toEqual(topic ? { "@type": "inputMessageReplyToMessage", message_id: 12 } : undefined);
      const content = query.input_message_content as { document: { document: { path: string } } };
      expect(content.document).toMatchObject({ "@type": "inputDocument", disable_content_type_detection: true });
      stagedPath = content.document.document.path;
      expect(await readFile(stagedPath)).toEqual(Buffer.from(bytes));
      await new Promise<void>((resolve) => { confirmDelivery = resolve; });
      return { "@type": "message", id: 13, chat_id: 42, topic_id: query.topic_id, reply_to_message_id: query.reply_to_message_id };
    },
  });
  const session = createTelegram({ library: "fixture", directory, key: "fixture", apiId: 1, apiHash: "fixture" }, open);
  try {
    await vi.waitFor(() => expect(session.status().state).toBe("ready"));
    const uploads = registerDocumentUploads(bb, () => session);
    expect(harness.inspection.registrations.httpRoutes).toEqual(expect.arrayContaining([expect.objectContaining({ method: "POST", path: "/document-upload", auth: "local" })]));
    const issue = () => uploads.issue(session, { id: "42", name: "Fixture.bin", caption: "", size: bytes.length, topic, replyTo: topic ? "12" : undefined })
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
    expect((await cancel(url)).status).toBe(409);
    expect(await response.json()).toEqual({ received: bytes.length });
    const repeatedLast = await post(url, 512 * 1024, bytes.subarray(512 * 1024));
    expect(repeatedLast.status).toBe(202);
    expect(await repeatedLast.json()).toEqual({ received: bytes.length });
    const outcome = async () => (await harness.behavior.fetchHttp("GET", url)).json();
    expect(await outcome()).toEqual({ state: "pending" });
    await vi.waitFor(() => expect(confirmDelivery).toBeTypeOf("function"));
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
