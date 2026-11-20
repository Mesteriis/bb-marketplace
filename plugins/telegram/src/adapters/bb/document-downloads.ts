import { randomBytes } from "node:crypto";
import { addAbortListener } from "node:events";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { PollAttachmentReference, RichAttachmentReference } from "../../core/contract.ts";
import type { createTelegram } from "./telegram.ts";

type Session = Pick<ReturnType<typeof createTelegram>, "status" | "document" | "documentName" | "openOneView">;
type ArticleDocumentSession = Session & Pick<ReturnType<typeof createTelegram>, "instantViewDocument" | "instantViewDocumentName">;
type ShortcutDocumentSession = Session & Pick<ReturnType<typeof createTelegram>, "quickReplyDocument" | "quickReplyDocumentName">;
type WelcomeDocumentSession = Session & Pick<ReturnType<typeof createTelegram>, "chatWelcomeDocument" | "chatWelcomeDocumentName">;
type PhotoDragSession = Session & Pick<ReturnType<typeof createTelegram>, "photoDragReference" | "photoDragDocument">;
type DocumentSource =
  | { current: Session; chatId: string; messageId: string; playback: boolean; oneView: boolean; attachment?: RichAttachmentReference }
  | { current: Session; load: (signal: AbortSignal) => ReturnType<Session["document"]> };
type DocumentTicket = DocumentSource & { expires: number };
type VideoSession = Session & Pick<ReturnType<typeof createTelegram>, "videoReference" | "videoPart">;
type VideoFile = Awaited<ReturnType<VideoSession["videoReference"]>>;
type VideoSource = Session & Pick<VideoSession, "videoPart">;
type VideoTicket = { current: VideoSource; resolve: () => Promise<VideoFile>; file: VideoFile; expires: number; abort: AbortController };
const videoLifetime = 30 * 60_000;
const documentLifetime = 60_000;
const route = "/document-download";
const privateHeaders = { "cache-control": "no-store", "x-content-type-options": "nosniff" };

