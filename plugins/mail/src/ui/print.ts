// Print and save as PDF (slice 3h, #89, Shift+P). One HTML document for a
// message or a conversation: per message a header table (text only,
// escaped) and the sanitized body in light colors with quotes shown. The
// document's CSP allows data: images only, so printing makes no network
// request and remote images are left out (spec resolution 19). It prints
// from a hidden frame sandboxed with exactly allow-same-origin allow-modals
// (no scripts); where print is missing or throws, the page offers the same
// document as a file instead.
import type { MessageBody, MessageHeader } from "../core/index.ts";
import { sanitizeFileName } from "../core/file-names.ts";
import { EMAIL_CSP, sanitizeEmailHtml } from "./sanitize.ts";

/** The print frame's sandbox: the parent may call print(); the frame runs nothing. */
export const PRINT_SANDBOX = "allow-same-origin allow-modals";
/** The print document's policy: the mail's, never remote images. */
export const PRINT_CSP = EMAIL_CSP;
/** How long the frame stays when afterprint never comes. */
export const PRINT_FRAME_MS = 60_000;

export const REMOTE_NOT_PRINTED_TEXT = "Remote images are not printed";

const PRINT_STYLE = [
  ":root { color-scheme: light; }",
  "@page { margin: 16mm; }",
  "body { font: 12pt/1.5 system-ui, -apple-system, 'Segoe UI', sans-serif; color: #000; background: #fff; margin: 0; }",
  "table.mk-head { border-collapse: collapse; margin: 0 0 12px; font-size: 10pt; }",
  "table.mk-head th { text-align: left; padding: 0 12px 0 0; color: #555; font-weight: normal; vertical-align: top; }",
  "section.mk-message { break-inside: auto; margin: 0 0 24px; }",
  "section.mk-message + section.mk-message { border-top: 1px solid #ccc; padding-top: 16px; }",
  "pre { white-space: pre-wrap; font: inherit; }",
  "img { max-width: 100%; height: auto; }",
  "p.mk-note { color: #555; font-size: 9pt; }",
].join("");

/** Text as HTML text: every markup character escaped. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function addresses(list: readonly { name: string | null; address: string }[]): string {
  return list.map((a) => (a.name?.trim() ? `${a.name.trim()} <${a.address}>` : a.address)).join(", ");
}

function headerRow(label: string, value: string): string {
  return value === "" ? "" : `<tr><th>${escapeHtml(label)}</th><td>${escapeHtml(value)}</td></tr>`;
}

/** The sanitized body of one message, without its document wrapper. */
function bodyHtml(body: MessageBody | null): { html: string; blocked: boolean } {
  if (body === null) return { html: "<p class=\"mk-note\">This message was not loaded.</p>", blocked: false };
  if (body.html !== null) {
    const sanitized = sanitizeEmailHtml(body.html, { remoteImages: false });
    const start = sanitized.html.indexOf("<body>") + "<body>".length;
    const end = sanitized.html.lastIndexOf("</body>");
    return { html: sanitized.html.slice(start, end), blocked: sanitized.blockedRemoteImages };
  }
  return { html: `<pre>${escapeHtml(body.text ?? "")}</pre>`, blocked: false };
}

export interface PrintMessage {
  header: Pick<MessageHeader, "from" | "to" | "cc" | "date" | "subject">;
  body: MessageBody | null;
}

/** One printable document for `messages` (oldest first). */
export function printDocument(messages: readonly PrintMessage[], title: string): string {
  const sections = messages.map(({ header, body }) => {
    const { html, blocked } = bodyHtml(body);
    const date = header.date === null ? "" : new Date(header.date).toLocaleString(undefined, { dateStyle: "full", timeStyle: "short" });
    return (
      '<section class="mk-message"><table class="mk-head">' +
      headerRow("From", addresses([header.from])) +
      headerRow("To", addresses(header.to)) +
      headerRow("Cc", addresses(header.cc)) +
      headerRow("Date", date) +
      headerRow("Subject", header.subject) +
      "</table>" +
      html +
      (blocked ? `<p class="mk-note">${REMOTE_NOT_PRINTED_TEXT}</p>` : "") +
      "</section>"
    );
  });
  return (
    "<!doctype html><html><head><meta charset=\"utf-8\">" +
    `<meta http-equiv="Content-Security-Policy" content="${PRINT_CSP}">` +
    '<meta name="referrer" content="no-referrer">' +
    `<title>${escapeHtml(title)}</title>` +
    `<style>${PRINT_STYLE}</style>` +
    `</head><body>${sections.join("")}</body></html>`
  );
}

/** "2026-11-16 Subject.html", made safe as a file name. */
export function printFileName(date: Date, subject: string): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const title = subject.replace(/[/\\]+/g, " ").trim() || "Message";
  return sanitizeFileName(`${day} ${title}.html`, `${day} Message.html`);
}

/**
 * Prints the document from a hidden sandboxed frame. Resolves false when the
 * frame cannot print (no print, or print threw): the caller offers the file.
 */
export function printHtml(html: string, doc: Document = document): Promise<boolean> {
  return new Promise((resolve) => {
    const frame = doc.createElement("iframe");
    frame.setAttribute("sandbox", PRINT_SANDBOX);
    frame.setAttribute("aria-hidden", "true");
    frame.setAttribute("tabindex", "-1");
    frame.style.position = "fixed";
    frame.style.width = "0";
    frame.style.height = "0";
    frame.style.border = "0";
    frame.style.right = "0";
    frame.style.bottom = "0";
    let removed = false;
    const remove = () => {
      if (removed) return;
      removed = true;
      frame.remove();
    };
    frame.addEventListener("load", () => {
      const view = frame.contentWindow;
      if (view == null || typeof view.print !== "function") {
        remove();
        resolve(false);
        return;
      }
      const timer = setTimeout(remove, PRINT_FRAME_MS);
      view.addEventListener("afterprint", () => {
        clearTimeout(timer);
        remove();
      });
      try {
        view.print();
        resolve(true);
      } catch {
        clearTimeout(timer);
        remove();
        resolve(false);
      }
    });
    frame.srcdoc = html;
    doc.body.append(frame);
  });
}
