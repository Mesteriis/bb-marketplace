// Hosts the GitWand iframe: answers what the shim asks of the BB page
// (notifications, folder picks) and says when the backend was restarted.
// Only messages from the iframe's own window and origin are read.
import { useEffect, useRef, useState, type FormEvent } from "react";
import { GitWandFrame } from "./gitwand-frame.tsx";

export interface GitWandHostProps {
  url: string | null;
  /** Shown instead of the frame, e.g. why the thread has no repository. */
  problem?: string | null;
  onNotify: (title: string, body: string) => void;
}

export function GitWandHost({ url, problem = null, onNotify }: GitWandHostProps) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [pick, setPick] = useState<number | null>(null);
  const [path, setPath] = useState("");
  const [lost, setLost] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);
  const notify = useRef(onNotify);
  notify.current = onNotify;
  const origin = url === null ? null : new URL(url).origin;

  useEffect(() => {
    if (origin === null) return;
    const onMessage = (event: MessageEvent) => {
      const d = event.data as { source?: string; type?: string; [key: string]: unknown } | null;
      if (event.origin !== origin || event.source !== frame.current?.contentWindow || d?.source !== "gitwand") return;
      if (d.type === "notify") notify.current(String(d.title ?? ""), String(d.body ?? ""));
      else if (d.type === "pick-folder" && typeof d.id === "number") {
        setPath("");
        setPick(d.id);
      } else if (d.type === "lost") setLost(String(d.reason ?? ""));
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [origin]);

  const answer = (value: string | null) => {
    if (pick === null || origin === null) return;
    frame.current?.contentWindow?.postMessage({ source: "gitwand-host", type: "pick-folder-result", id: pick, path: value }, origin);
    setPick(null);
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    answer(path.trim() === "" ? null : path.trim());
  };

  if (problem !== null) {
    return (
      <div role="status" style={{ padding: 16 }}>
        {problem}
      </div>
    );
  }
  return (
    <div style={{ position: "relative", width: "100%", height: "100%", display: "flex", flexDirection: "column" }}>
      {lost !== null && (
        <div role="alert" style={{ display: "flex", gap: 8, alignItems: "center", padding: "6px 12px", fontSize: 13 }}>
          <span style={{ flex: 1 }}>GitWand перезапущен: открытые терминалы закрыты ({lost}).</span>
          <button
            type="button"
            onClick={() => {
              setLost(null);
              setGeneration((g) => g + 1);
            }}
          >
            Обновить
          </button>
        </div>
      )}
      <div style={{ flex: 1, minHeight: 0 }}>
        <GitWandFrame key={generation} url={url} frameRef={frame} />
      </div>
      {pick !== null && (
        <form onSubmit={submit} style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", background: "rgb(0 0 0 / 0.35)" }}>
          <div style={{ display: "grid", gap: 8, padding: 16, minWidth: 320, background: "var(--background, #fff)", borderRadius: 8 }}>
            <label htmlFor="gitwand-folder">Путь к папке репозитория</label>
            <input id="gitwand-folder" autoFocus value={path} onChange={(e) => setPath(e.target.value)} placeholder="/Users/…/project" />
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button type="button" onClick={() => answer(null)}>
                Отмена
              </button>
              <button type="submit">Открыть</button>
            </div>
          </div>
        </form>
      )}
    </div>
  );
}
