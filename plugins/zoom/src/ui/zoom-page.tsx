// The plugin page: decides between "connect your account" and the calendar.
// It never calls the host: data and actions arrive through props.
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { messageOf, noNotify, type AccountStatus, type Notify, type ZoomPageApi } from "./api.ts";
import { CalendarScreen } from "./calendar-screen.tsx";
import { ConnectScreen } from "./connect-screen.tsx";

export interface ZoomPageProps {
  api: ZoomPageApi;
  /** The address BB is open on; the OAuth redirect is built from it. */
  origin: string;
  /** Where the call page is served; null when the host has no separate origin for it, and meetings open in the Zoom app. */
  callPageUrl: string | null;
  /** Opens a link outside the page (the consent screen, the Zoom app). */
  openExternal: (url: string) => void;
  /** Changes when the host learns the account was connected or disconnected. */
  refreshKey: number;
  notify?: Notify;
  now?: () => number;
  timeZone?: string;
}

type Load = { kind: "loading" } | { kind: "error"; message: string } | { kind: "ready"; status: AccountStatus };

export function ZoomPage({ api, origin, callPageUrl, openExternal, refreshKey, notify = noNotify, now = Date.now, timeZone }: ZoomPageProps) {
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [connecting, setConnecting] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const zone = timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;

  useEffect(() => {
    let cancelled = false;
    api.status().then(
      (status) => !cancelled && setLoad({ kind: "ready", status }),
      (error: unknown) => !cancelled && setLoad({ kind: "error", message: messageOf(error) }),
    );
    return () => {
      cancelled = true;
    };
  }, [api, refreshKey, attempt]);

  const recheck = useCallback(() => setAttempt((value) => value + 1), []);

  async function connect() {
    setConnecting(true);
    try {
      const { authorizeUrl } = await api.beginLogin(origin);
      openExternal(authorizeUrl);
    } catch (error) {
      notify("error", messageOf(error));
    } finally {
      setConnecting(false);
    }
  }

  if (load.kind === "loading") {
    return <div className="flex h-full items-center justify-center p-8 text-sm text-muted-foreground">Загрузка…</div>;
  }
  if (load.kind === "error") {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
        <p role="alert" className="text-sm text-destructive">
          {load.message}
        </p>
        <Button variant="outline" onClick={recheck}>
          Повторить
        </Button>
      </div>
    );
  }
  if (!load.status.connected) {
    return (
      <ConnectScreen api={api} origin={origin} configured={load.status.configured} connecting={connecting} onConnect={() => void connect()} onRecheck={recheck} />
    );
  }
  return (
    <CalendarScreen
      api={api}
      displayName={load.status.displayName}
      callPageUrl={callPageUrl}
      openExternal={openExternal}
      notify={notify}
      now={now}
      timeZone={zone}
      onAccountChanged={recheck}
    />
  );
}
