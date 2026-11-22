// The ChatGPT tab of BB's navigation. The whole tab is ChatGPT: a window of
// the plugin's own, with its own lasting sign-in, sits exactly on it. Sites
// like chatgpt.com refuse to be shown inside another page, so it cannot be
// a frame. The text below is seen only while that window is not there yet.
import { useEffect, useRef, useState } from "react";
import type { WindowStatusView } from "../core/window-status.ts";
import { BUTTON_OUTLINE, type WindowApi } from "./services.ts";
import { useAttachment } from "./use-attachment.ts";

interface DockPageProps {
  chat: WindowApi;
  /** The window's latest status; null until it is known. */
  status: WindowStatusView | null;
}

function describeStatus(status: WindowStatusView | null): string {
  if (status === null) return "Открываю ChatGPT…";
  switch (status.window) {
    case "closed":
      return "ChatGPT закрыт.";
    case "building":
      return "ChatGPT собирается на этом Mac. Первый раз это занимает до минуты.";
    case "unavailable":
      return "ChatGPT недоступен. " + (status.reason ?? "");
    case "open":
      return "Открываю ChatGPT…";
  }
}

export function DockPage({ chat, status }: DockPageProps) {
  const area = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  useAttachment(area, chat.attach, true);

  // Opening the tab opens ChatGPT. A refused call is shown, not swallowed.
  useEffect(() => {
    chat.open().then(
      () => setFailed(false),
      () => setFailed(true),
    );
  }, [chat]);

  async function reopen() {
    if (busy) return;
    setBusy(true);
    try {
      await chat.open();
      setFailed(false);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  const canReopen = failed || (status !== null && (status.window === "closed" || status.window === "unavailable"));
  return (
    <div ref={area} data-chat-dock-area="" aria-label="ChatGPT" className="flex h-full min-h-0 w-full items-center justify-center">
      <div className="flex max-w-sm flex-col items-center gap-3 p-6 text-center">
        <p role="status" aria-live="polite" className="text-sm text-muted-foreground">
          {failed ? "Не удалось связаться с компьютером, на котором работает BB." : describeStatus(status)}
        </p>
        {canReopen && (
          <button type="button" className={BUTTON_OUTLINE} disabled={busy} onClick={reopen}>
            Открыть ChatGPT
          </button>
        )}
      </div>
    </div>
  );
}