export function registerDocumentDownloads(
  bb: Pick<BbPluginApi, "http" | "pluginId">,
  session: () => Session | undefined,
  now = Date.now,
) {
  const tickets = new Map<string, DocumentTicket>();
  const videos = new Map<string, VideoTicket>();
  const transfers = new Set<AbortController>();
  let inFlight = 0;
  let cacheCleanup: Promise<unknown> | undefined;

  async function cleanCache<T>(work: () => Promise<T>): Promise<T | undefined> {
    if (cacheCleanup || transfers.size) return undefined;
    const pending = Promise.resolve().then(work);
    cacheCleanup = pending;
    try {
      return await pending;
    } finally {
      if (cacheCleanup === pending) cacheCleanup = undefined;
    }
  }

  async function waitForCacheCleanup(signal: AbortSignal) {
    const pending = cacheCleanup;
    if (!pending) return;
    const finished = pending.catch(() => {});
    if (signal.aborted) return;
    let aborted!: () => void;
    const cancelled = new Promise<void>((resolve) => { aborted = resolve; });
    const listener = addAbortListener(signal, aborted);
    try { await Promise.race([finished, cancelled]); }
    finally { listener[Symbol.dispose](); }
  }

  function revokeVideo(token: string) {
    const ticket = videos.get(token);
    videos.delete(token);
    ticket?.abort.abort();
  }

  async function issueVideoTicket(current: VideoSource, resolve: () => Promise<VideoFile>, prepare = resolve) {
    const transfer = new AbortController();
    transfers.add(transfer);
    let file: VideoFile;
    try {
      await waitForCacheCleanup(transfer.signal);
      if (transfer.signal.aborted || session() !== current) throw new Error("Telegram session changed.");
      file = await prepare();
      transfer.signal.throwIfAborted();
    } finally {
      transfers.delete(transfer);
    }
    if (session() !== current || current.status().state !== "ready") throw new Error("Telegram session changed.");
    const issuedAt = now();
    for (const [key, ticket] of videos) if (ticket.expires <= issuedAt) revokeVideo(key);
    if (videos.size >= 32) revokeVideo(videos.keys().next().value!);
    const token = randomBytes(32).toString("base64url");
    videos.set(token, { current, resolve, file, expires: issuedAt + videoLifetime, abort: new AbortController() });
    return `/api/v1/plugins/${bb.pluginId}/http/video-stream?ticket=${token}`;
  }

  bb.http.route("GET", "/video-stream", async (context) => {
    const token = context.req.query("ticket") ?? "";
    const ticket = videos.get(token);
    if (!ticket || ticket.expires <= now() || session() !== ticket.current || ticket.current.status().state !== "ready") {
      if (ticket) revokeVideo(token);
      return new Response(null, { status: 404, headers: privateHeaders });
    }
    const lifetime = new AbortController();
    const signal = AbortSignal.any([context.req.raw.signal, lifetime.signal, ticket.abort.signal]);
    const active = () => !signal.aborted && videos.get(token) === ticket && session() === ticket.current
      && ticket.current.status().state === "ready";
    let streaming = false;
    let reading = false;
    function release() {
      signal.removeEventListener("abort", onEnd);
      transfers.delete(lifetime);
    }
    function onEnd() {
      if (!reading) release();
    }
    transfers.add(lifetime);
    try {
      await waitForCacheCleanup(signal);
      if (!active()) return new Response(null, { status: 404, headers: privateHeaders });
      const file = await ticket.resolve();
      if (!active()) return new Response(null, { status: 404, headers: privateHeaders });
      if (file.id !== ticket.file.id || file.size !== ticket.file.size || file.mime !== ticket.file.mime) {
        revokeVideo(token);
        return new Response(null, { status: 409, headers: privateHeaders });
      }
      const range = context.req.raw.headers.get("range");
      const match = range && /^bytes=(\d*)-(\d*)$/.exec(range);
      const start = match?.[1] ? Number(match[1]) : match ? Math.max(0, file.size - Number(match[2])) : 0;
      const end = match?.[1] && match[2] ? Math.min(Number(match[2]), file.size - 1) : file.size - 1;
      if ((range && (!match || (!match[1] && !Number(match[2])))) || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end) {
        return new Response(null, { status: 416, headers: { ...privateHeaders, "content-range": `bytes */${file.size}` } });
      }
      ticket.expires = now() + videoLifetime;
      let offset = start;
      const body = new ReadableStream<Uint8Array<ArrayBuffer>>({
        async pull(controller) {
          if (!active()) {
            controller.error(new Error("Video stream ended."));
            release();
            return;
          }
          reading = true;
          try {
            const count = Math.min(256 * 1024, end - offset + 1);
            const part = await ticket.current.videoPart(file.id, offset, count, signal);
            if (!active()) throw new Error("Video stream ended.");
            ticket.expires = now() + videoLifetime;
            controller.enqueue(part);
            offset += count;
            if (offset > end) {
              controller.close();
              release();
            }
          } catch (error) {
            controller.error(error);
            release();
          } finally {
            reading = false;
            if (signal.aborted) release();
          }
        },
        cancel() { lifetime.abort(); },
      }, { highWaterMark: 0 });
      const response = new Response(body, { status: range ? 206 : 200, headers: {
        ...privateHeaders, "accept-ranges": "bytes", "content-type": file.mime,
        "content-length": String(end - start + 1),
        ...(range ? { "content-range": `bytes ${start}-${end}/${file.size}` } : {}),
      } });
      signal.addEventListener("abort", onEnd, { once: true });
      streaming = true;
      return response;
    } catch {
      return new Response(null, { status: 409, headers: privateHeaders });
    } finally {
      if (!streaming) release();
    }
  }, { auth: "local" });

  bb.http.route("GET", route, async (context) => {
    const token = context.req.query("ticket") ?? "";
    const ticket = tickets.get(token);
    if (!ticket || ticket.expires <= now() || session() !== ticket.current || ticket.current.status().state !== "ready") {
      tickets.delete(token);
      return new Response(null, { status: 404, headers: privateHeaders });
    }
    if (inFlight >= 2) return new Response(null, { status: 429, headers: { ...privateHeaders, "retry-after": "1" } });
    tickets.delete(token);
    const transfer = new AbortController();
    transfers.add(transfer);
    const signal = AbortSignal.any([context.req.raw.signal, transfer.signal]);
    const active = () => !signal.aborted && session() === ticket.current && ticket.current.status().state === "ready";
    let streaming = false;
    inFlight++;
    try {
      await waitForCacheCleanup(signal);
      if (!active()) return new Response(null, { status: 409, headers: privateHeaders });
      if ("chatId" in ticket && ticket.oneView) {
        const copy = await ticket.current.openOneView(ticket.chatId, ticket.messageId, signal);
        if (!active()) {
          return new Response(null, { status: 409, headers: privateHeaders });
        }
        return new Response(new Uint8Array(copy.bytes), { headers: {
          ...privateHeaders, "content-type": copy.mime, "content-length": String(copy.bytes.length),
        } });
      }
      const { name, body, size } = "load" in ticket
        ? await ticket.load(signal)
        : ticket.attachment
        ? await ticket.current.document(ticket.chatId, ticket.messageId, signal, ticket.playback, ticket.attachment)
        : ticket.playback ? await ticket.current.document(ticket.chatId, ticket.messageId, signal, true)
          : await ticket.current.document(ticket.chatId, ticket.messageId, signal);
      if (!active()) {
        await body?.cancel();
        return new Response(null, { status: 409, headers: privateHeaders });
      }
      const encoded = encodeURIComponent(name).replace(/['()*]/g, (c) => "%" + c.charCodeAt(0).toString(16));
      const guard = new TransformStream<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>({
        transform(chunk, controller) {
          if (!active()) throw new Error("Telegram document transfer ended.");
          controller.enqueue(chunk);
        },
      });
      const response = new Response(body ? guard.readable : null, { headers: {
        ...privateHeaders,
        "content-type": "application/octet-stream",
        "content-disposition": `attachment; filename="telegram-document"; filename*=UTF-8''${encoded}`,
        "content-length": String(size),
      } });
      if (body) {
        streaming = true;
        void body.pipeTo(guard.writable, { signal }).catch(() => {}).finally(() => transfers.delete(transfer));
      }
      return response;
    } catch {
      return new Response(null, { status: 409, headers: privateHeaders });
    } finally {
      if (!streaming) transfers.delete(transfer);
      inFlight--;
    }
  }, { auth: "local" });

  function issueDocumentTicket(name: string, entry: DocumentSource) {
    if (session() !== entry.current || entry.current.status().state !== "ready") throw new Error("Telegram session changed.");
    const issuedAt = now();
    for (const [token, ticket] of tickets) if (ticket.expires <= issuedAt) tickets.delete(token);
    if (tickets.size >= 64) tickets.delete(tickets.keys().next().value!);
    const ticket = randomBytes(32).toString("base64url");
    tickets.set(ticket, { ...entry, expires: issuedAt + documentLifetime });
    return { name, url: `/api/v1/plugins/${bb.pluginId}/http${route}?ticket=${ticket}` };
  }

  return {
    cleanCache,
    async withCacheTransfer<T>(work: (signal: AbortSignal) => Promise<T>, outerSignal?: AbortSignal): Promise<T | undefined> {
      const transfer = new AbortController();
      const signal = outerSignal ? AbortSignal.any([outerSignal, transfer.signal]) : transfer.signal;
      if (signal.aborted) return;
      transfers.add(transfer);
      try {
        await waitForCacheCleanup(signal);
        if (!signal.aborted) return await work(signal);
      } finally {
        transfers.delete(transfer);
      }
    },
    async issue(current: Session, chatId: string, messageId: string, playback = false, oneView = false, attachment?: RichAttachmentReference, playbackFileId?: number) {
      if (playbackFileId !== undefined) {
        const name = await current.documentName(chatId, messageId, true, undefined, playbackFileId);
        return issueDocumentTicket(name, { current,
          load: (signal) => current.document(chatId, messageId, signal, true, undefined, playbackFileId) });
      }
      const name = oneView ? "Telegram one-view media" : attachment ? await current.documentName(chatId, messageId, playback, attachment)
        : playback ? await current.documentName(chatId, messageId, true) : await current.documentName(chatId, messageId);
      return issueDocumentTicket(name, { current, chatId, messageId, playback, oneView, attachment });
    },
    async issuePhotoDrag(current: PhotoDragSession, chatId: string, messageId: string) {
      const { id, name } = await current.photoDragReference(chatId, messageId);
      return { ...issueDocumentTicket(name, { current, load: (signal) => current.photoDragDocument(chatId, messageId, id, signal) }),
        validForMs: documentLifetime };
    },
    async issuePollDocument(current: Session & Pick<ReturnType<typeof createTelegram>, "pollDocument" | "pollDocumentName">,
      chatId: string, messageId: string, reference: PollAttachmentReference) {
      const name = await current.pollDocumentName(chatId, messageId, reference);
      return issueDocumentTicket(name, { current, load: (signal) => current.pollDocument(chatId, messageId, reference, signal) });
    },
    issuePollPlayback(current: VideoSource & Pick<ReturnType<typeof createTelegram>, "pollPlaybackReference">,
      chatId: string, messageId: string, reference: PollAttachmentReference) {
      return issueVideoTicket(current, () => current.pollPlaybackReference(chatId, messageId, reference));
    },
    async issueArticleDocument(current: ArticleDocumentSession, articleUrl: string, fileId: number) {
      const name = await current.instantViewDocumentName(articleUrl, fileId);
      return issueDocumentTicket(name, { current, load: (signal) => current.instantViewDocument(articleUrl, fileId, signal) });
    },
    async issueQuickReplyDocument(current: ShortcutDocumentSession, shortcutId: number, messageId: number, fileId: number,
      pollSlot?: PollAttachmentReference["slot"]) {
      const slot = pollSlot === undefined ? [] as const : [pollSlot] as const;
      const name = await current.quickReplyDocumentName(shortcutId, messageId, fileId, ...slot);
      return issueDocumentTicket(name, { current,
        load: (signal) => current.quickReplyDocument(shortcutId, messageId, fileId, signal, ...slot) });
    },
    async issueWelcomeDocument(current: WelcomeDocumentSession, chatId: string, messageId: number,
      revision: string, attachment?: RichAttachmentReference) {
      const reference = attachment ? [attachment] as const : [] as const;
      const name = await current.chatWelcomeDocumentName(chatId, messageId, revision, ...reference);
      return issueDocumentTicket(name, { current, load: (signal) => current.chatWelcomeDocument(chatId, messageId, revision, signal, ...reference) });
    },
    issueVideo(current: VideoSession, chatId: string, messageId: string, attachment?: RichAttachmentReference, motionFileId?: number, playbackFileId?: number) {
      const resolve = () => motionFileId === undefined
        ? current.videoReference(chatId, messageId, ...(attachment ? [attachment] : []))
        : current.videoReference(chatId, messageId, attachment, motionFileId);
      return issueVideoTicket(current, resolve, async () => {
        const file = await resolve();
        if (playbackFileId !== undefined && file.id !== playbackFileId) throw new Error("Media changed.");
        return file;
      });
    },
    issueVideoQuality(current: VideoSource & Pick<ReturnType<typeof createTelegram>, "videoQualityReference">,
      chatId: string, messageId: string, fileId: number, playbackFileId?: number) {
      return issueVideoTicket(current, () => current.videoQualityReference(chatId, messageId, fileId,
        ...(playbackFileId === undefined ? [] : [playbackFileId])));
    },
    issueMessagePreviewPlayback(current: VideoSource & Pick<ReturnType<typeof createTelegram>, "messagePreviewPlaybackReference">,
      chatId: string, messageId: string, fileId: number) {
      return issueVideoTicket(current, () => current.messagePreviewPlaybackReference(chatId, messageId, fileId));
    },
    issueArticlePlayback(current: VideoSource & Pick<ReturnType<typeof createTelegram>, "instantViewPlaybackReference">, url: string, fileId: number) {
      return issueVideoTicket(current, () => current.instantViewPlaybackReference(url, fileId),
        () => current.instantViewPlaybackReference(url, fileId, true));
    },
    issueStoryVideo(current: VideoSource & Pick<ReturnType<typeof createTelegram>, "storyVideoReference">,
      chatId: string, story: number, expectedFileId: number) {
      return issueVideoTicket(current, async () => {
        const file = await current.storyVideoReference(chatId, story);
        if (file.id !== expectedFileId) throw new Error("The story video changed.");
        return file;
      });
    },
    issueStoryMusic(current: VideoSource & Pick<ReturnType<typeof createTelegram>, "storyMusicReference">,
      chatId: string, story: number, fileId: number) {
      return issueVideoTicket(current, () => current.storyMusicReference(chatId, story, fileId));
    },
    issueProfileAudio(current: VideoSource & Pick<ReturnType<typeof createTelegram>, "profileAudioReference">,
      chatId: string, index: number, fileId: number) {
      return issueVideoTicket(current, () => current.profileAudioReference(chatId, index, fileId));
    },
    issueCommunityAvatarVideo(current: VideoSource & Pick<ReturnType<typeof createTelegram>, "communityAvatarVideoReference">,
      id: string, photoId: string, fileId: number) {
      return issueVideoTicket(current, () => current.communityAvatarVideoReference(id, photoId, fileId));
    },
    issueProfilePhotoVideo(current: VideoSource & Pick<ReturnType<typeof createTelegram>, "profilePhotoVideoReference">,
      id: string | undefined, offset: number, photoId: string, fileId: number) {
      return issueVideoTicket(current, () => current.profilePhotoVideoReference(id, offset, photoId, fileId));
    },
    issueQuickReplyPlayback(current: VideoSource & Pick<ReturnType<typeof createTelegram>, "quickReplyPlaybackReference">,
      shortcutId: number, messageId: number, fileId: number, pollSlot?: PollAttachmentReference["slot"]) {
      return issueVideoTicket(current, () => current.quickReplyPlaybackReference(shortcutId, messageId, fileId, pollSlot));
    },
    issueWelcomePlayback(current: VideoSource & Pick<ReturnType<typeof createTelegram>, "chatWelcomePlaybackReference">,
      chatId: string, messageId: number, revision: string, attachment?: RichAttachmentReference) {
      const reference = attachment ? [attachment] as const : [] as const;
      return issueVideoTicket(current, () => current.chatWelcomePlaybackReference(chatId, messageId, revision, ...reference));
    },
    clear() {
      tickets.clear();
      for (const transfer of transfers) transfer.abort();
      transfers.clear();
      for (const token of videos.keys()) revokeVideo(token);
    },
  };
}
