// Opening the live view for the owner without a click (stage 4c). BB lets a plugin open one of its registered side-panel
// tabs from app code (`experimental_useAppPanel().openTab`); it answers false when this screen has no side panel, and
// then the standing banner is the way the owner learns of the agent. Host-free: the panel is injected.
export const LIVE_TAB_ID = "remote-session-live";

export interface RevealPanel {
  openTab(options: { tab: { id: string; context: { kind: "thread" }; availability: "action" }; params: { sessionId: string }; title: string }): boolean;
}

/** Opens the tab for `sessionKey` once; returns whether BB opened it. A decline is remembered for nothing. */
export function revealSession(panel: RevealPanel, sessionKey: string, seen: Set<string>): boolean {
  if (seen.has(sessionKey)) return false;
  let opened = false;
  try {
    opened = panel.openTab({ tab: { id: LIVE_TAB_ID, context: { kind: "thread" }, availability: "action" }, params: { sessionId: sessionKey }, title: "Remote session" });
  } catch {
    opened = false;
  }
  if (opened) seen.add(sessionKey);
  return opened;
}
