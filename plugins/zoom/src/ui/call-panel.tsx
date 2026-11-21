// Hosts one call. Zoom's Meeting SDK runs in an iframe on the plugin's call
// page, which the host serves from an origin other than its own; this panel hands it the meeting over postMessage and
// reacts to what it reports. Messages are accepted only from that iframe.
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import type { PreparedCall } from "../core/call.ts";

/** The SDK scripts come from Zoom's CDN; give a slow network this long. */
const LOAD_TIMEOUT_MS = 30_000;

type Phase =
  | { kind: "loading" }
  | { kind: "joining" }
  | { kind: "joined" }
  | { kind: "failed"; message: string };

interface CallPanelProps {
  call: PreparedCall;
  callPageUrl: string;
  title: string;
  onClose: () => void;
  openExternal: (url: string) => void;
}

function text(value: unknown, fallback: string): string {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return typeof value === "string" && value !== "" ? value.slice(0, 300) : fallback;
}

export function CallPanel({ call, callPageUrl, title, onClose, openExternal }: CallPanelProps) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      setPhase((current) => (current.kind === "loading" ? { kind: "failed", message: "Страница звонка не ответила. Проверьте связь с zoom.us" } : current));
    }, LOAD_TIMEOUT_MS);

    function onMessage(event: MessageEvent) {
      const target = frame.current?.contentWindow;
      if (target == null || event.source !== target) return;
      const data: unknown = event.data;
      if (typeof data !== "object" || data === null) return;
      const message = data as { type?: unknown; message?: unknown; code?: unknown };
      if (message.type === "zoom-call:ready") {
        setPhase({ kind: "joining" });
        // The message goes to this one window, whichever origin the host gave the call page.
        target.postMessage(
          { type: "zoom-call:join", call: { signature: call.signature, meetingNumber: call.meetingNumber, passcode: call.passcode, userName: call.userName, zak: call.zak } },
          "*",
        );
      } else if (message.type === "zoom-call:joined") {
        setPhase({ kind: "joined" });
      } else if (message.type === "zoom-call:ended") {
        onClose();
      } else if (message.type === "zoom-call:failed") {
        setPhase({ kind: "failed", message: text(message.message, "Не удалось загрузить Zoom") });
      } else if (message.type === "zoom-call:error") {
        setPhase({ kind: "failed", message: `${text(message.message, "Zoom отклонил вход")} (код ${text(message.code, "неизвестен")})` });
      }
    }
    window.addEventListener("message", onMessage);
    return () => {
      window.clearTimeout(timeout);
      window.removeEventListener("message", onMessage);
    };
  }, [call, onClose]);

  function leave() {
    if (phase.kind === "joined") frame.current?.contentWindow?.postMessage({ type: "zoom-call:leave" }, "*");
    else onClose();
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2">
        <h1 className="min-w-0 flex-1 truncate text-sm font-medium">{title}</h1>
        <span className="text-xs text-muted-foreground" aria-live="polite">
          {phase.kind === "loading" && "Загружаю Zoom…"}
          {phase.kind === "joining" && "Подключаюсь…"}
          {phase.kind === "joined" && "В звонке"}
        </span>
        {phase.kind !== "failed" && (
          <Button size="sm" variant="ghost" onClick={() => openExternal(call.fallbackUrl)}>
            Открыть в Zoom
          </Button>
        )}
        <Button size="sm" variant={phase.kind === "joined" ? "destructive" : "outline"} onClick={leave}>
          {phase.kind === "joined" ? "Выйти" : "Закрыть"}
        </Button>
      </header>
      {phase.kind === "failed" ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
          <p role="alert" className="max-w-md text-sm text-destructive">
            {phase.message}
          </p>
          <p className="max-w-md text-xs text-muted-foreground">
            Встречи других аккаунтов Zoom может не пускать во встроенный клиент, пока приложение не опубликовано. Встречу можно открыть в приложении Zoom.
          </p>
          <div className="flex gap-2">
            <Button onClick={() => openExternal(call.fallbackUrl)}>Открыть в Zoom</Button>
            <Button variant="outline" onClick={onClose}>
              Закрыть
            </Button>
          </div>
        </div>
      ) : (
        <iframe
          ref={frame}
          src={callPageUrl}
          title="Звонок Zoom"
          className="min-h-0 w-full flex-1 border-0 bg-black"
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
          allow="camera *; microphone *; display-capture *; autoplay *; fullscreen *"
          referrerPolicy="no-referrer"
        />
      )}
    </div>
  );
}
