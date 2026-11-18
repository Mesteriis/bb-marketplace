// Host-free SSH connect form and session view. Real states only: connecting,
// running, detached, closed (with exit status), error.
import { useCallback, useEffect, useRef, useState } from "react";
import type { SessionHandle, SshTarget } from "../core/rpc.ts";
import { errorCodeText } from "../core/rdp-texts.ts";
import type { SshAskpassEvent } from "../core/ssh-askpass-protocol.ts";
import { ControlBadge, ControlNotice, HUMAN_CONTROL, nextControl, type ControlMessage, type ControlView } from "./control-banner.tsx";
import { SshPromptDialog, type SshPromptInfo } from "./ssh-prompt.tsx";
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
  /** The saved password or passphrase of the profile, if it has one. */
  credentialRef?: string;
}

export interface SshPageProps {
  onSshOpen: (target: SshTarget, profileId?: string, credentialRef?: string) => Promise<SessionHandle>;
  launch?: SshLaunch;
  onAttach: (handle: SessionHandle) => Promise<SshAttach>;
  onClose: (handle: SessionHandle) => Promise<void>;
  /** The owner takes the session back from an agent at once. */
  onTakeover?: (handle: SessionHandle) => Promise<void>;
}

type PageState = "idle" | "connecting" | "running" | "detached" | "closed" | "error";

/** Everything on screen for ONE session; replaced as a unit, so the endpoint
 *  shown, the handle Disconnect closes and the terminal attached never disagree. */
interface Session {
  target: SshTarget;
  handle: SessionHandle;
  attach: SshAttach | null;
}

