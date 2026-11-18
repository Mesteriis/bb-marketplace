// Watching an agent's session beside the agent's thread (stage 4c). BB cannot place a plugin page in a split pane from
// code, but it can place a THREAD there: so the live session opens in the main pane and the agent's thread in a split
// pane beside it. Host-free: the navigation and the layout are injected.
//
// What BB's own contract says (bb-plugin-sdk-app.d.ts): `toThread(id, { split: true })` applies BB's split placement
// rules and "falls back to plain navigation where splits are off"; it returns nothing, so the result is read from
// `useSidebarSplitLayout()` afterwards.
import type { AgentSessionView } from "./agent-panel.tsx";

export interface SplitNav {
  toPluginPanel(path: string, options?: { subPath?: string }): void;
  toThread(threadId: string, options?: { split?: boolean }): void;
}

export interface SplitLayout {
  panes: ReadonlyArray<{ threadId: string | null; isFocused: boolean }>;
}

/** The plugin page that shows one session (a nav panel's path and its sub-path). */
export const SESSION_PAGE = "ssh";

/** The thread that is working on this session: the one holding the lease, else the one that opened it. */
export function agentThreadOf(s: Pick<AgentSessionView, "leaseThreadId" | "openedByThread">): string | null {
  return s.leaseThreadId ?? s.openedByThread;
}

/** The thread the owner is looking at: the focused split pane's thread, else the surface's own thread. */
export function focusedThread(layout: SplitLayout | null, contextThread: string | null): string | null {
  const pane = layout?.panes.find((p) => p.isFocused);
  return pane !== undefined ? pane.threadId : contextThread;
}

/** True when the agent's thread sits in a pane of a real split (two panes or more). */
export function splitShows(layout: SplitLayout | null, agentThread: string): boolean {
  return layout !== null && layout.panes.length >= 2 && layout.panes.some((p) => p.threadId === agentThread);
}

/** Automatic opening only while the owner is already looking at that agent's thread, once per session. */
export function mayAutoSplit(args: { focused: string | null; agentThread: string | null; key: string; done: Set<string> }): boolean {
  return args.agentThread !== null && args.focused === args.agentThread && !args.done.has(args.key);
}

/**
 * On a signal that an agent did something with `key`: open the split only if the owner is looking at that agent's thread.
 * Anywhere else nothing moves (the banner tells the owner instead).
 */
export async function autoSplitOnSignal(args: {
  key: string;
  listSessions: () => Promise<AgentSessionView[]>;
  layout: () => SplitLayout | null;
  contextThread: () => string | null;
  done: Set<string>;
  watchInSplit: (sessionKey: string, agentThread: string | null) => Promise<unknown>;
}): Promise<"opened" | "skipped"> {
  const [generation, number] = args.key.split(".");
  const s = (await args.listSessions()).find((x) => x.generation === generation && String(x.sessionId) === number);
  if (s === undefined || s.state === "closed") return "skipped";
  const thread = agentThreadOf(s);
  if (!mayAutoSplit({ focused: focusedThread(args.layout(), args.contextThread()), agentThread: thread, key: args.key, done: args.done })) return "skipped";
  args.done.add(args.key);
  await args.watchInSplit(args.key, thread);
  return "opened";
}

export interface SplitOutcome {
  result: "split" | "no_thread" | "fallback";
}

/**
 * The live view in the main pane, then the agent's thread in a split beside it. Splits that BB does not honour are
 * detected afterwards: the live view is put back on screen (`toThread` fell back to plain navigation) and `fallback` is
 * returned so the caller can show a link to the thread instead.
 */
export async function openWatchInSplit(args: {
  nav: SplitNav;
  sessionKey: string;
  agentThread: string | null;
  isSplit: (agentThread: string) => boolean;
  /** True while the owner is still where we put them (the session page or the agent's thread); false once they went elsewhere. */
  stillHere?: () => boolean;
  wait?: (ms: number) => Promise<void>;
  settleMs?: number;
}): Promise<SplitOutcome> {
  const { nav, sessionKey, agentThread } = args;
  nav.toPluginPanel(SESSION_PAGE, { subPath: sessionKey });
  if (agentThread === null) return { result: "no_thread" };
  nav.toThread(agentThread, { split: true });
  await (args.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms))))(args.settleMs ?? 1200);
  if (args.isSplit(agentThread)) return { result: "split" };
  // The owner may have gone somewhere else during the wait: never drag them back.
  if (args.stillHere !== undefined && !args.stillHere()) return { result: "fallback" };
  nav.toPluginPanel(SESSION_PAGE, { subPath: sessionKey });
  return { result: "fallback" };
}
