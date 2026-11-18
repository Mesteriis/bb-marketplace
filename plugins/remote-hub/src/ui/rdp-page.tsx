// Host-free RDP connect form and session view. Real states only: the service's
// own states (connecting, tls, cert_prompt, authenticating, desktop_ready,
// closed) plus detached / error for the page's socket. The password lives in
// the form field only until Connect is pressed: it is cleared from component
// state at once and never shown again.
import { useCallback, useRef, useState } from "react";
import type { FitMode } from "../core/rdp-geometry.ts";
import { closeReasonText, errorCodeText, errorTextFromMessage, stateText } from "../core/rdp-texts.ts";
import type { RdpCertPromptInfo, RdpDecision, SessionHandle } from "../core/rpc.ts";
import { RdpCanvas, type RdpCanvasEvent, type RdpCanvasHandle } from "./rdp-canvas.tsx";
import { RdpCertDialog } from "./rdp-cert-dialog.tsx";

export interface RdpAttach {
  token: string;
  wsUrl: string;
}

export interface RdpConnectTarget {
  host: string;
  port: number;
  username: string;
  password: string;
  domain?: string;
}

export interface RdpScreenshotResult {
  frameId: number;
  width: number;
  height: number;
  timestamp: number;
  /** Base64 of the PNG. */
  png: string;
}

export interface RdpPageProps {
  onRdpOpen: (target: RdpConnectTarget, size: { width: number; height: number }) => Promise<SessionHandle>;
  onAttach: (handle: SessionHandle) => Promise<RdpAttach>;
  onClose: (handle: SessionHandle) => Promise<void>;
  onDecision: (handle: SessionHandle, fingerprint: string, accept: RdpDecision) => Promise<void>;
  onScreenshot: (handle: SessionHandle) => Promise<RdpScreenshotResult>;
  /** Save a PNG for the user; the browser download by default. */
  onSavePng?: (filename: string, base64: string) => void;
}

const DESKTOP_SIZE = { width: 1280, height: 800 };

