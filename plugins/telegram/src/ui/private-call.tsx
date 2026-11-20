import { useTelegramLocale } from "./i18n/index.tsx";
import { Mic, MicOff, Phone, PhoneOff, Video, VideoOff } from "lucide-react";
import { useState } from "react";
import type { PrivateCall, PrivateCallAction, PrivateCallStatus } from "../core/contract.ts";
import { Button } from "../../components/ui/button.tsx";
import { CallVideo, LocalCallCamera } from "./private-call-video.tsx";

export type PrivateCallControls = PrivateCallStatus & {
  start: (chatId: string, video: boolean) => Promise<boolean>;
  act: (id: number | undefined, action: PrivateCallAction) => Promise<boolean>;
};

const phaseLabel: Record<PrivateCall["phase"], string> = {
  incoming: "Incoming Telegram call", calling: "Calling…", connecting: "Connecting…",
  active: "Voice call", ending: "Ending call…", failed: "Call could not connect", ended: "Call ended",
};

export function CallContact({ chatId, controls }: { chatId: string; controls: PrivateCallControls }) {
  const { t: tr } = useTelegramLocale();
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const busy = controls.call && !["ended", "failed"].includes(controls.call.phase);
  async function start(video: boolean) {
    setPending(true);
    setFailed(false);
    try { setFailed(!await controls.start(chatId, video)); }
    catch { setFailed(true); }
    finally { setPending(false); }
  }
  return <>
    <Button type="button" variant="ghost" size="icon" aria-label={tr("Start voice call")}
      disabled={pending || !!busy} onClick={() => void start(false)}>
      <Phone size={18} aria-hidden="true" />
    </Button>
    <Button type="button" variant="ghost" size="icon" aria-label={tr("Start video call")}
      disabled={pending || !!busy} onClick={() => void start(true)}>
      <Video size={18} aria-hidden="true" />
    </Button>
    {failed && !controls.call && <span role="alert">{tr("Call unavailable for this chat.")}</span>}
  </>;
}

export function PrivateCallBanner({ call, act, frameRoute }: { call: PrivateCall; act: PrivateCallControls["act"]; frameRoute?: string }) {
  const { t: tr } = useTelegramLocale();
  const [pending, setPending] = useState<PrivateCallAction>();
  const [error, setError] = useState(false);
  const done = call.phase === "ended" || call.phase === "failed";

  async function run(action: PrivateCallAction) {
    setPending(action);
    setError(false);
    try { setError(!await act(call.id, action)); }
    catch { setError(true); }
    finally { setPending(undefined); }
  }

  const label = call.video && call.phase === "incoming" ? tr("Incoming video call")
    : call.video && call.phase === "active" ? tr("Video call") : phaseLabel[call.phase];
  return <aside className="mtg-message-notification" aria-label={tr("Telegram call")}>
    <div role="status"><strong>{label}</strong> <bdi>{call.name}</bdi></div>
    {call.phase === "active" && call.frameTicket && frameRoute && <div className="mtg-call-video">
      <CallVideo route={frameRoute} ticket={call.frameTicket} />
      {call.cameraTicket && <LocalCallCamera route={frameRoute} ticket={call.cameraTicket} />}
    </div>}
    {call.phase === "active" && call.emojis.length === 4 &&
      <div aria-label={tr("Call encryption fingerprint")}>{call.emojis.join(" ")}</div>}
    {call.phase === "incoming" && <>
      {call.video && <button type="button" className="mtg-action" disabled={pending !== undefined}
        onClick={() => void run("accept-video")}>{tr("Answer with video")}</button>}
      <button type="button" className="mtg-action" disabled={pending !== undefined}
        onClick={() => void run("accept")}>{call.video ? tr("Answer without camera") : tr("Answer")}</button>
    </>}
    {call.phase === "active" && <Button type="button" variant="ghost" size="icon" disabled={pending !== undefined}
      aria-label={call.muted ? tr("Unmute microphone") : tr("Mute microphone")} onClick={() => void run(call.muted ? "unmute" : "mute")}>
      {call.muted ? <MicOff size={18} aria-hidden="true" /> : <Mic size={18} aria-hidden="true" />}
    </Button>}
    {call.phase === "active" && call.video && <Button type="button" variant="ghost" size="icon" disabled={pending !== undefined}
      aria-label={call.camera ? tr("Turn camera off") : tr("Turn camera on")} onClick={() => void run(call.camera ? "camera-off" : "camera-on")}>
      {call.camera ? <Video size={18} aria-hidden="true" /> : <VideoOff size={18} aria-hidden="true" />}
    </Button>}
    {done ? <button type="button" className="mtg-action" onClick={() => void run("dismiss")}>{tr("Dismiss")}</button>
      : <Button type="button" variant="destructive" size="icon" aria-label={call.phase === "incoming" ? tr("Decline call") : tr("End call")}
        disabled={pending === "end" || call.phase === "ending"} onClick={() => void run("end")}>
        <PhoneOff size={18} aria-hidden="true" />
      </Button>}
    {error && <span role="alert">{tr("Could not update the call.")}</span>}
    {call.cameraUnavailable && !done && <span role="status">{tr("Camera unavailable")}</span>}
  </aside>;
}
