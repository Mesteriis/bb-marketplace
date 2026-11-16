// Host-free SSH connect form and session view. Real states only: connecting,
// running, detached, closed (with exit status), error.
import { useCallback, useState } from "react";
import type { SessionHandle, SshTarget } from "../core/rpc.ts";
import { SshTerminal, type SshExitInfo, type SshTerminalState } from "./ssh-terminal.tsx";

export interface SshAttach {
  token: string;
  wsUrl: string;
}

export interface SshPageProps {
  onSshOpen: (target: SshTarget) => Promise<SessionHandle>;
  onAttach: (handle: SessionHandle) => Promise<SshAttach>;
  onClose: (handle: SessionHandle) => Promise<void>;
}

type PageState = "idle" | "connecting" | "running" | "detached" | "closed" | "error";

export function SshPage(props: SshPageProps) {
  const { onSshOpen, onAttach, onClose } = props;
  const [host, setHost] = useState("");
  const [user, setUser] = useState("");
  const [port, setPort] = useState("");
  const [handle, setHandle] = useState<SessionHandle | null>(null);
  const [attach, setAttach] = useState<SshAttach | null>(null);
  const [target, setTarget] = useState<SshTarget | null>(null);
  const [state, setState] = useState<PageState>("idle");
  const [exit, setExit] = useState<SshExitInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  const onTerminalState = useCallback((next: SshTerminalState, info?: SshExitInfo) => {
    setState(next);
    if (info !== undefined) setExit(info);
  }, []);

  const connect = useCallback(async () => {
    if (host.length === 0) return;
    setState("connecting");
    setError(null);
    setExit(null);
    try {
      const t: SshTarget = { host, user: user || undefined, port: port ? Number(port) : undefined, extraOptions: [] };
      setTarget(t);
      const h = await onSshOpen(t);
      setHandle(h);
      const a = await onAttach(h);
      setAttach(a);
    } catch (e) {
      setState("error");
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [host, user, port, onSshOpen, onAttach]);

  const disconnect = useCallback(async () => {
    if (handle === null) return;
    try {
      await onClose(handle);
      setState("closed");
      setExit({ exitCode: null, signal: null, reason: "killed_by_close" });
      setAttach(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [handle, onClose]);

  const reattach = useCallback(async () => {
    if (handle === null) return;
    try {
      setState("connecting");
      const a = await onAttach(handle);
      setAttach(a);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [handle, onAttach]);

  return (
    <div className="rh-page">
      <div className="rh-form">
        <input placeholder="host" value={host} onChange={(e) => setHost(e.target.value)} />
        <input placeholder="user" value={user} onChange={(e) => setUser(e.target.value)} />
        <input placeholder="port" value={port} onChange={(e) => setPort(e.target.value)} className="rh-port" />
        <button onClick={() => void connect()} disabled={host.length === 0 || state === "connecting"}>
          Connect
        </button>
        {handle !== null && (
          <>
            <button onClick={() => void disconnect()} disabled={state === "connecting"}>
              Disconnect
            </button>
            <button onClick={() => void reattach()} disabled={attach === null || state === "connecting"}>
              Reattach
            </button>
          </>
        )}
      </div>
      <div className="rh-header">
        {target !== null && (
          <span>
            target: <strong>{target.user ? target.user + "@" : ""}{target.host}{target.port ? ":" + target.port : ""}</strong>
          </span>
        )}
        <span data-testid="ssh-state">
          state: <strong>{state}</strong>
        </span>
        {state === "closed" && exit !== null && (
          <span data-testid="ssh-exit">
            {exit.exitCode !== null
              ? "exit " + exit.exitCode
              : exit.signal !== null
                ? "signal " + exit.signal
                : exit.reason}
          </span>
        )}
      </div>
      {error !== null && <p className="rh-error">{error}</p>}
      {attach !== null && (
        <div className="rh-terminal-wrap">
          <SshTerminal wsUrl={attach.wsUrl} token={attach.token} onStateChange={onTerminalState} />
        </div>
      )}
    </div>
  );
}
