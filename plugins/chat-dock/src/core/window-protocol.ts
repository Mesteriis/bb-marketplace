// Lines the ChatGPT window writes to its standard output. The window is a
// separate native process; anything it sends is parsed here and nothing
// else is trusted. It sends only addresses, results of the plugin's own page
// scripts and which of its own buttons the user pressed — never page text.

export type PanelAction = "insert" | "rebind" | "dismiss";

export type WindowMessage =
  | { type: "ready" }
  | { type: "url"; url: string }
  | { type: "result"; id: string; ok: boolean; value: unknown }
  | { type: "pressed"; action: PanelAction }
  | { type: "copied"; ok: boolean }
  | { type: "closed" };

/** What the window's bottom panel shows. Sent to the window, never to BB. */
export interface PanelView {
  visible: boolean;
  status: string;
  /** The exact text that would be inserted or copied. */
  text: string;
  canInsert: boolean;
  canRebind: boolean;
  canCopy: boolean;
  busy: boolean;
  dismissLabel: string;
}

export const MAX_LINE_LENGTH = 1_000_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const ACTIONS: readonly PanelAction[] = ["insert", "rebind", "dismiss"];

/** Null for anything that is not exactly one known message. */
export function parseWindowMessage(line: string): WindowMessage | null {
  if (line.length === 0 || line.length > MAX_LINE_LENGTH) return null;
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  switch (value.type) {
    case "ready":
    case "closed":
      return { type: value.type };
    case "url":
      return typeof value.url === "string" ? { type: "url", url: value.url } : null;
    case "result":
      if (typeof value.id !== "string" || typeof value.ok !== "boolean") return null;
      return { type: "result", id: value.id, ok: value.ok, value: value.value ?? null };
    case "pressed": {
      const action = ACTIONS.find((known) => known === value.action);
      return action === undefined ? null : { type: "pressed", action };
    }
    case "copied":
      return typeof value.ok === "boolean" ? { type: "copied", ok: value.ok } : null;
    default:
      return null;
  }
}
