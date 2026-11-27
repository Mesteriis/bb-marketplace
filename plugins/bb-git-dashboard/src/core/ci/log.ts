const ansi = /\u001b\[[0-9;?]*[ -\/]*[@-~]/g;
const stamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z ?/;
/** `##[error]` from GitHub, Gitea and Azure runners; `ERROR:` (or `ERROR ` from a job's own script) on GitLab. */
const marker = /^(?:##\[error\]|ERROR[: ])/;
/** After a GitLab runner's timestamp: the stream number, O(ut) or E(rr), and + for a continued line. */
const stream = /^[0-9a-f]{2}[OE](?:\+| )/;
/** GitLab's collapsible section markers, which precede the section's first line. */
const section = /section_(?:start|end):\d+:[\w.\-\[\]=,]*\r?/g;

/** Removes ANSI colours, carriage returns and the runner's leading timestamps. */
export function cleanLog(text: string) {
  return text.replace(ansi, "").replace(section, "").split(/\r?\n/).map(line => {
    const plain = line.replace(/\r/g, "");
    const rest = plain.replace(stamp, "");
    return rest === plain ? rest : rest.replace(stream, "");
  }).join("\n");
}

/** The runner's own closing line, chosen only when nothing else failed. */
const closing = /^(?:##\[error\]Process completed with exit code \d+\.?|ERROR: Job failed: .*)$/;

/**
 * Index of the last error marker (`##[error]`, used by GitHub, Gitea and Azure runners), or null. The runner's own
 * closing "Process completed with exit code N" line is chosen only when no other error was logged.
 */
export function errorLine(lines: string[]): number | null {
  let fallback: number | null = null;
  for (let index = lines.length - 1; index >= 0; index--) {
    if (!marker.test(lines[index])) continue;
    if (!closing.test(lines[index])) return index;
    fallback ??= index;
  }
  return fallback;
}

/** Up to `count` lines ending at the error line, with consecutive repeats (progress spinners) collapsed. */
export function errorExcerpt(lines: string[], at: number, count = 40) {
  const kept: string[] = [];
  for (const line of lines.slice(0, at + 1)) if (kept[kept.length - 1] !== line) kept.push(line);
  return kept.slice(-count);
}

/** The last `max` characters, cut at a line start. */
export function logTail(text: string, max: number) {
  if (text.length <= max) return {text, truncated: false};
  const tail = text.slice(-max);
  const cut = tail.indexOf("\n");
  return {text: cut >= 0 ? tail.slice(cut + 1) : tail, truncated: true};
}

/** Numbers of the lines that contain every word of the filter, case ignored and symbols taken literally. */
export function filterLines(lines: string[], query: string) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return lines.flatMap((line, index) => {
    const text = line.toLowerCase();
    return words.every(word => text.includes(word)) ? [index] : [];
  });
}
