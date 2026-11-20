import { randomBytes } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { StoryView } from "../../core/contract.ts";
import type { createTelegram } from "./telegram.ts";

type Session = Pick<ReturnType<typeof createTelegram>, "status" | "storyMediaReference" | "storyMedia">;
const route = "/story-media";
const headers = { "cache-control": "no-store", "x-content-type-options": "nosniff" };

export function registerStoryMedia<Current extends Session>(
  bb: Pick<BbPluginApi, "http" | "pluginId">, session: () => Current | undefined, now = Date.now,
  streamVideo?: (current: Current, id: string, story: number, fileId: number) => Promise<string>,
) {
  const tickets = new Map<string, { current: Session; id: string; story: number; expires: number; abort: AbortController }>();

  function revoke(token: string) {
    const ticket = tickets.get(token);
    tickets.delete(token);
    ticket?.abort.abort();
  }

  bb.http.route("GET", route, async (context) => {
    const token = context.req.query("ticket") ?? "";
    const ticket = tickets.get(token);
    if (!ticket || ticket.expires <= now() || session() !== ticket.current || ticket.current.status().state !== "ready") {
      if (ticket) revoke(token);
      return new Response(null, { status: 404, headers });
    }
    const signal = AbortSignal.any([context.req.raw.signal, ticket.abort.signal]);
    const active = () => !signal.aborted && session() === ticket.current && ticket.current.status().state === "ready";
    try {
      const file = await ticket.current.storyMedia(ticket.id, ticket.story, signal);
      if (!active()) {
        await file.body?.cancel();
        return new Response(null, { status: 409, headers });
      }
      const body = file.body?.pipeThrough(new TransformStream<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>({
        transform(chunk, controller) {
          if (!active()) throw new Error("Story media session ended.");
          controller.enqueue(chunk);
        },
      }), { signal });
      return new Response(body, { headers: {
        ...headers, "content-type": file.mime, "content-length": String(file.size),
      } });
    } catch {
      return new Response(null, { status: 409, headers });
    }
  }, { auth: "local" });

  return {
    async issue(current: Current, id: string, story: number): Promise<StoryView> {
      const { kind, fileId, videoSize, music, repost, caption, captionLinks, captionStyles, captionEmoji, links, reaction, customReaction, canDelete, canReply, canEditCaption, editableAudience, profileVisibility, counts, canGetInteractions, canCopyLink } = await current.storyMediaReference(id, story);
      if (session() !== current || current.status().state !== "ready") throw new Error("Telegram session changed.");
      const view = { kind, music, repost, caption, captionLinks, captionStyles, captionEmoji, links, reaction, customReaction,
        canDelete, canReply, canEditCaption, editableAudience, profileVisibility, counts, canGetInteractions, canCopyLink };
      if (kind === "video" && videoSize && streamVideo) {
        return { ...view, url: await streamVideo(current, id, story, fileId) };
      }
      const time = now();
      for (const [ticket, value] of tickets) if (value.expires <= time) revoke(ticket);
      if (tickets.size >= 32) revoke(tickets.keys().next().value!);
      const ticket = randomBytes(32).toString("base64url");
      tickets.set(ticket, { current, id, story, expires: time + 10 * 60_000, abort: new AbortController() });
      return { ...view, url: `/api/v1/plugins/${bb.pluginId}/http${route}?ticket=${ticket}` };
    },
    clear() { for (const token of tickets.keys()) revoke(token); },
  };
}
