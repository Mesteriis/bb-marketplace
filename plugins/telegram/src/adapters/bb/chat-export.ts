import { randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { ChannelInboxSelection, ChatExportOptions } from "../../core/contract.ts";
import type { Message } from "../../core/demo.ts";
import { richMessageHtml, type RichHtmlAttachment } from "../../core/rich-message-text.ts";
import type { createTelegram } from "./telegram.ts";

type Session = Pick<ReturnType<typeof createTelegram>, "status" | "chatExportSource" | "chatExportPredecessor" | "chatExportPage" | "accountExportSources"
  | "document" | "formattedArchiveLayout" | "formattedArchiveDocument" | "channelInboxArchiveSource" | "channelInboxDocument"
  | "accountExportAudio" | "accountExportTrack">;
const route = "/chat-export";
const headers = { "cache-control": "no-store", "x-content-type-options": "nosniff" };
const encode = new TextEncoder();

function escapeHtml(text: string) {
  return text.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
}

function archivePath(id: string, name: string, prefixLength: number) {
  const base = `media/${id}-`;
  return base + (name.replace(/[^A-Za-z0-9_.-]/g, "_") || "attachment").slice(-(99 - prefixLength - base.length));
}

function tarHeader(name: string, size: number) {
  if (Buffer.byteLength(name) >= 100 || !Number.isSafeInteger(size) || size < 0 || size > 0o77777777777) {
    throw new Error("Invalid TAR member.");
  }
  const data = Buffer.alloc(512);
  data.write(name, 0, 100, "ascii");
  data.write("0000600\0", 100, "ascii");
  data.write("0000000\0", 108, "ascii");
  data.write("0000000\0", 116, "ascii");
  data.write(`${size.toString(8).padStart(11, "0")}\0`, 124, "ascii");
  data.write("00000000000\0", 136, "ascii");
  data.fill(32, 148, 156);
  data.write("0", 156, "ascii");
  data.write("ustar\0", 257, "ascii");
  data.write("00", 263, "ascii");
  const checksum = data.reduce((sum, byte) => sum + byte, 0);
  data.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, "ascii");
  return new Uint8Array(data);
}

function tarPadding(size: number) {
  return new Uint8Array((512 - size % 512) % 512);
}

function messageEntry(id: string, message?: Message, media?: { path: string; name: string }, unavailable = false) {
  if (!message) return { id, withheld: true as const };
  const { timestamp, author, text, outgoing, replyTo, forumTopicId, albumId, forwardedFrom,
    photoCaption, document, location, contact, poll } = message;
  const attachment = document ? { name: document.name, size: document.sizeBytes, ...media } : media;
  return { id, timestamp, author, text: photoCaption ?? document?.caption ?? text, outgoing, replyTo, forumTopicId,
    albumId, forwardedFrom, location, contact, poll, attachment, ...(unavailable && { attachmentUnavailable: true }) };
}

function htmlEntry(entry: ReturnType<typeof messageEntry>) {
  if ("withheld" in entry) return "<article><p>Protected message</p></article>\n";
  const time = entry.timestamp ? `<time>${new Date(entry.timestamp * 1000).toISOString()}</time>` : "";
  const file = entry.attachment?.path ? `<p><a href="${escapeHtml(entry.attachment.path)}">${escapeHtml(entry.attachment.name)}</a></p>`
    : entry.attachmentUnavailable ? "<p>Attachment unavailable</p>" : "";
  const details = [
    entry.location && [entry.location.place?.title, entry.location.place?.address,
      `${entry.location.latitude}, ${entry.location.longitude}`].filter(Boolean).join(" · "),
    entry.contact && [entry.contact.firstName, entry.contact.lastName, entry.contact.phone].filter(Boolean).join(" "),
    entry.poll && entry.poll.options.map((option) => option.text).join(" · "),
  ].filter(Boolean).map((line) => `<p>${escapeHtml(String(line))}</p>`).join("");
  return `<article><strong>${escapeHtml(entry.author)}</strong> ${time}<p>${escapeHtml(entry.text)}</p>${details}${file}</article>\n`;
}

