// Hosts the GitWand iframe: answers what the shim asks of the BB page
// (notifications, folder picks) and says when the backend was restarted.
// Only messages from the iframe's own window and origin are read.
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
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

  if (problem !== null) return <Notice icon="GitBranch" text={problem} />;
  return (
    <div className="relative flex h-full w-full flex-col">
      {lost !== null && (
        <div role="alert" className="flex items-center gap-3 border-b border-border px-3 py-2 text-sm">
          <Icon name="RotateCcw" className="size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1">GitWand перезапущен: открытые терминалы закрыты ({lost}).</span>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setLost(null);
              setGeneration((g) => g + 1);
            }}
          >
            Обновить
          </Button>
        </div>
      )}
      <div className="min-h-0 flex-1">
        <GitWandFrame key={generation} url={url} frameRef={frame} />
      </div>
      {pick !== null && (
        <div className="absolute inset-0 grid place-items-center bg-black/30 p-4">
          <form onSubmit={submit} className="flex w-full max-w-md flex-col gap-3 rounded-lg border border-border bg-background p-4 shadow-lg">
            <label htmlFor="gitwand-folder" className="text-sm font-medium">
              Путь к папке репозитория
            </label>
            <Input id="gitwand-folder" autoFocus value={path} onChange={(e) => setPath(e.target.value)} placeholder="/Users/…/project" />
            <div className="flex justify-end gap-2">
              <Button type="button" size="sm" variant="ghost" onClick={() => answer(null)}>
                Отмена
              </Button>
              <Button type="submit" size="sm">
                Открыть
              </Button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}

/** A centred one-line state of the tab: loading, why GitWand cannot open. */
export function Notice({ icon, text }: { icon: string; text: string }) {
  return (
    <div className="flex h-full w-full items-center justify-center p-6">
      <div role="status" className="flex max-w-md items-start gap-3 text-sm text-muted-foreground">
        <Icon name={icon} className="mt-0.5 size-4 shrink-0" />
        <span>{text}</span>
      </div>
    </div>
  );
}
