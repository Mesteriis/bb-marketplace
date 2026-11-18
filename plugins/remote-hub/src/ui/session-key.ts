import type { SessionHandle } from "../core/rpc.ts";

/** The id in a directive is text an agent wrote: only `generation.number` is a session, anything else is refused. */
export function parseSessionKey(text: string | undefined): SessionHandle | null {
  const m = typeof text === "string" ? /^([0-9a-f]{32})\.(\d{1,9})$/.exec(text) : null;
  return m === null ? null : { generation: m[1] as string, sessionId: Number(m[2]) };
}
