// Host-free SSH connect form and session view. Real states only: connecting,
// running, detached, closed (with exit status), error.
import { useCallback, useEffect, useRef, useState } from "react";
import type { SessionHandle, SshTarget } from "../core/rpc.ts";
import { SshTerminal, type SshExitInfo, type SshTerminalState } from "./ssh-terminal.tsx";

export interface SshAttach {
  token: string;
  wsUrl: string;
}

/** A request to open a saved profile: a new `nonce` means a new request. */
export interface SshLaunch {
  nonce: number;
  profileId: string;
  target: SshTarget;
}

export interface SshPageProps {
  onSshOpen: (target: SshTarget, profileId?: string) => Promise<SessionHandle>;
  launch?: SshLaunch;
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

  const open = useCallback(
    async (t: SshTarget, profileId?: string) => {
      setState("connecting");
      setError(null);
      setExit(null);
      try {
        setTarget(t);
        const h = await onSshOpen(t, profileId);
        setHandle(h);
        const a = await onAttach(h);
        setAttach(a);
      } catch (e) {
        setState("error");
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [onSshOpen, onAttach],
  );

  const connect = useCallback(async () => {
    if (host.length === 0) return;
    await open({ host, user: user || undefined, port: port ? Number(port) : undefined, extraOptions: [] });
  }, [host, user, port, open]);

  // A saved profile asked to open: show its endpoint in the form and connect.
  const lastLaunch = useRef<number | null>(null);
  useEffect(() => {
    if (props.launch === undefined || lastLaunch.current === props.launch.nonce) return;
    lastLaunch.current = props.launch.nonce;
    const { target: t, profileId } = props.launch;
    setHost(t.host);
    setUser(t.user ?? "");
    setPort(t.port === undefined ? "" : String(t.port));
    void open(t, profileId);
  }, [props.launch, open]);

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
      setState("error");
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
