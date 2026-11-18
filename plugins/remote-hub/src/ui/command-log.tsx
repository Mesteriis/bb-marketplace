// The commands an agent ran on a session, as the owner's live view shows them (stage 4b-2): the command text and its
// output as they happen, even when "record commands" is off (shown, not stored: this state lives in the open view only).
// Everything is rendered as text.
import type { FeedEvent } from "../core/agent-feed.ts";

export const MAX_LOG_COMMANDS = 12;
/** Characters of output kept per command (the head); more is dropped and said so. */
export const MAX_LOG_OUTPUT_CHARS = 20_000;

export interface LoggedCommand {
  id: string;
  /** null when the view opened after the command started. */
  command: string | null;
  chunks: Array<{ stream: "stdout" | "stderr"; text: string }>;
  truncated: boolean;
  running: boolean;
  exitCode: number | null;
  reason: string | null;
}

const keepNewest = (list: LoggedCommand[]): LoggedCommand[] => (list.length > MAX_LOG_COMMANDS ? list.slice(list.length - MAX_LOG_COMMANDS) : list);

export function applyExecEvent(list: LoggedCommand[], event: FeedEvent): LoggedCommand[] {
  if (event.kind !== "exec") return list;
  const index = list.findIndex((c) => c.id === event.commandId);
  const base: LoggedCommand = index >= 0 ? list[index]! : { id: event.commandId, command: null, chunks: [], truncated: false, running: true, exitCode: null, reason: null };
  let next = base;
  if (event.phase === "started") {
    next = { ...base, command: event.text };
  } else if (event.phase === "output" && event.stream !== undefined) {
    const used = base.chunks.reduce((n, c) => n + c.text.length, 0);
    const room = MAX_LOG_OUTPUT_CHARS - used;
    const kept = event.text.slice(0, Math.max(0, room));
    next = { ...base, chunks: kept.length > 0 ? [...base.chunks, { stream: event.stream, text: kept }] : base.chunks, truncated: base.truncated || kept.length < event.text.length };
  } else if (event.phase === "finished") {
    next = { ...base, running: false, exitCode: event.exitCode ?? null, reason: event.reason ?? null };
  }
  return keepNewest(index >= 0 ? list.map((c, i) => (i === index ? next : c)) : [...list, next]);
}

export function CommandLog({ commands }: { commands: LoggedCommand[] }) {
  if (commands.length === 0) return null;
  return (
    <section aria-label="Commands an agent ran" className="rh-commands">
      <h4>Commands an agent ran</h4>
      {commands.map((c, i) => (
        <div key={c.id} className="rh-command">
          <pre className="rh-command-line">{c.command === null ? "(a command that started before this view opened)" : "$ " + c.command}</pre>
          {c.chunks.length > 0 && (
            <pre className="rh-command-output">
              {c.chunks.map((chunk, j) => (
                <span key={j} data-testid={chunk.stream === "stderr" ? `stderr-${i}` : undefined} className={chunk.stream === "stderr" ? "rh-command-err" : undefined}>
                  {chunk.text}
                </span>
              ))}
            </pre>
          )}
          <p className="rh-hint">
            {c.running ? "running…" : c.exitCode !== null ? `exit ${c.exitCode}` : `stopped: ${c.reason ?? "ended"}`}
            {c.truncated ? " · output cut here (the agent can read the rest)" : ""}
          </p>
        </div>
      ))}
    </section>
  );
}
