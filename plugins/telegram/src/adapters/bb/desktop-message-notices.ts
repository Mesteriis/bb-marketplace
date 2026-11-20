import type { MessageNotification } from "../../core/contract.ts";

export function telegramWindowInBackground(doc: Pick<Document, "visibilityState" | "hasFocus">): boolean {
  return doc.visibilityState === "hidden" || !doc.hasFocus();
}

export function showDesktopMessageNotice(notice: MessageNotification, options: {
  title: string; fallback: string; scope: string; open: (notice: MessageNotification) => void;
}, host: typeof Notification | undefined = globalThis.Notification): Notification | undefined {
  if (host?.permission !== "granted" || notice.pendingMessage) return;
  try {
    const banner = new host(options.title, {
      body: notice.preview ?? options.fallback,
      tag: `bb-telegram:${options.scope}:${notice.key}`,
    });
    banner.onclick = () => {
      try { window.focus(); } catch { /* The click can still open the message. */ }
      options.open(notice);
      banner.close();
    };
    return banner;
  } catch {
    return undefined;
  }
}
