import { createHash, randomBytes } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { documentDeliveryTimeoutMs, type ForumTopicTarget, type MediaSendOptions, type SendResult } from "../../core/contract.ts";
import type { createTelegram } from "./telegram.ts";

type Session = Pick<ReturnType<typeof createTelegram>, "status" | "sendDocumentStream">;
type Upload = { id: string; name: string; caption: string; size: number; topic?: ForumTopicTarget; replyTo?: string; video?: true; options?: MediaSendOptions };
type Ticket = Upload & {
  current: Session;
  timer?: ReturnType<typeof setTimeout>;
  writer?: WritableStreamDefaultWriter<Uint8Array>;
  offset: number;
  lastChunk?: { offset: number; hash: string };
  busy: boolean;
  sealed?: boolean;
  outcome?: SendResult;
  cancelled: boolean;
};
const route = "/document-upload";
const maxEncodedChunk = 699052;
const maxRequestBytes = maxEncodedChunk + 128;
const tooLarge = Symbol("upload chunk too large");
const chunkSchema = z.object({
  offset: z.number().int().nonnegative(),
  base64: z.string().min(4).max(maxEncodedChunk).regex(/^[A-Za-z0-9+/]+={0,2}$/),
}).strict();

async function readChunk(request: Request): Promise<unknown> {
  const length = request.headers.get("content-length");
  if (length !== null && Number(length) > maxRequestBytes) {
    await request.body?.cancel().catch(() => {});
    return tooLarge;
  }
  const reader = request.body?.getReader();
  if (!reader) return;
  const buffer = Buffer.allocUnsafe(maxRequestBytes);
  let used = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (used + value.byteLength > buffer.length) {
        await reader.cancel().catch(() => {});
        return tooLarge;
      }
      buffer.set(value, used);
      used += value.byteLength;
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, used)));
  } catch {
    return;
  } finally {
    reader.releaseLock();
  }
}

export function registerDocumentUploads(bb: Pick<BbPluginApi, "http" | "pluginId">, session: () => Session | undefined) {
  const tickets = new Map<string, Ticket>();
  function remove(token: string, ticket: Ticket, cancel: boolean) {
    clearTimeout(ticket.timer);
    tickets.delete(token);
    if (cancel) {
      ticket.cancelled = true;
      void ticket.writer?.abort().catch(() => {});
    }
  }
  function refresh(token: string, ticket: Ticket, timeoutMs = 60_000) {
    clearTimeout(ticket.timer);
    ticket.timer = setTimeout(() => remove(token, ticket, true), timeoutMs);
    ticket.timer.unref?.();
  }

  bb.http.route("GET", route, (context) => {
    const token = context.req.query("ticket") ?? "";
    const ticket = tickets.get(token);
    context.header("Cache-Control", "no-store");
    if (!ticket?.sealed || ticket.cancelled || session() !== ticket.current) return context.json({ state: "unknown" }, 404);
    return context.json(ticket.outcome ?? { state: "pending" });
  }, { auth: "local" });

  bb.http.route("DELETE", route, (context) => {
    const token = context.req.query("ticket") ?? "";
    const ticket = tickets.get(token);
    if (!ticket || session() !== ticket.current) return context.json({ cancelled: false }, 404);
    if (ticket.sealed) return context.json({ cancelled: false }, 409);
    remove(token, ticket, true);
    return context.json({ cancelled: true });
  }, { auth: "local" });

  bb.http.route("POST", route, async (context) => {
    const token = context.req.query("ticket") ?? "";
    const ticket = tickets.get(token);
    const active = () => !!ticket && !ticket.cancelled && session() === ticket.current && ticket.current.status().state === "ready";
    if (!ticket || !active()) return context.json({ state: "failed" }, 404);
    if (ticket.busy) return context.json({ retry: true }, 409);
    ticket.busy = true;
    let complete = ticket.sealed === true;
    try {
      const raw = await readChunk(context.req.raw);
      if (raw === tooLarge) return context.json({ state: "failed" }, 413);
      const input = chunkSchema.safeParse(raw);
      if (!input.success) return context.json({ state: "failed" }, 400);
      const bytes = Buffer.from(input.data.base64, "base64");
      const next = input.data.offset + bytes.length;
      if (!bytes.length || bytes.length > 512 * 1024 || next > ticket.size || bytes.toString("base64") !== input.data.base64 || !active()) {
        return context.json({ state: "failed" }, 400);
      }
      const hash = createHash("sha256").update(bytes).digest("hex");
      if (input.data.offset === ticket.lastChunk?.offset && hash === ticket.lastChunk.hash) {
        complete = true;
        if (!ticket.sealed) refresh(token, ticket);
        return context.json({ received: ticket.offset }, ticket.sealed ? 202 : 200);
      }
      if (ticket.sealed) return context.json({ state: "failed" }, 404);
      if (input.data.offset !== ticket.offset) return context.json({ state: "failed" }, 400);
      refresh(token, ticket);
      if (!ticket.writer) {
        const stream = new TransformStream<Uint8Array>();
        const writer = stream.writable.getWriter();
        ticket.writer = writer;
        const videoArgs: [video?: true, options?: MediaSendOptions] = ticket.video
          ? ticket.options ? [true, ticket.options] : [true] : [];
        void ticket.current.sendDocumentStream(ticket.id, ticket.name, ticket.caption, ticket.size, stream.readable, active, ticket.topic, ticket.replyTo, ...videoArgs)
          .catch((): SendResult => ({ state: "unknown" }))
          .then((outcome) => {
            if (ticket.cancelled) return;
            ticket.outcome = outcome;
            if (ticket.sealed) refresh(token, ticket);
            else void writer.abort().catch(() => {});
          });
      }
      await ticket.writer.write(bytes);
      if (ticket.outcome) return context.json(ticket.outcome);
      if (!active()) return context.json({ state: "failed" }, 409);
      ticket.lastChunk = { offset: input.data.offset, hash };
      ticket.offset = next;
      if (next < ticket.size) {
        complete = true;
        return context.json({ received: next });
      }
      ticket.sealed = true;
      refresh(token, ticket, documentDeliveryTimeoutMs + 60_000);
      await ticket.writer.close();
      complete = true;
      return context.json({ received: next }, 202);
    } catch {
      return context.json(ticket.outcome ?? { state: "unknown" }, ticket.outcome ? 200 : 502);
    } finally {
      ticket.busy = false;
      if (!complete) remove(token, ticket, true);
    }
  }, { auth: "local" });

  return {
    issue(current: Session, input: Upload) {
      if (tickets.size >= 32) throw new Error("Too many document uploads.");
      const token = randomBytes(32).toString("base64url");
      const ticket: Ticket = { ...input, current, offset: 0, busy: false, cancelled: false };
      tickets.set(token, ticket);
      refresh(token, ticket);
      return { url: `/api/v1/plugins/${bb.pluginId}/http${route}?ticket=${token}` };
    },
    clear() { for (const [token, ticket] of tickets) remove(token, ticket, true); },
  };
}
