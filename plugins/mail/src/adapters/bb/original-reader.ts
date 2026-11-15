// OriginalReader: what a reply or forward needs from the original that the
// store does not keep (Reply-To of rows synced before it was stored, the
// HTML to quote, the attachments to forward). The raw message is fetched
// with the 3a guards (read-only session, BODY.PEEK, UIDVALIDITY, size and
// Message-ID checks, 50 MB cap) and parsed by the plugin's one MIME parser.
// File names and types come out sanitized, so the composer and the builder
// never see a path, a control character or an active type.
import type { Address } from "postal-mime";
import type { MailAddress, OriginalMessage, OriginalReader, OutgoingAttachment } from "../../core/index.ts";
import { fetchRawGuarded, safeContentType, sanitizeFileName, type RawDeps } from "./downloads.ts";
import { parseMail } from "./imapflow-gateway.ts";

function addresses(list: Address[] | undefined): MailAddress[] {
  return (list ?? []).flatMap((entry) =>
    entry.group
      ? entry.group.map((member) => ({ name: member.name || null, address: member.address }))
      : entry.address
        ? [{ name: entry.name || null, address: entry.address }]
        : [],
  );
}

function bytesOf(content: ArrayBuffer | Uint8Array | string): Uint8Array {
  if (content instanceof Uint8Array) return content.slice();
  if (content instanceof ArrayBuffer) return new Uint8Array(content.slice(0));
  return new TextEncoder().encode(content);
}

export function createOriginalReader(deps: RawDeps): OriginalReader {
  return {
    async read(messageId: string): Promise<OriginalMessage> {
      const { raw } = await fetchRawGuarded(deps, messageId);
      const parsed = await parseMail(raw);
      const attachments: OutgoingAttachment[] = parsed.attachments.map((attachment) => {
        const inline = attachment.disposition === "inline" || attachment.related === true;
        const contentId =
          inline && typeof attachment.contentId === "string"
            ? attachment.contentId.trim().replace(/^<|>$/g, "").trim()
            : "";
        return {
          fileName: sanitizeFileName(attachment.filename, "attachment"),
          mimeType: safeContentType(attachment.mimeType ?? ""),
          bytes: bytesOf(attachment.content),
          contentId: contentId === "" || /[\r\n\u0000]/.test(contentId) ? null : contentId,
        };
      });
      return { replyTo: addresses(parsed.replyTo), html: parsed.html ?? null, attachments };
    },
  };
}
