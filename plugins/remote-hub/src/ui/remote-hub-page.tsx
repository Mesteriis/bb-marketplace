// The host-free Remote Hub page: owns loading/error/ready state and re-checks
// the helper status every 5 s while mounted. All host concerns (RPC, spawning)
// are injected as callbacks, so this renders and transitions without the BB
// host.
import { useEffect, useState } from "react";
import type { HelperStatus, SessionHandle } from "../core/rpc.ts";
import { RemoteHubPanel, type EchoInputResult, type RemoteHubViewState } from "./remote-hub-panel.tsx";

export const STATUS_POLL_MS = 5_000;

export interface RemoteHubPageProps {
  loadStatus: () => Promise<HelperStatus>;
  onOpen: () => Promise<SessionHandle | null>;
  onInput: (handle: SessionHandle, data: string) => Promise<EchoInputResult>;
  onClose: (handle: SessionHandle) => Promise<void>;
}

export function RemoteHubPage(props: RemoteHubPageProps) {
  const { loadStatus, onOpen, onInput, onClose } = props;
  const [state, setState] = useState<RemoteHubViewState>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      try {
        const status = await loadStatus();
        if (!cancelled) {
          setState(
            status.alive
              ? { kind: "ready", status }
              : { kind: "error", message: "Remote Hub helper is not running" },
          );
        }
      } catch (error) {
        if (!cancelled) {
          setState({ kind: "error", message: error instanceof Error ? error.message : String(error) });
        }
      }
    };
    void run();
    const timer = setInterval(() => {
      void run();
    }, STATUS_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [loadStatus]);

  return <RemoteHubPanel state={state} onOpen={onOpen} onInput={onInput} onClose={onClose} />;
}