export function SshPage(props: SshPageProps) {
  const { onSshOpen, onAttach, onClose } = props;
  const [host, setHost] = useState("");
  const [user, setUser] = useState("");
  const [port, setPort] = useState("");
  const [session, setSession] = useState<Session | null>(null);
  const [pending, setPending] = useState<SshTarget | null>(null);
  const [state, setState] = useState<PageState>("idle");
  const [exit, setExit] = useState<SshExitInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Questions OpenSSH asked (host key...) and what happened to a saved secret; per session.
  const [prompts, setPrompts] = useState<SshPromptInfo[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const control = useRef<((msg: unknown) => void) | null>(null);
  // Who drives the shown session: the human, until an agent takes it (stage 4b-1).
  const [owner, setOwner] = useState<ControlView>(HUMAN_CONTROL);
  const onControl = useCallback((message: ControlMessage) => setOwner((cur) => nextControl(cur, message)), []);
  // One guard for every way to open (Quick connect and the catalogue): the
  // latest request wins. An open that finishes after a newer one started is
  // closed at once, and a session replaced by a newer one is closed too, so
  // nothing is left running that nobody can see.
  const latest = useRef(0);
  const shown = useRef<Session | null>(null);
  shown.current = session;
  const closeQuietly = useCallback(
    (handle: SessionHandle) => {
      void onClose(handle).catch(() => undefined);
    },
    [onClose],
  );

  const onTerminalState = useCallback((next: SshTerminalState, info?: SshExitInfo) => {
    setState(next);
    if (info !== undefined) setExit(info);
  }, []);

  const onAskpass = useCallback((event: SshAskpassEvent) => {
    if (event.type === "prompt") {
      setPrompts((cur) => (cur.some((p) => p.promptId === event.promptId) ? cur : [...cur, { promptId: event.promptId, text: event.text, kind: event.kind }]));
    } else if (event.type === "prompt_expired") {
      setPrompts((cur) => cur.filter((p) => p.promptId !== event.promptId));
      setNotice(errorCodeText("prompt_expired"));
    } else if (event.type === "credential_rejected") {
      setNotice(errorCodeText("ssh_credential_rejected"));
    } else {
      setNotice(errorCodeText(event.code));
    }
  }, []);

  const answerPrompt = useCallback((promptId: number, answer: string | null) => {
    setPrompts((cur) => cur.filter((p) => p.promptId !== promptId));
    control.current?.({ type: "prompt_answer", promptId, answer });
  }, []);

  const open = useCallback(
    async (t: SshTarget, profileId?: string, credentialRef?: string) => {
      const mine = ++latest.current;
      setState("connecting");
      setError(null);
      setNotice(null);
      setPrompts([]);
      setExit(null);
      setOwner(HUMAN_CONTROL);
      setPending(t);
      let handle: SessionHandle;
      try {
        handle = await onSshOpen(t, profileId, credentialRef);
      } catch (e) {
        if (mine !== latest.current) return;
        setPending(null);
        setState("error");
        setError(e instanceof Error ? e.message : String(e));
        return;
      }
      if (mine !== latest.current) {
        closeQuietly(handle); // opened, but a newer request took over: never orphaned
        return;
      }
      const replaced = shown.current;
      if (replaced !== null) closeQuietly(replaced.handle);
      setPending(null);
      setSession({ target: t, handle, attach: null });
      try {
        const attach = await onAttach(handle);
        // Keyed by handle: a late attach can only land on its own session.
        setSession((cur) => (cur !== null && cur.handle === handle ? { ...cur, attach } : cur));
      } catch (e) {
        if (mine !== latest.current) return;
        setState("error");
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [onSshOpen, onAttach, closeQuietly],
  );

  const connect = useCallback(async () => {
    if (host.length === 0) return;
    // Keys that are not set are left out, not set to undefined: BB's RPC refuses an undefined value.
    await open({ host, ...(user !== "" ? { user } : {}), ...(port !== "" ? { port: Number(port) } : {}), extraOptions: [] });
  }, [host, user, port, open]);

  // A saved profile asked to open: show its endpoint in the form and connect.
  const lastLaunch = useRef<number | null>(null);
  useEffect(() => {
    if (props.launch === undefined || lastLaunch.current === props.launch.nonce) return;
    lastLaunch.current = props.launch.nonce;
    const { target: t, profileId, credentialRef } = props.launch;
    setHost(t.host);
    setUser(t.user ?? "");
    setPort(t.port === undefined ? "" : String(t.port));
    void open(t, profileId, credentialRef);
  }, [props.launch, open]);

  const disconnect = useCallback(async () => {
    if (session === null) return;
    try {
      await onClose(session.handle);
      setState("closed");
      setExit({ exitCode: null, signal: null, reason: "killed_by_close" });
      setSession((cur) => (cur !== null && cur.handle === session.handle ? { ...cur, attach: null } : cur));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [session, onClose]);

  const reattach = useCallback(async () => {
    if (session === null) return;
    const handle = session.handle;
    try {
      setState("connecting");
      const attach = await onAttach(handle);
      setSession((cur) => (cur !== null && cur.handle === handle ? { ...cur, attach } : cur));
    } catch (e) {
      setState("error");
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [session, onAttach]);

  const handle = session?.handle ?? null;
  const attach = session?.attach ?? null;
  const target = session?.target ?? pending;

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
        {attach !== null && state !== "closed" && <ControlBadge control={owner} />}
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
      {attach !== null && state !== "closed" && handle !== null && (
        <ControlNotice control={owner} onTakeover={async () => (props.onTakeover === undefined ? Promise.reject(new Error("not_found: taking control is not available")) : props.onTakeover(handle))} />
      )}
      {error !== null && <p className="rh-error">{error}</p>}
      {notice !== null && (
        <p role="alert" className="rh-error" data-testid="ssh-credential-notice">
          {notice}
        </p>
      )}
      {prompts.length > 0 && state !== "closed" && <SshPromptDialog prompt={prompts[0]} onAnswer={answerPrompt} />}
      {attach !== null && (
        <div className="rh-terminal-wrap">
          <SshTerminal wsUrl={attach.wsUrl} token={attach.token} onStateChange={onTerminalState} onAskpass={onAskpass} onControl={onControl} controlRef={control} />
        </div>
      )}
    </div>
  );
}
