// Ported from plugins/bb-github-pr-dashboard/prs.ts (MIT, © 2026 Muhammad Ahsan, revision 898660bc).
// What changed since the last poll of one account's open PRs. No I/O.

export interface Watched {
  id: string;
  repo: string;
  number: number;
  title: string;
  url: string;
  /** Latest-run failing jobs as "workflow › job". */
  failing: string[];
  /** Newest comment or review by someone other than you, bots and ignored people. */
  lastComment: { author: string; at: string; url: string } | null;
}


export interface WatchState {
  failing: string[];
  lastCommentAt: string | null;
}

export interface Alert {
  id: string;
  kind: "ci" | "comment" | "test";
  repo: string;
  number: number;
  url: string;
  headline: string;
  detail: string;
  at: string;
  seen: boolean;
}

/**
 * Alerts for what changed since `prev`. A null `prev` (first poll, or a new
 * GitHub account) only records a baseline, so installing never floods you.
 */
export function diffWatch(
  prev: Record<string, WatchState> | null,
  prs: Watched[],
  now: string,
  notify: { ci: boolean; comments: boolean },
): { alerts: Alert[]; next: Record<string, WatchState> } {
  const next: Record<string, WatchState> = {};
  const alerts: Alert[] = [];
  for (const pr of prs) {
    next[pr.id] = { failing: pr.failing, lastCommentAt: pr.lastComment?.at ?? null };
    if (prev === null) continue;
    // A PR first seen now: its CI counts from clean, its old comments do not.
    const was = prev[pr.id] ?? { failing: [], lastCommentAt: pr.lastComment?.at ?? null };
    const ref = { repo: pr.repo, number: pr.number, seen: false };
    const newlyFailing = pr.failing.filter((f) => !was.failing.includes(f));
    if (notify.ci && newlyFailing.length > 0) {
      alerts.push({
        ...ref,
        id: `${pr.id}:ci:${newlyFailing.join("|")}:${now}`,
        kind: "ci",
        url: pr.url,
        headline: `CI failing · ${pr.repo}#${pr.number}`,
        detail: `${newlyFailing.join(", ")} — ${pr.title}`,
        at: now,
      });
    }
    const c = pr.lastComment;
    if (notify.comments && c && (was.lastCommentAt === null || c.at > was.lastCommentAt)) {
      alerts.push({
        ...ref,
        id: `${pr.id}:comment:${c.at}`,
        kind: "comment",
        url: c.url,
        headline: `${c.author} commented · ${pr.repo}#${pr.number}`,
        detail: pr.title,
        at: c.at,
      });
    }
  }
  return { alerts, next };
}

/** One system notification for a whole check, so a busy poll does not send a burst. */
export function pushText(alerts: Alert[]): { title: string; body: string } {
  if (alerts.length === 1) return { title: alerts[0]!.headline, body: alerts[0]!.detail };
  return { title: `${alerts.length} new PR alerts`, body: alerts.map((a) => a.headline).join("\n") };
}

