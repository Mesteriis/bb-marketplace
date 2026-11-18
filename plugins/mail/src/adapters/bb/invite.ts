// The calendar part of a raw message (slice 3l): the first text/calendar
// alternative or .ics attachment, decoded as UTF-8 and cut at the cap the
// core reads up to. Nothing here acts on the text.
import { INVITE_MAX_CHARS, isCalendarPart } from "../../core/calendar-invite.ts";
import { parseMail } from "./imapflow-gateway.ts";

/** The calendar text of `raw`, or null when it carries none or does not parse. */
export async function readCalendarText(raw: Uint8Array): Promise<string | null> {
  let attachments: Awaited<ReturnType<typeof parseMail>>["attachments"];
  try {
    attachments = (await parseMail(raw)).attachments;
  } catch {
    return null;
  }
  const part = attachments.find((a) => isCalendarPart({ mimeType: a.mimeType, filename: a.filename }));
  if (part === undefined) return null;
  if (typeof part.content === "string") return part.content.slice(0, INVITE_MAX_CHARS);
  const bytes = part.content instanceof Uint8Array ? part.content : new Uint8Array(part.content);
  // A character is at most four bytes: this many bytes always cover the cap.
  return new TextDecoder().decode(bytes.subarray(0, INVITE_MAX_CHARS * 4)).slice(0, INVITE_MAX_CHARS);
}
