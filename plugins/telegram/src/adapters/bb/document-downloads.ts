import { randomBytes } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { createTelegram } from "./telegram.ts";

type Session = Pick<ReturnType<typeof createTelegram>, "status" | "document" | "documentName" | "openOneView">;
type VideoSession = Session & Pick<ReturnType<typeof createTelegram>, "videoReference" | "videoPart">;
const route = "/document-download";
const privateHeaders = { "cache-control": "no-store", "x-content-type-options": "nosniff" };

export function registerDocumentDownloads(
  bb: Pick<BbPluginApi, "http" | "pluginId">,
  session: () => Session | undefined,
  now = Date.now,
) {
  const tickets = new Map<string, { expires: number; current: Session; chatId: string; messageId: string; playback: boolean; oneView: boolean }>();
  const videos = new Map<string, { current: VideoSession; chatId: string; messageId: string; expires: number }>();
  let inFlight = 0;

  bb.http.route("GET", "/video-stream", async (context) => {
    const ticket = videos.get(context.req.query("ticket") ?? "");
    if (!ticket || ticket.expires <= now() || session() !== ticket.current || ticket.current.status().state !== "ready") {
      return new Response(null, { status: 404, headers: privateHeaders });
    }
    const lifetime = new AbortController();
    const signal = AbortSignal.any([context.req.raw.signal, lifetime.signal]);
    try {
      const file = await ticket.current.videoReference(ticket.chatId, ticket.messageId);
      const range = context.req.raw.headers.get("range");
      const match = range && /^bytes=(\d*)-(\d*)$/.exec(range);
      const start = match?.[1] ? Number(match[1]) : match ? Math.max(0, file.size - Number(match[2])) : 0;
      const end = match?.[1] && match[2] ? Math.min(Number(match[2]), file.size - 1) : file.size - 1;
      if ((range && (!match || (!match[1] && !Number(match[2])))) || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end) {
        return new Response(null, { status: 416, headers: { ...privateHeaders, "content-range": `bytes */${file.size}` } });
      }
      ticket.expires = now() + 30 * 60_000;
      let offset = start;
      const body = new ReadableStream<Uint8Array<ArrayBuffer>>({
        async pull(controller) {
          if (signal.aborted || session() !== ticket.current || ticket.current.status().state !== "ready") {
            controller.error(new Error("Video stream ended."));
            return;
          }
          if (offset > end) {
            controller.close();
            return;
          }
          try {
            const count = Math.min(256 * 1024, end - offset + 1);
            controller.enqueue(await ticket.current.videoPart(file.id, offset, count, signal));
            offset += count;
          } catch (error) {
            controller.error(error);
          }
        },
        cancel() { lifetime.abort(); },
      }, { highWaterMark: 0 });
      return new Response(body, { status: range ? 206 : 200, headers: {
        ...privateHeaders, "accept-ranges": "bytes", "content-type": file.mime,
        "content-length": String(end - start + 1),
        ...(range ? { "content-range": `bytes ${start}-${end}/${file.size}` } : {}),
      } });
    } catch {
      return new Response(null, { status: 409, headers: privateHeaders });
    }
  }, { auth: "local" });

  bb.http.route("GET", route, async (context) => {
    const token = context.req.query("ticket") ?? "";
    const ticket = tickets.get(token);
    tickets.delete(token);
    if (!ticket || ticket.expires <= now() || session() !== ticket.current || ticket.current.status().state !== "ready") {
      return new Response(null, { status: 404, headers: privateHeaders });
    }
    const signal = context.req.raw.signal;
    if (inFlight >= 2) return new Response(null, { status: 429, headers: privateHeaders });
    inFlight++;
    try {
      if (ticket.oneView) {
        const copy = await ticket.current.openOneView(ticket.chatId, ticket.messageId, signal);
        if (signal.aborted || session() !== ticket.current || ticket.current.status().state !== "ready") {
          return new Response(null, { status: 409, headers: privateHeaders });
        }
        return new Response(new Uint8Array(copy.bytes), { headers: {
          ...privateHeaders, "content-type": copy.mime, "content-length": String(copy.bytes.length),
        } });
      }
      const { name, body, size } = ticket.playback ? await ticket.current.document(ticket.chatId, ticket.messageId, signal, true)
        : await ticket.current.document(ticket.chatId, ticket.messageId, signal);
      if (signal.aborted || session() !== ticket.current || ticket.current.status().state !== "ready") {
        await body?.cancel();
        return new Response(null, { status: 409, headers: privateHeaders });
      }
      const encoded = encodeURIComponent(name).replace(/['()*]/g, (c) => "%" + c.charCodeAt(0).toString(16));
      return new Response(body, { headers: {
        ...privateHeaders,
        "content-type": "application/octet-stream",
        "content-disposition": `attachment; filename="telegram-document"; filename*=UTF-8''${encoded}`,
        "content-length": String(size),
      } });
    } catch {
      return new Response(null, { status: 409, headers: privateHeaders });
    } finally {
      inFlight--;
    }
  }, { auth: "local" });

  return {
    async issue(current: Session, chatId: string, messageId: string, playback = false, oneView = false) {
      const name = oneView ? "Telegram one-view media" : playback ? await current.documentName(chatId, messageId, true) : await current.documentName(chatId, messageId);
      if (session() !== current || current.status().state !== "ready") throw new Error("Telegram session changed.");
      const issuedAt = now();
      for (const [token, ticket] of tickets) if (ticket.expires <= issuedAt) tickets.delete(token);
      if (tickets.size >= 64) tickets.delete(tickets.keys().next().value!);
      const ticket = randomBytes(32).toString("base64url");
      tickets.set(ticket, { current, chatId, messageId, playback, oneView, expires: issuedAt + 60_000 });
      return { name, url: `/api/v1/plugins/${bb.pluginId}/http${route}?ticket=${ticket}` };
    },
    async issueVideo(current: VideoSession, chatId: string, messageId: string) {
      await current.videoReference(chatId, messageId);
      if (session() !== current || current.status().state !== "ready") throw new Error("Telegram session changed.");
      for (const [key, ticket] of videos) if (ticket.expires <= now()) videos.delete(key);
      if (videos.size >= 32) videos.delete(videos.keys().next().value!);
      const token = randomBytes(32).toString("base64url");
      videos.set(token, { current, chatId, messageId, expires: now() + 30 * 60_000 });
      return `/api/v1/plugins/${bb.pluginId}/http/video-stream?ticket=${token}`;
    },
    clear() { tickets.clear(); videos.clear(); },
  };
}
