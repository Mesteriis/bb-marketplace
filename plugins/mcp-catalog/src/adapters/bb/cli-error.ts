const MAX_LINES = 20;
const MAX_CHARS = 2000;
const SECRET_KEY = /KEY|TOKEN|SECRET|PASS|CRED|AUTH/i;
const MIN_SECRET_LENGTH = 4;

/**
 * The message of a failed `bb` call: the tail of stderr (the last lines carry the reason), capped in lines and
 * characters, with the values of secret-looking environment variables masked. Falls back to `fallback` when
 * stderr is empty.
 */
export function cliErrorMessage(stderr: string, fallback: string, env: NodeJS.ProcessEnv = process.env): string {
  let lines = stderr.split("\n").map((line) => line.trimEnd()).filter((line) => line.trim() !== "");
  if (lines.length === 0) return fallback;
  const cut = lines.length > MAX_LINES;
  if (cut) lines = lines.slice(-MAX_LINES);
  let text = lines.join("\n").trim();
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && value.length >= MIN_SECRET_LENGTH && SECRET_KEY.test(key)) text = text.replaceAll(value, "***");
  }
  if (cut) text = `…\n${text}`;
  return text.length > MAX_CHARS ? `…${text.slice(-(MAX_CHARS - 1))}` : text;
}
