// Who drives a session, as the page shows it (stage 4b-1): a badge in the session header, and while an agent holds the
// session the overlay (agent-overlay.tsx) with one button that takes it back at once. The service drops the human's input
// while an agent holds the lease; the first keystroke or click after that makes the overlay say so.
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
