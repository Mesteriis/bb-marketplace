// Host-free RDP connect form and session view. Real states only: the service's
// own states (connecting, tls, cert_prompt, authenticating, desktop_ready,
// closed) plus detached / error for the page's socket. The password lives in
// the form field only until Connect is pressed: it is cleared from component
// state at once and never shown again.
import { useCallback, useEffect, useRef, useState } from "react";
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

/** A saved profile to fill into the form: a new `nonce` means a new request. The password is never part of it. */
export interface RdpPrefill {
  nonce: number;
  profileId: string;
  host: string;
  port: number;
  username: string;
  domain: string | null;
  width: number | null;
  height: number | null;
}

export interface RdpPageProps {
  onRdpOpen: (target: RdpConnectTarget, size: { width: number; height: number }, profileId?: string) => Promise<SessionHandle>;
  prefill?: RdpPrefill;
  onAttach: (handle: SessionHandle) => Promise<RdpAttach>;
  /** The service's close result; its reason is what the page shows. */
  onClose: (handle: SessionHandle) => Promise<{ reason?: string | null } | void>;
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

/** Everything the page shows and drives for ONE session; replaced as a unit, so the
 *  endpoint on screen, the session handle and the input socket never disagree. */
interface SessionView {
  handle: SessionHandle;
  attach: RdpAttach | null;
  endpoint: string;
  state: string;
  prompt: RdpCertPromptInfo | null;
  desktop: { width: number; height: number } | null;
  closeReason: string | null;
  detached: boolean;
}

export function RdpPage(props: RdpPageProps) {
  const { onRdpOpen, onAttach, onClose, onDecision, onScreenshot, onSavePng = downloadPng } = props;
  const [host, setHost] = useState("");
  const [port, setPort] = useState("");
  const [username, setUsername] = useState("");
  const [domain, setDomain] = useState("");
  const [password, setPassword] = useState("");
  // The session on screen. A connection in progress to another endpoint does NOT
  // replace it until that session is open: until then the old view keeps its own
  // endpoint, handle and input socket.
  const [view, setView] = useState<SessionView | null>(null);
  const [connecting, setConnecting] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fit, setFit] = useState<FitMode>("fit");
  const [deciding, setDeciding] = useState(false);
  const canvasHandle = useRef<RdpCanvasHandle | null>(null);
  const passwordInput = useRef<HTMLInputElement | null>(null);
  // The saved profile the form currently stands for; editing the endpoint ends it.
  const linked = useRef<{ profileId: string; size: { width: number; height: number } | null } | null>(null);
  const edit = (set: (value: string) => void) => (value: string) => {
    linked.current = null;
    set(value);
  };
  const lastPrefill = useRef<number | null>(null);
  useEffect(() => {
    const fill = props.prefill;
    if (fill === undefined || lastPrefill.current === fill.nonce) return;
    lastPrefill.current = fill.nonce;
    setHost(fill.host);
    setPort(String(fill.port));
    setUsername(fill.username);
    setDomain(fill.domain ?? "");
    setPassword("");
    linked.current = { profileId: fill.profileId, size: fill.width !== null && fill.height !== null ? { width: fill.width, height: fill.height } : null };
    passwordInput.current?.focus();
  }, [props.prefill]);

  const patch = useCallback((change: Partial<SessionView>) => setView((v) => (v === null ? v : { ...v, ...change })), []);

  const onCanvasEvent = useCallback(
    (event: RdpCanvasEvent) => {
      switch (event.type) {
        case "socket":
          patch({ detached: event.state === "detached" });
          if (event.state === "error") setError("the connection to the page's socket failed");
          break;
        case "attached":
          setView((v) =>
            v === null
              ? v
              : {
                  ...v,
                  detached: false,
                  state: event.state,
                  prompt: event.state === "cert_prompt" ? event.prompt : null,
                  desktop: event.desktop !== null ? { width: event.desktop.width, height: event.desktop.height } : v.desktop,
                },
          );
          break;
        case "state":
          setView((v) => (v === null ? v : { ...v, state: event.state, prompt: event.state === "cert_prompt" ? v.prompt : null }));
          break;
        case "cert_prompt":
          patch({ prompt: event.prompt });
          break;
        case "desktop":
          patch({ desktop: { width: event.width, height: event.height } });
          break;
        case "closed":
          // The first recorded reason stays: a later event must not replace it.
          setView((v) => (v === null || v.state === "closed" ? v : { ...v, state: "closed", prompt: null, closeReason: event.reason }));
          break;
        case "error":
          setError(errorCodeText(event.code));
          break;
        case "notice":
          setNotice(event.text);
          break;
      }
    },
    [patch],
  );

