// How a session's state reads at a glance: the colour of its dot in the sidebar, the pane header and a card.
import type { DeskSession } from "./desk.ts";

export type Tone = "ok" | "warn" | "bad" | "agent" | "idle";

export function toneOf(session: Pick<DeskSession, "state" | "owner">): Tone {
  switch (session.state) {
    case "active":
      return session.owner === "agent" ? "agent" : "ok";
    case "connecting":
    case "waiting":
    case "reconnecting":
      return "warn";
    case "lost":
    case "error":
      return "bad";
    case "disconnected":
    case "not_connected":
      return "idle";
  }
}
