// The host-agnostic Remote Hub panel. It receives plain state and callbacks
// through props and never touches the BB host: loading, error and ready are
// the only states, and the echo console is the only interaction.
import { useCallback, useState } from "react";
import type { HelperStatus, SessionHandle } from "../core/rpc.ts";

export type RemoteHubViewState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; status: HelperStatus };

export interface EchoInputResult {
  output: string;
  truncated: boolean;
}

export interface RemoteHubPanelProps {
  state: RemoteHubViewState;
  onOpen: () => Promise<SessionHandle | null>;
  onInput: (handle: SessionHandle, data: string) => Promise<EchoInputResult>;
  onClose: (handle: SessionHandle) => Promise<void>;
}

export function RemoteHubPanel(props: RemoteHubPanelProps) {
  const { state, onOpen, onInput, onClose } = props;
  const [handle, setHandle] = useState<SessionHandle | null>(null);
  const [lines, setLines] = useState<string[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [consoleError, setConsoleError] = useState<string | null>(null);

  const send = useCallback(async () => {
    const text = draft;
    if (text.length === 0 || busy) return;
    setBusy(true);
    setConsoleError(null);
    try {
      let active = handle;
      if (active === null) {
        active = await onOpen();
        if (active === null) return;
        setHandle(active);
      }
      const result = await onInput(active, text);
      setLines((prev) => [...prev, result.output]);
      if (result.truncated) setLines((prev) => [...prev, "[output truncated]"]);
      setDraft("");
    } catch (error) {
      setConsoleError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }, [draft, busy, handle, onOpen, onInput]);

  const close = useCallback(async () => {
    if (handle === null || busy) return;
    setBusy(true);
    try {
      await onClose(handle);
    } catch (error) {
      setConsoleError(error instanceof Error ? error.message : String(error));
    } finally {
      setHandle(null);
      setBusy(false);
    }
  }, [handle, busy, onClose]);

  if (state.kind === "loading") {
    return (
      <div style={{ padding: 16, fontFamily: "monospace" }}>
        <p>Remote Hub helper is starting…</p>
      </div>
    );
  }

  if (state.kind === "error") {
    return (
      <div style={{ padding: 16, fontFamily: "monospace", color: "#e06c75" }}>
        <h2>Remote Hub helper unavailable</h2>
        <p>{state.message}</p>
      </div>
    );
  }

  return (
    <div style={{ padding: 16, fontFamily: "monospace" }}>
      <h2>Remote Hub helper</h2>
      <p>
        version {state.status.version} · pid {state.status.pid} · {state.status.platform} ·{" "}
        {state.status.sessionCount} session(s)
      </p>

      <div
        style={{
          border: "1px solid #333",
          minHeight: 160,
          maxHeight: 320,
          overflow: "auto",
          padding: 8,
          marginBottom: 8,
          whiteSpace: "pre-wrap",
        }}
        role="log"
      >
        {lines.length === 0 ? <span style={{ color: "#666" }}>Send a line to echo it back.</span> : lines.join("\n")}
      </div>

      <form
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
        style={{ display: "flex", gap: 8 }}
      >
        <input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="type a line, then Enter"
          disabled={busy}
          style={{ flex: 1, fontFamily: "monospace" }}
        />
        <button type="submit" disabled={busy || draft.length === 0}>
          Send
        </button>
        <button type="button" onClick={() => void close()} disabled={handle === null || busy}>
          Close session
        </button>
      </form>

      {consoleError !== null ? <p style={{ color: "#e06c75" }}>{consoleError}</p> : null}
    </div>
  );
}
