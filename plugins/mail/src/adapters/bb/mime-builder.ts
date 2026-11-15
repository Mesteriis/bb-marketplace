// MessageBuilder on nodemailer's MailComposer: the only writer of outgoing
// headers. The message is built once, without Bcc (the Sent copy gets a Bcc
// line spliced in by the core), without X-Mailer (only nodemailer's mailer
// adds it; MailComposer alone does not), with attachments given by content
// only and file and URL access switched off, so no input can make the
// builder read a file or fetch a URL. Header inputs were checked at the RPC
// boundary; CR, LF and NUL are refused here again.
import MailComposer from "nodemailer/lib/mail-composer";
import type { MailComposerOptions } from "nodemailer/lib/mail-composer";
import type { MessageBuilder, OutgoingAddress, OutgoingMessage } from "../../core/index.ts";

/** Fixed text: never the value that was refused. */
export class HeaderValueError extends Error {
  constructor() {
    super("A header value contains a line break or NUL");
    this.name = "HeaderValueError";
  }
}

const BREAKS = /[\r\n\u0000]/;

function checked(value: string): string {
  if (BREAKS.test(value)) throw new HeaderValueError();
  return value;
}

function address(entry: OutgoingAddress): { name: string; address: string } | string {
  const name = entry.name === null ? "" : checked(entry.name).trim();
  checked(entry.address);
  return name === "" ? entry.address : { name, address: entry.address };
}

/** The MailComposer options for a message; exported for the no-path/no-href test. */
export function composerOptions(input: OutgoingMessage): MailComposerOptions {
  const date = new Date(input.date);
  if (!Number.isFinite(date.getTime())) throw new HeaderValueError();
  return {
    from: address(input.from),
    to: input.to.map(address),
    cc: input.cc.length > 0 ? input.cc.map(address) : undefined,
    subject: checked(input.subject),
    messageId: checked(input.messageId),
    date,
    inReplyTo: input.inReplyTo === null ? undefined : checked(input.inReplyTo),
    references: input.references.length > 0 ? input.references.map(checked) : undefined,
    text: input.text,
    html: input.html,
    attachments: input.attachments.map((attachment) => {
      const cid = attachment.contentId === null ? "" : checked(attachment.contentId).replace(/^<|>$/g, "").trim();
      return {
        filename: checked(attachment.fileName),
        contentType: checked(attachment.mimeType),
        content: Buffer.from(attachment.bytes),
        ...(cid === "" ? {} : { cid }),
      };
    }),
    disableFileAccess: true,
    disableUrlAccess: true,
    newline: "windows",
  };
}

export function createMimeBuilder(): MessageBuilder {
  return {
    async build(input: OutgoingMessage): Promise<Uint8Array> {
      const node = new MailComposer(composerOptions(input)).compile();
      const raw = await node.build();
      return new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
    },
  };
}
