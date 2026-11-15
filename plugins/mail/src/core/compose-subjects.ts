// Subjects for a reply or a forward. Only the leading run of the matching
// kind of marker is stripped before one prefix is added, so "Fwd: x" replied
// to becomes "Re: Fwd: x" and a second reply does not stack prefixes. A
// marker needs its colon (full-width "：" too), so "Revenue" is left alone.
// These lists are used for composing only: normalizeSubject in threading.ts
// keeps its own shorter list, so grouping of mail already stored never shifts.

/** Reply markers; each is matched case-insensitively. */
export const REPLY_MARKERS: readonly string[] = [
  "Re", "RE", "Aw", "AW", "Sv", "Antw", "Odp", "Rif", "R", "Vs", "VS", "Ответ", "Отв",
];

/** Forward markers; each is matched case-insensitively. */
export const FORWARD_MARKERS: readonly string[] = ["Fwd", "Fw", "FW", "WG", "TR", "Pd", "Пересл"];

function markerPattern(markers: readonly string[]): RegExp {
  const alternatives = [...new Set(markers.map((marker) => marker.toLowerCase()))]
    .sort((a, b) => b.length - a.length)
    .join("|");
  return new RegExp(`^(?:${alternatives})\\s*(?:\\[\\d+\\]|\\(\\d+\\))?\\s*[:：]\\s*`, "iu");
}

const REPLY_RUN = markerPattern(REPLY_MARKERS);
const FORWARD_RUN = markerPattern(FORWARD_MARKERS);
// C0, DEL and C1 controls (CR, LF and NUL among them) become spaces.
const CONTROLS = /[\u0000-\u001f\u007f-\u009f]+/g;

export function replySubject(subject: string): string {
  return withPrefix("Re:", stripRun(subject, REPLY_RUN));
}

export function forwardSubject(subject: string): string {
  return withPrefix("Fwd:", stripRun(subject, FORWARD_RUN));
}

function stripRun(subject: string, run: RegExp): string {
  let rest = subject.replace(CONTROLS, " ").replace(/\s+/g, " ").trim();
  for (let match = run.exec(rest); match; match = run.exec(rest)) {
    rest = rest.slice(match[0].length);
  }
  return rest.trim();
}

function withPrefix(prefix: string, rest: string): string {
  return rest === "" ? prefix : `${prefix} ${rest}`;
}