  const connect = useCallback(async () => {
    const portNumber = port === "" ? 3389 : Number(port);
    if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535) {
      setError("port must be a whole number from 1 to 65535");
      return;
    }
    // The password leaves component state HERE; only this call's closure holds it.
    const secret = password;
    setPassword("");
    setError(null);
    setNotice(null);
    const endpoint = username + "@" + host + ":" + portNumber;
    setConnecting(endpoint);
    let handle: SessionHandle;
    try {
      const target: RdpConnectTarget = { host, port: portNumber, username, password: secret, ...(domain !== "" ? { domain } : {}) };
      const link = linked.current;
      handle = await onRdpOpen(target, link?.size ?? DESKTOP_SIZE, link?.profileId);
    } catch (e) {
      setConnecting(null);
      setError(errorTextFromMessage(e instanceof Error ? e.message : String(e)));
      return;
    }
    // The session is open: it is now THE session on screen, whether or not the
    // first attach works (a failed attach leaves Reattach and Disconnect available).
    setView({ handle, attach: null, endpoint, state: "connecting", prompt: null, desktop: null, closeReason: null, detached: false });
    setConnecting(null);
    try {
      const attach = await onAttach(handle);
      patch({ attach });
    } catch (e) {
      patch({ detached: true });
      setError(errorTextFromMessage(e instanceof Error ? e.message : String(e)));
    }
  }, [host, port, username, domain, password, onRdpOpen, onAttach, patch]);

  const disconnect = useCallback(async () => {
    if (view === null) return;
    const handle = view.handle;
    try {
      const result = await onClose(handle);
      // Keep a reason the session already ended with; otherwise the service's own.
      setView((v) =>
        v === null || v.handle !== handle || v.state === "closed"
          ? v
          : { ...v, state: "closed", prompt: null, attach: null, closeReason: (result && result.reason) || "killed_by_close" },
      );
    } catch (e) {
      setError(errorTextFromMessage(e instanceof Error ? e.message : String(e)));
    }
  }, [view, onClose]);

  const reattach = useCallback(async () => {
    if (view === null) return;
    const handle = view.handle;
    try {
      setError(null);
      const attach = await onAttach(handle);
      setView((v) => (v !== null && v.handle === handle ? { ...v, attach, detached: false } : v));
    } catch (e) {
      patch({ detached: true });
      setError(errorTextFromMessage(e instanceof Error ? e.message : String(e)));
    }
  }, [view, onAttach, patch]);

  const decide = useCallback(
    async (fingerprint: string, accept: RdpDecision) => {
      if (view === null) return;
      setDeciding(true);
      setError(null);
      try {
        await onDecision(view.handle, fingerprint, accept);
        patch({ prompt: null });
      } catch (e) {
        setError(errorTextFromMessage(e instanceof Error ? e.message : String(e)));
      } finally {
        setDeciding(false);
      }
    },
    [view, onDecision, patch],
  );

  const screenshot = useCallback(async () => {
    if (view === null) return;
    try {
      setError(null);
      const shot = await onScreenshot(view.handle);
      onSavePng("rdp-" + shot.width + "x" + shot.height + "-" + shot.frameId + ".png", shot.png);
    } catch (e) {
      setError(errorTextFromMessage(e instanceof Error ? e.message : String(e)));
    }
  }, [view, onScreenshot, onSavePng]);

  const state = view?.state ?? (connecting !== null ? "connecting" : error !== null ? "error" : "idle");
  const live = view !== null && view.state !== "closed";
  const ready = view?.state === "desktop_ready";
  const prompt = view?.prompt ?? null;

  return (
    <div className="rh-page">
      <div className="rh-rdp-main" inert={prompt !== null}>
        <form
          className="rh-form"
          onSubmit={(event) => {
            event.preventDefault();
            void connect();
          }}
        >
          <input aria-label="host" placeholder="host" value={host} onChange={(e) => edit(setHost)(e.target.value)} />
          <input aria-label="port" placeholder="3389" value={port} onChange={(e) => edit(setPort)(e.target.value)} className="rh-port" />
          <input aria-label="user" placeholder="user" value={username} onChange={(e) => edit(setUsername)(e.target.value)} />
          <input
            aria-label="password"
            placeholder="password"
            type="password"
            autoComplete="off"
            ref={passwordInput}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <input aria-label="domain" placeholder="domain (optional)" value={domain} onChange={(e) => edit(setDomain)(e.target.value)} />
          <button type="submit" disabled={host === "" || username === "" || connecting !== null}>
            Connect
          </button>
          {view !== null && (
            <>
              <button type="button" onClick={() => void disconnect()} disabled={!live}>
                Disconnect
              </button>
              <button type="button" onClick={() => void reattach()} disabled={!live}>
                Reattach
              </button>
            </>
          )}
        </form>
        <div className="rh-header">
          {view !== null && (
            <span>
              target: <strong>{view.endpoint}</strong>
            </span>
          )}
          <span data-testid="rdp-state" role="status" aria-live="polite">
            state: <strong>{view !== null && view.detached && state !== "closed" ? "detached" : stateText(state)}</strong>
          </span>
          {connecting !== null && view !== null && <span data-testid="rdp-connecting">connecting to {connecting}…</span>}
          {view !== null && view.state === "closed" && view.closeReason !== null && <span data-testid="rdp-exit">{closeReasonText(view.closeReason)}</span>}
          {view?.desktop != null && (
            <span>
              desktop: {view.desktop.width}x{view.desktop.height}
            </span>
          )}
          {view !== null && (
            <>
              <button type="button" onClick={() => setFit(fit === "fit" ? "actual" : "fit")} aria-pressed={fit === "actual"}>
                {fit === "fit" ? "1:1" : "Fit"}
              </button>
              <button type="button" onClick={() => canvasHandle.current?.sendCtrlAltDel()} disabled={!ready || view.attach === null}>
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
        {view !== null && view.attach !== null && (
          <>
            <div className="rh-rdp-wrap">
              <RdpCanvas
                key={view.attach.token}
                wsUrl={view.attach.wsUrl}
                token={view.attach.token}
                fit={fit}
                label={"remote desktop " + view.endpoint}
                onEvent={onCanvasEvent}
                handleRef={canvasHandle}
              />
            </div>
            <p className="rh-hint">
              Click the desktop to type into it. Keys go to the remote while it has focus (Tab and Escape too); press Ctrl+Alt+Shift+Escape or click outside it to leave.
            </p>
          </>
        )}
      </div>
      {prompt !== null && <RdpCertDialog prompt={prompt} onDecide={(fp, accept) => void decide(fp, accept)} disabled={deciding} />}
    </div>
  );
}
