// Host-free SSH connect form and session view. Real states only: connecting,
// running, closed, error. The terminal is rendered by SshTerminal.
import { useCallback, useState } from "react";
import type { SessionHandle, SshTarget } from "../core/rpc.ts";
import { SshTerminal } from "./ssh-terminal.tsx";

export interface SshAttach {
  token: string;
  wsUrl: string;
}

export interface SshPageProps {
  onSshOpen: (target: SshTarget) => Promise<SessionHandle>;
  onAttach: (handle: SessionHandle) => Promise<SshAttach>;
  onClose: (handle: SessionHandle) => Promise<void>;
}

export function SshPage(props: SshPageProps) {
  const { onSshOpen, onAttach, onClose } = props;
  const [host, setHost] = useState("");
  const [user, setUser] = useState("");
  const [port, setPort] = useState("");
  const [handle, setHandle] = useState<SessionHandle | null>(null);
  const [attach, setAttach] = useState<SshAttach | null>(null);
  const [state, setState] = useState<"idle" | "connecting" | "running" | "closed" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  const connect = useCallback(async () => {
    if (host.length === 0) return;
    setState("connecting");
    setError(null);
    try {
      const target: SshTarget = { host, user: user || undefined, port: port ? Number(port) : undefined, extraOptions: [] };
      const h = await onSshOpen(target);
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
    setState("connecting");
    try {
      await onClose(handle);
      setState("closed");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [handle, onClose]);

  const reattach = useCallback(async () => {
    if (handle === null) return;
    try {
      const a = await onAttach(handle);
      setAttach(a);
      setState("running");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [handle, onAttach]);

  return (
    <div style={{ padding: 16, fontFamily: "monospace" }}>
      <h2>SSH session</h2>
      <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
        <input placeholder="host" value={host} onChange={(e) => setHost(e.target.value)} />
        <input placeholder="user" value={user} onChange={(e) => setUser(e.target.value)} />
        <input placeholder="port" value={port} onChange={(e) => setPort(e.target.value)} style={{ width: 80 }} />
        <button onClick={() => void connect()} disabled={host.length === 0 || state === "connecting"}>
          Connect
        </button>
        {handle !== null && (
          <>
            <button onClick={() => void disconnect()} disabled={state === "connecting"}>
              Disconnect
            </button>
            <button onClick={() => void reattach()} disabled={attach === null}>
              Reattach
            </button>
          </>
        )}
      </div>
      <p data-testid="ssh-state">state: {state}</p>
      {error !== null && <p style={{ color: "#e06c75" }}>{error}</p>}
      {attach !== null && (
        <div style={{ height: 320, border: "1px solid #333" }}>
          <SshTerminal wsUrl={attach.wsUrl} token={attach.token} onStateChange={setState} />
        </div>
      )}
    </div>
  );
}
