// Who drives a session, as the page shows it (stage 4b-1): a badge in the session header, and while an agent holds the
// session a notice with one button that takes it back at once. The service drops the human's input while an agent holds
// the lease; the first keystroke or click after that makes the notice an alert.
import { useCallback, useState } from "react";
import { errorTextFromMessage } from "../core/rdp-texts.ts";

export interface ControlView {
  owner: "human" | "agent";
  /** Epoch ms the agent's lease runs out; null while the human drives. */
  expiresAt: number | null;
  /** The human typed or clicked while an agent held the session: it was not sent. */
  blocked: boolean;
}
export type ControlMessage = { type: "control"; owner: "human" | "agent"; expiresAt: number | null } | { type: "input_blocked" };

export const HUMAN_CONTROL: ControlView = { owner: "human", expiresAt: null, blocked: false };

export function nextControl(current: ControlView, message: ControlMessage): ControlView {
  if (message.type === "control") return message.owner === "human" ? HUMAN_CONTROL : { owner: "agent", expiresAt: message.expiresAt, blocked: current.owner === "agent" && current.blocked };
  return current.owner === "agent" ? { ...current, blocked: true } : current;
}

export function ControlBadge({ control }: { control: ControlView }) {
  const until = control.owner === "agent" && control.expiresAt !== null ? ` (until ${new Date(control.expiresAt).toLocaleTimeString()})` : "";
  return (
    <span data-testid="control-owner" className={control.owner === "agent" ? "rh-badge rh-badge-agent" : "rh-badge"}>
      {control.owner === "agent" ? "driven by an agent" + until : "driven by you"}
    </span>
  );
}

export function ControlNotice({ control, onTakeover }: { control: ControlView; onTakeover: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const take = useCallback(() => {
    setBusy(true);
    setFailure(null);
    onTakeover()
      .catch((e: unknown) => setFailure(errorTextFromMessage(e instanceof Error ? e.message : String(e))))
      .finally(() => setBusy(false));
  }, [onTakeover]);
  if (control.owner === "human") return null;
  return (
    <div className="rh-control-notice">
      {control.blocked ? (
        <p role="alert" className="rh-error">
          Your input was not sent because an agent is driving this session.
        </p>
      ) : (
        <p role="status" className="rh-notice">
          An agent is driving this session, so your keyboard and mouse are paused.
        </p>
      )}
      <button type="button" onClick={take} disabled={busy}>
        Take control
      </button>
      {failure !== null && (
        <p role="alert" className="rh-error">
          Could not take control: {failure}
        </p>
      )}
    </div>
  );
}