export function registerChatExports(bb: Pick<BbPluginApi, "http" | "pluginId">, session: () => Session | undefined, now = Date.now) {
  type Source = { id: string; title: string };
  type Selection = { ids: string[]; inbox?: Omit<ChannelInboxSelection, "ids"> };
  type Ticket = { current: Session; source?: Source; options: ChatExportOptions; selection?: Selection; expires: number };
  const tickets = new Map<string, Ticket>();
  const running = new Set<AbortController>();

  function fileName(ticket: Pick<Ticket, "source" | "options" | "selection">) {
    if (ticket.selection) return ticket.options.format === "html" ? "telegram-messages.tar" : "telegram-attachments.tar";
    if (!ticket.source) return "telegram-account.tar";
    const { media, format } = ticket.options;
    return `telegram-history.${media ? "tar" : format}`;
  }

  function validate(ticket: Ticket, signal: AbortSignal) {
    signal.throwIfAborted();
    if (session() !== ticket.current || ticket.current.status().state !== "ready") throw new Error("Telegram session changed.");
  }

  async function* fileMember(ticket: Ticket, signal: AbortSignal, path: string,
    download: Awaited<ReturnType<Session["document"]>>,
  ): AsyncGenerator<Uint8Array<ArrayBuffer>, void> {
    if (!download.body) throw new Error("Attachment was unavailable.");
    const reader = download.body.getReader();
    const abortRead = () => { void reader.cancel().catch(() => {}); };
    signal.addEventListener("abort", abortRead, { once: true });
    try {
      validate(ticket, signal);
      yield tarHeader(path, download.size);
      let written = 0;
      for (;;) {
        validate(ticket, signal);
        const chunk = await reader.read();
        if (chunk.done) break;
        written += chunk.value.byteLength;
        if (written > download.size) throw new Error("Attachment changed during export.");
        yield new Uint8Array(chunk.value);
      }
      validate(ticket, signal);
      if (written !== download.size) throw new Error("Attachment was incomplete.");
      yield tarPadding(written);
    } finally {
      signal.removeEventListener("abort", abortRead);
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }

  async function* profileMusicContent(ticket: Ticket, signal: AbortSignal) {
    const tracks: { title: string; performer: string; path?: string; unavailable?: true }[] = [];
    const extensions = { "audio/ogg": "ogg", "audio/mpeg": "mp3", "audio/mp4": "m4a", "audio/wav": "wav", "audio/flac": "flac" };
    let offset: number | null = 0;
    let available = true;
    while (offset !== null) {
      validate(ticket, signal);
      const page: Awaited<ReturnType<Session["accountExportAudio"]>> = await ticket.current.accountExportAudio(offset, signal);
      validate(ticket, signal);
      if (!page) { available = false; break; }
      for (const { index, fileId, title, performer, mime } of page.tracks) {
        const entry: (typeof tracks)[number] = { title, performer };
        tracks.push(entry);
        if (!ticket.options.media) continue;
        validate(ticket, signal);
        const download = mime ? await ticket.current.accountExportTrack(index, fileId, signal).catch(() => undefined) : undefined;
        validate(ticket, signal);
        if (!download?.body || !mime) { entry.unavailable = true; continue; }
        const name = `track-${index + 1}.${extensions[mime]}`;
        yield* fileMember(ticket, signal, `profile-music/${name}`, download);
        entry.path = name;
      }
      if (page.next !== null && page.next <= offset) throw new Error("Profile music export did not advance.");
      offset = page.next;
    }
    const { format } = ticket.options;
    const index = encode.encode(format === "json" ? JSON.stringify({ available, tracks }, null, 2) + "\n"
      : `<!doctype html><meta charset="utf-8"><title>Profile music</title><h1>Profile music</h1>${available ? "" : "<p>Profile music is unavailable.</p>"}<ol>${tracks.map(({ title, performer, path, unavailable }) => {
        const label = escapeHtml(performer ? `${title} · ${performer}` : title);
        return `<li>${path ? `<a href="${escapeHtml(path)}">${label}</a>` : label}${unavailable ? " (audio unavailable)" : ""}</li>`;
      }).join("")}</ol>`);
    yield tarHeader(`profile-music/index.${format}`, index.byteLength);
    yield index;
    yield tarPadding(index.byteLength);
  }

  async function* chatContent(ticket: Ticket, source: Source, signal: AbortSignal, prefix = ""): AsyncGenerator<Uint8Array<ArrayBuffer>, void> {
    const { options, current } = ticket;
    const { id: chatId, title } = source;
    const folder = options.media || prefix ? await mkdtemp(join(tmpdir(), "makosh-telegram-export-")) : undefined;
    const name = `history.${options.format}`;
    try {
      const indexPath = folder && join(folder, name);
      const index = indexPath ? await open(indexPath, "wx", 0o600) : undefined;
      let first = true;
      const json = options.format === "json";
      const start = json
        ? `{"chat":${JSON.stringify(title)},"order":"newest-first","messages":[\n`
        : `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(title)}</title><style>body{margin:2rem auto;padding:0 1rem;max-width:52rem;font:16px system-ui}article{border-block-end:1px solid #bbb;padding-block:1rem}p{white-space:pre-wrap;overflow-wrap:anywhere}</style></head><body><h1>${escapeHtml(title)}</h1>\n`;
      try {
        if (index) await index.writeFile(start);
        else yield encode.encode(start);
        const prior = await current.chatExportPredecessor(chatId, signal);
        validate(ticket, signal);
        const sources = [{ id: chatId, through: undefined }, ...(prior ? [prior] : [])];
        for (const { id: sourceId, through } of sources) {
          const predecessor = through === undefined ? undefined : { successor: chatId, through };
          let before = 0;
          for (;;) {
            validate(ticket, signal);
            const page = await current.chatExportPage(sourceId, before, signal, options.range, predecessor);
            validate(ticket, signal);
            for (const { id, message } of page.messages) {
              validate(ticket, signal);
              let file: { path: string; name: string } | undefined;
              let unavailable = false;
              if (options.media && message && (message.canSavePhoto || message.document?.downloadable)) {
                let download;
                if (predecessor) await current.chatExportSource(chatId, signal);
                try { download = await current.document(sourceId, id, signal); }
                catch { validate(ticket, signal); unavailable = true; }
                if (download?.body) {
                  const path = archivePath(predecessor ? `legacy-${id}` : id, download.name, prefix.length);
                  yield* fileMember(ticket, signal, prefix + path, download);
                  file = { path, name: download.name };
                } else unavailable = true;
              }
              const entry = messageEntry(id, message, file, unavailable);
              const row = json ? `${first ? "" : ",\n"}${JSON.stringify(predecessor ? { ...entry, sourceChatId: sourceId } : entry)}` : htmlEntry(entry);
              first = false;
              if (index) await index.writeFile(row);
              else yield encode.encode(row);
            }
            if (page.before === null) break;
            if (before && page.before >= before) throw new Error("Telegram export cursor did not advance.");
            before = page.before;
          }
        }
        const end = json ? "\n]}\n" : "</body></html>\n";
        if (index) await index.writeFile(end);
        else yield encode.encode(end);
      } finally { await index?.close(); }
      if (indexPath) {
        validate(ticket, signal);
        const manifest = await open(indexPath, "r");
        try {
          const { size } = await manifest.stat();
          yield tarHeader(prefix + name, size);
          for await (const part of createReadStream(indexPath, { signal })) {
            validate(ticket, signal);
            yield new Uint8Array(part);
          }
          yield tarPadding(size);
        } finally { await manifest.close(); }
      }
    } finally { if (folder) await rm(folder, { recursive: true, force: true }); }
  }

  async function* formattedContent(ticket: Ticket, source: Source, selection: Selection, signal: AbortSignal) {
    const { current } = ticket;
    const { inbox } = selection;
    const rows = [];
    for (const id of [...selection.ids].sort((a, b) => Number(a) - Number(b))) {
      validate(ticket, signal);
      const layout = await current.formattedArchiveLayout(source.id, id, signal, inbox);
      if (!layout) throw new Error("A selected formatted message is unavailable.");
      rows.push({ id, layout });
    }
    const contents: string[] = [];
    for (const { id, layout } of rows) {
      const files = new Map<number, RichHtmlAttachment>();
      for (const block of layout.blocks) {
        if ((block.kind !== "photo" && block.kind !== "document") || block.spoiler || block.reference.paid
          || block.kind === "document" && !block.document.downloadable || files.has(block.reference.index)) continue;
        validate(ticket, signal);
        const download = await current.formattedArchiveDocument(source.id, id, block.reference, signal, inbox).catch(() => undefined);
        validate(ticket, signal);
        if (!download?.body) continue;
        const path = archivePath(`${id}-${block.reference.index}`, download.name, 0);
        yield* fileMember(ticket, signal, path, download);
        files.set(block.reference.index, { path, name: download.name });
      }
      contents.push(`<article>${richMessageHtml(layout, true, files)}</article>`);
    }
    validate(ticket, signal);
    const html = encode.encode('<!doctype html><meta charset="utf-8">'
      + '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; base-uri \'none\'; form-action \'none\'">'
      + '<title>Telegram messages</title>' + contents.join(""));
    yield tarHeader("messages.html", html.byteLength);
    yield html;
    yield tarPadding(html.byteLength);
    yield new Uint8Array(1024);
  }

  async function* content(ticket: Ticket, signal: AbortSignal): AsyncGenerator<Uint8Array<ArrayBuffer>, void> {
    if (ticket.source && ticket.selection) {
      if (ticket.options.format === "html") {
        yield* formattedContent(ticket, ticket.source, ticket.selection, signal);
        return;
      }
      const entries: { id: string; file?: string; originalName?: string; unavailable?: true }[] = [];
      const { ids, inbox } = ticket.selection;
      for (const id of ids) {
        validate(ticket, signal);
        const download = await (inbox
          ? ticket.current.channelInboxDocument({ ...inbox, messageId: id }, signal)
          : ticket.current.document(ticket.source.id, id, signal)).catch(() => undefined);
        if (!download?.body) {
          validate(ticket, signal);
          entries.push({ id, unavailable: true });
          continue;
        }
        const file = archivePath(id, download.name, 0);
        yield* fileMember(ticket, signal, file, download);
        entries.push({ id, file, originalName: download.name });
      }
      const index = encode.encode(JSON.stringify({ attachments: entries }, null, 2) + "\n");
      yield tarHeader("index.json", index.byteLength);
      yield index;
      yield tarPadding(index.byteLength);
      yield new Uint8Array(1024);
      return;
    }
    if (ticket.source) {
      yield* chatContent(ticket, ticket.source, signal);
      if (ticket.options.media) yield new Uint8Array(1024);
      return;
    }
    validate(ticket, signal);
    const { chats, skipped } = await ticket.current.accountExportSources(signal);
    validate(ticket, signal);
    const format = ticket.options.format;
    const entries = chats.map(({ id, title }) => ({ id, title, path: `chats/${id}/history.${format}` }));
    const music = ticket.options.profileMusic ? `profile-music/index.${format}` : undefined;
    const index = encode.encode(format === "json"
      ? JSON.stringify({ chats: entries, skippedChats: skipped, ...(music && { profileMusic: music }) }, null, 2) + "\n"
      : `<!doctype html><meta charset="utf-8"><title>Telegram account export</title><h1>Telegram account export</h1>${skipped ? `<p>Protected chats omitted: ${skipped}</p>` : ""}<ul>${entries.map(({ title, path }) =>
        `<li><a href="${escapeHtml(path)}">${escapeHtml(title)}</a></li>`).join("")}</ul>${music ? `<p><a href="${music}">Profile music</a></p>` : ""}`);
    yield tarHeader(`index.${format}`, index.byteLength);
    yield index;
    yield tarPadding(index.byteLength);
    for (const source of chats) {
      validate(ticket, signal);
      yield* chatContent(ticket, source, signal, `chats/${source.id}/`);
    }
    if (music) yield* profileMusicContent(ticket, signal);
    yield new Uint8Array(1024);
  }

  bb.http.route("GET", route, (context) => {
    const token = context.req.query("ticket") ?? "";
    const ticket = tickets.get(token);
    tickets.delete(token);
    if (!ticket || ticket.expires <= now() || session() !== ticket.current || ticket.current.status().state !== "ready") {
      return new Response(null, { status: 404, headers });
    }
    if (running.size >= 2) return new Response(null, { status: 429, headers });
    const lifetime = new AbortController();
    running.add(lifetime);
    const signal = AbortSignal.any([context.req.raw.signal, lifetime.signal]);
    const iterator = content(ticket, signal);
    let ended = false;
    let cleanup: Promise<unknown> | undefined;
    const exportError = () => new Error("Telegram export did not complete.");
    function release() {
      running.delete(lifetime);
      signal.removeEventListener("abort", abort);
    }
    function stop() {
      ended = true;
      return cleanup ??= iterator.return().catch(() => {}).finally(release);
    }
    let controller: ReadableStreamDefaultController<Uint8Array<ArrayBuffer>>;
    function abort() {
      if (ended) return;
      controller.error(exportError());
      void stop();
    }
    const stream = new ReadableStream<Uint8Array<ArrayBuffer>>({
      start(active) {
        controller = active;
        if (signal.aborted) abort();
        else signal.addEventListener("abort", abort, { once: true });
      },
      async pull(active) {
        try {
          const next = await iterator.next();
          if (ended) return;
          if (next.done) {
            ended = true;
            release();
            active.close();
          } else active.enqueue(next.value);
        } catch {
          if (ended) return;
          ended = true;
          release();
          active.error(exportError());
        }
      },
      async cancel() {
        const closing = stop();
        lifetime.abort();
        await closing;
      },
    }, { highWaterMark: 0 });
    return new Response(stream, { headers: {
      ...headers,
      "content-type": !ticket.source || ticket.selection || ticket.options.media ? "application/x-tar" : ticket.options.format === "json"
        ? "application/json; charset=utf-8" : "text/html; charset=utf-8",
      "content-disposition": `attachment; filename="${fileName(ticket)}"`,
    } });
  }, { auth: "local" });

  function issueTicket(current: Session, source: Source | undefined, options: ChatExportOptions, selection?: Selection) {
    if (session() !== current || current.status().state !== "ready") throw new Error("Telegram session changed.");
    const time = now();
    for (const [token, ticket] of tickets) if (ticket.expires <= time) tickets.delete(token);
    while (tickets.size >= 32) tickets.delete(tickets.keys().next().value!);
    const token = randomBytes(32).toString("base64url");
    const ticket = { current, source, options, selection, expires: time + 60_000 };
    tickets.set(token, ticket);
    return { name: fileName(ticket), url: `/api/v1/plugins/${bb.pluginId}/http${route}?ticket=${token}` };
  }

  return {
    async issue(current: Session, chatId: string | undefined, options: ChatExportOptions, selection?: string[]) {
      if (chatId !== undefined && options.profileMusic) throw new Error("Profile music requires an account export.");
      if (selection && (!chatId || !selection.length || selection.length > 100 || new Set(selection).size !== selection.length
        || selection.some((id) => !/^[1-9]\d{0,15}$/.test(id)))) throw new Error("Invalid attachment selection.");
      const source = chatId === undefined ? undefined : { id: chatId, title: await current.chatExportSource(chatId) };
      return issueTicket(current, source, options, selection && { ids: selection.slice() });
    },
    async issueInboxAttachments(current: Session, { ids, ...inbox }: ChannelInboxSelection, format: "html" | "json" = "json") {
      const selection = ids.slice();
      const title = await current.channelInboxArchiveSource({ ...inbox, ids: selection });
      return issueTicket(current, { id: inbox.inboxId, title }, { format, media: true }, { ids: selection, inbox });
    },
    clear() {
      tickets.clear();
      for (const operation of running) operation.abort();
    },
  };
}
