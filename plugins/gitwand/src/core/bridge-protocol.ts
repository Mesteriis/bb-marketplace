// The stdio protocol between the plugin server and gitwand-bridge: one JSON
// object per line in each direction.
//   request:  {"id":n,"cmd":"git_status","args":{...}}
//   result:   {"id":n,"ok":<value>} | {"id":n,"error":<value>}
//   channel:  {"channel":n,"message":<value>}  (tauri::ipc::Channel output)
import { z } from "zod";

const COMMAND_NAME = /^[a-z_][a-z0-9_]*$/;

/** One request line, newline included. Throws on a name the bridge cannot know. */
export function encodeBridgeRequest(id: number, cmd: string, args: Record<string, unknown>): string {
  if (!COMMAND_NAME.test(cmd)) throw new Error(`invalid bridge command name: ${JSON.stringify(cmd)}`);
  return JSON.stringify({ id, cmd, args }) + "\n";
}

export type BridgeLine =
  | { kind: "result"; id: number; ok: true; value: unknown }
  | { kind: "result"; id: number; ok: false; error: unknown }
  | { kind: "channel"; channel: number; message: unknown }
  | { kind: "invalid"; reason: string };

const counter = z.number().int().nonnegative();
const resultLine = z.object({ id: counter });
const channelLine = z.object({ channel: counter });

/** Classifies one stdout line; never throws, so a stray line cannot stop the reader. */
export function parseBridgeLine(line: string): BridgeLine {
  let data: unknown;
  try {
    data = JSON.parse(line);
  } catch {
    return { kind: "invalid", reason: "not JSON" };
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) return { kind: "invalid", reason: "not an object" };
  const fields = data as Record<string, unknown>;
  const channel = channelLine.safeParse(data);
  if (channel.success && "message" in fields) return { kind: "channel", channel: channel.data.channel, message: fields.message };
  const result = resultLine.safeParse(data);
  if (result.success && "ok" in fields) return { kind: "result", id: result.data.id, ok: true, value: fields.ok };
  if (result.success && "error" in fields) return { kind: "result", id: result.data.id, ok: false, error: fields.error };
  return { kind: "invalid", reason: "neither a result nor a channel message" };
}