/** The browser download of a base64 PNG. */
export function downloadPng(filename: string, base64: string): void {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type: "image/png" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function RdpPage(props: RdpPageProps) {
  const { onRdpOpen, onAttach, onClose, onDecision, onScreenshot, onSavePng = downloadPng } = props;
  const [host, setHost] = useState("");
  const [port, setPort] = useState("");
  const [username, setUsername] = useState("");
  const [domain, setDomain] = useState("");
  const [password, setPassword] = useState("");
  const [handle, setHandle] = useState<SessionHandle | null>(null);
  const [attach, setAttach] = useState<RdpAttach | null>(null);
  const [endpoint, setEndpoint] = useState<string | null>(null);
  const [state, setState] = useState<string>("idle");
  const [prompt, setPrompt] = useState<RdpCertPromptInfo | null>(null);
  const [desktop, setDesktop] = useState<{ width: number; height: number } | null>(null);
  const [closeReason, setCloseReason] = useState<string | null>(null);
  const [detached, setDetached] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fit, setFit] = useState<FitMode>("fit");
  const [deciding, setDeciding] = useState(false);
  const canvasHandle = useRef<RdpCanvasHandle | null>(null);

  const onCanvasEvent = useCallback((event: RdpCanvasEvent) => {
    switch (event.type) {
      case "socket":
        setDetached(event.state === "detached");
        if (event.state === "error") setError("the connection to the page's socket failed");
        break;
      case "attached":
        setDetached(false);
        setState(event.state);
        setPrompt(event.state === "cert_prompt" ? event.prompt : null);
        if (event.desktop !== null) setDesktop({ width: event.desktop.width, height: event.desktop.height });
        break;
      case "state":
        setState(event.state);
        if (event.state !== "cert_prompt") setPrompt(null);
        break;
      case "cert_prompt":
        setPrompt(event.prompt);
        break;
      case "desktop":
        setDesktop({ width: event.width, height: event.height });
        break;
      case "closed":
        setState("closed");
        setPrompt(null);
        setCloseReason(event.reason);
        break;
      case "error":
        setError(errorCodeText(event.code));
        break;
      case "notice":
        setNotice(event.text);
        break;
    }
  }, []);

  const connect = useCallback(async () => {
    const portNumber = port === "" ? 3389 : Number(port);
    if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535) {
      setError("port must be a whole number from 1 to 65535");
      return;
    }
    // The password leaves component state HERE; only this call's closure holds it.
    const secret = password;
    setPassword("");
    setState("connecting");
    setError(null);
    setNotice(null);
    setCloseReason(null);
    setPrompt(null);
    setDesktop(null);
    setDetached(false);
    setEndpoint(username + "@" + host + ":" + portNumber);
    try {
      const target: RdpConnectTarget = { host, port: portNumber, username, password: secret, ...(domain !== "" ? { domain } : {}) };
      const h = await onRdpOpen(target, DESKTOP_SIZE);
      setHandle(h);
      setAttach(await onAttach(h));
    } catch (e) {
      setState("error");
      setError(errorTextFromMessage(e instanceof Error ? e.message : String(e)));
    }
  }, [host, port, username, domain, password, onRdpOpen, onAttach]);

  const disconnect = useCallback(async () => {
    if (handle === null) return;
    try {
      await onClose(handle);
      setState("closed");
      setCloseReason("killed_by_close");
      setPrompt(null);
      setAttach(null);
    } catch (e) {
      setError(errorTextFromMessage(e instanceof Error ? e.message : String(e)));
    }
  }, [handle, onClose]);

  const reattach = useCallback(async () => {
    if (handle === null) return;
    try {
      setError(null);
      setAttach(await onAttach(handle));
    } catch (e) {
      setState("error");
      setError(errorTextFromMessage(e instanceof Error ? e.message : String(e)));
    }
  }, [handle, onAttach]);

  const decide = useCallback(
    async (fingerprint: string, accept: RdpDecision) => {
      if (handle === null) return;
      setDeciding(true);
      setError(null);
      try {
        await onDecision(handle, fingerprint, accept);
        setPrompt(null);
      } catch (e) {
        setError(errorTextFromMessage(e instanceof Error ? e.message : String(e)));
      } finally {
        setDeciding(false);
      }
    },
    [handle, onDecision],
  );

  const screenshot = useCallback(async () => {
    if (handle === null) return;
    try {
      setError(null);
      const shot = await onScreenshot(handle);
      onSavePng("rdp-" + shot.width + "x" + shot.height + "-" + shot.frameId + ".png", shot.png);
    } catch (e) {
      setError(errorTextFromMessage(e instanceof Error ? e.message : String(e)));
    }
  }, [handle, onScreenshot, onSavePng]);

  const live = handle !== null && state !== "closed" && state !== "error";
  const ready = state === "desktop_ready";

  return (
    <div className="rh-page">
      <form
        className="rh-form"
        onSubmit={(event) => {
          event.preventDefault();
          void connect();
        }}
      >
        <input aria-label="host" placeholder="host" value={host} onChange={(e) => setHost(e.target.value)} />
        <input aria-label="port" placeholder="3389" value={port} onChange={(e) => setPort(e.target.value)} className="rh-port" />
        <input aria-label="user" placeholder="user" value={username} onChange={(e) => setUsername(e.target.value)} />
        <input
          aria-label="password"
          placeholder="password"
          type="password"
          autoComplete="off"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <input aria-label="domain" placeholder="domain (optional)" value={domain} onChange={(e) => setDomain(e.target.value)} />
        <button type="submit" disabled={host === "" || username === "" || state === "connecting"}>
          Connect
        </button>
        {handle !== null && (
          <>
            <button type="button" onClick={() => void disconnect()} disabled={!live}>
              Disconnect
            </button>
            <button type="button" onClick={() => void reattach()} disabled={!live || attach === null}>
              Reattach
            </button>
          </>
        )}
      </form>
      <div className="rh-header">
        {endpoint !== null && (
          <span>
            target: <strong>{endpoint}</strong>
          </span>
        )}
        <span data-testid="rdp-state" role="status" aria-live="polite">
          state: <strong>{detached && state !== "closed" ? "detached" : stateText(state)}</strong>
        </span>
        {state === "closed" && closeReason !== null && <span data-testid="rdp-exit">{closeReasonText(closeReason)}</span>}
        {desktop !== null && (
          <span>
            desktop: {desktop.width}x{desktop.height}
          </span>
        )}
        {handle !== null && (
          <>
            <button type="button" onClick={() => setFit(fit === "fit" ? "actual" : "fit")} aria-pressed={fit === "actual"}>
              {fit === "fit" ? "1:1" : "Fit"}
            </button>
            <button type="button" onClick={() => canvasHandle.current?.sendCtrlAltDel()} disabled={!ready || attach === null}>
              Ctrl+Alt+Del
            </button>
            <button type="button" onClick={() => void screenshot()} disabled={!ready}>
              Screenshot
            </button>
          </>
        )}
      </div>
      {notice !== null && <p className="rh-notice">{notice}</p>}
      {error !== null && (
        <p className="rh-error" role="alert">
          {error}
        </p>
      )}
      {prompt !== null && <RdpCertDialog prompt={prompt} onDecide={(fp, accept) => void decide(fp, accept)} disabled={deciding} />}
      {attach !== null && (
        <>
          <div className="rh-rdp-wrap">
            <RdpCanvas
              key={attach.token}
              wsUrl={attach.wsUrl}
              token={attach.token}
              fit={fit}
              label={"remote desktop " + (endpoint ?? "")}
              onEvent={onCanvasEvent}
              handleRef={canvasHandle}
            />
          </div>
          <p className="rh-hint">Click the desktop to type into it. Keys go to the remote while it has focus (Escape too); click outside it to leave.</p>
        </>
      )}
    </div>
  );
}
