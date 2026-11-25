/**
 * Plugin settings that tune the MCP runtime. BB settings have no number type,
 * so both arrive as text and are parsed here.
 */

export const DEFAULT_IDLE_STOP_MINUTES = 10;
export const DEFAULT_CONNECT_TIMEOUT_SECONDS = 60;

const MAX_IDLE_STOP_MS = 24 * 60 * 60_000;
const MIN_CONNECT_TIMEOUT_MS = 5_000;
const MAX_CONNECT_TIMEOUT_MS = 10 * 60_000;

function parseNumber(raw: string | undefined): number | null {
  const text = raw?.trim() ?? "";
  if (!/^\d+(\.\d+)?$/u.test(text)) return null;
  return Number(text);
}

/** Minutes without a request before a stdio MCP server is stopped; 0 turns stopping off. */
export function idleStopMsFromSetting(raw: string | undefined): number {
  const minutes = parseNumber(raw) ?? DEFAULT_IDLE_STOP_MINUTES;
  return Math.min(Math.round(minutes * 60_000), MAX_IDLE_STOP_MS);
}

/** Seconds an MCP server may take to start and list its capabilities. */
export function connectTimeoutMsFromSetting(raw: string | undefined): number {
  const seconds = parseNumber(raw);
  if (seconds === null || seconds === 0) return DEFAULT_CONNECT_TIMEOUT_SECONDS * 1_000;
  return Math.min(Math.max(Math.round(seconds * 1_000), MIN_CONNECT_TIMEOUT_MS), MAX_CONNECT_TIMEOUT_MS);
}
