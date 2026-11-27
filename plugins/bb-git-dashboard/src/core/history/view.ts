import type { CommitSummary, Ref } from "./model.ts";

const words = (query: string) => query.toLowerCase().split(/\s+/).filter(Boolean);

/** Whether every word of the query is in the commit's subject, author, e-mail or refs, or starts its hash. */
export function matchesCommit(commit: CommitSummary, query: string) {
  const text = [commit.subject, commit.authorName, commit.authorEmail, ...commit.refs.map(ref => ref.name)].join("\n").toLowerCase();
  const hash = commit.hash.toLowerCase();
  return words(query).every(word => hash.startsWith(word) || text.includes(word));
}

export type DayGroup = {label: string; start: number; count: number};
const dayMs = 86_400_000;
const weekdays = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
/** Days since the epoch in a zone `offset` minutes east of UTC. */
const dayOf = (time: number, offset: number) => Math.floor((time + offset * 60_000) / dayMs);

/**
 * Consecutive commits of one calendar day in the viewer's zone, labelled Today, Yesterday,
 * a weekday within the last week, or the date. A day that returns after a gap starts a new group.
 */
export function dayGroups(commits: CommitSummary[], now: number, offset: number): DayGroup[] {
  const today = dayOf(now, offset);
  const groups: (DayGroup & {day: number})[] = [];
  commits.forEach((commit, index) => {
    const day = dayOf(Date.parse(commit.authorDate), offset);
    const last = groups[groups.length - 1];
    if (last && last.day === day) { last.count++; return; }
    const ago = today - day;
    const label = ago === 0 ? "Today" : ago === 1 ? "Yesterday" : ago > 1 && ago < 7 ? weekdays[(day + 4) % 7]
      : new Date(day * dayMs).toISOString().slice(0, 10);
    groups.push({label, start: index, count: 1, day});
  });
  return groups.map(({label, start, count}) => ({label, start, count}));
}

const conventional = /^([a-z]+(?:\([^()\s][^()]*\))?!?:)(\s.*)$/s;
/** A conventional-commit type, scope and `!` split from the rest of the subject, or null. */
export function conventionalPrefix(subject: string) {
  const match = conventional.exec(subject);
  return match ? {prefix: match[1], rest: match[2]} : null;
}

/** The head ref first, then the others in order; those beyond `max` are folded into a count. */
export function visibleRefs(refs: Ref[], max: number) {
  const ordered = [...refs.filter(ref => ref.isHead), ...refs.filter(ref => !ref.isHead)];
  return {shown: ordered.slice(0, max), hidden: ordered.slice(max)};
}

/** Added and removed lines of a unified diff, file headers excluded. */
export function patchStats(text: string) {
  let added = 0;
  let removed = 0;
  // Only lines inside a hunk count, so a content line that itself starts with "++" or "--" is not a header.
  let hunk = false;
  for (const line of text.split("\n")) {
    if (line.startsWith("diff ")) hunk = false;
    else if (line.startsWith("@@")) hunk = true;
    else if (hunk && line.startsWith("+")) added++;
    else if (hunk && line.startsWith("-")) removed++;
  }
  return {added, removed};
}
