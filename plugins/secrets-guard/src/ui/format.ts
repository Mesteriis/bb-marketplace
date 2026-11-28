// Russian labels for the guard's state. Times are unix seconds.
import type { GuardView } from "../core/service.ts";
import type { Scope } from "../core/state.ts";

const SCOPE_LABELS: Record<Scope, string> = {
  thread: "Этот чат",
  tree: "Этот чат и субтреды",
  global: "Глобально",
};

/** The segments of the window: short enough to sit in one row. */
const SCOPE_SHORT_LABELS: Record<Scope, string> = {
  thread: "Этот чат",
  tree: "С субтредами",
  global: "Глобально",
};

export const SCOPES: readonly Scope[] = ["thread", "tree", "global"];
/** The longest term there is; the remaining bar is a share of it. */
const LONGEST_TERM_SECONDS = 60 * 60;

export const NOT_CONFIGURED =
  "Охрана не найдена: хук охраны Claude Code ещё не создал указатель. Запустите любой тред Claude Code или укажите файл отметки в настройках плагина";
export const NOT_LOCAL = "Охрана настраивается только на этом Mac";
export const CLOSED = "Закрыто";

/** Whole minutes left, rounded up; 0 when the deadline has passed. */
function minutesLeft(until: number, now: number): number {
  return until > now ? Math.ceil((until - now) / 60) : 0;
}

/** The timer on the button: "24 м", or nothing when the deadline has passed. */
export function remainingLabel(until: number, now: number): string {
  const minutes = minutesLeft(until, now);
  return minutes === 0 ? "" : `${minutes} м`;
}

export function scopeLabel(scope: Scope): string {
  return SCOPE_LABELS[scope];
}

/** Whether the guard can be used from this thread at all. */
export function isAvailable(view: GuardView): boolean {
  return view.configured && view.local;
}

/** What is open right now; a passed deadline counts as closed before the next poll says so. */
export function openNow(view: GuardView | null, now: number): GuardView["effective"] {
  if (view === null || !isAvailable(view) || view.effective === null) return null;
  return view.effective.until > now ? view.effective : null;
}

export function statusLine(view: GuardView, now: number): string {
  if (!view.configured) return NOT_CONFIGURED;
  if (!view.local) return NOT_LOCAL;
  const open = openNow(view, now);
  if (open === null) return CLOSED;
  const scope = scopeLabel(open.scope);
  return `Открыто: ${scope.charAt(0).toLowerCase()}${scope.slice(1)}, осталось ${minutesLeft(open.until, now)} мин`;
}

/** The scope selected in the window: the owner's choice, else what is open, else this chat. */
export function pickScope(chosen: Scope | null, open: GuardView["effective"]): Scope {
  return chosen ?? open?.scope ?? "thread";
}

export function scopeShortLabel(scope: Scope): string {
  return SCOPE_SHORT_LABELS[scope];
}

/** The status line of an open guard: "Открыто ещё 24 мин". */
export function openHeadline(until: number, now: number): string {
  return `Открыто ещё ${minutesLeft(until, now)} мин`;
}

/** Whole minutes left, for the progress bar's value. */
export function remainingMinutes(until: number, now: number): number {
  return minutesLeft(until, now);
}

/**
 * How full the remaining bar is, 0 to 1. The marker does not keep the term an
 * opening started with, so the bar shows a share of the longest term.
 */
export function remainingShare(until: number, now: number): number {
  return Math.min(1, Math.max(0, (until - now) / LONGEST_TERM_SECONDS));
}

/** Where an arrow, Home or End moves the scope selection; null for any other key. */
export function nextScope(current: Scope, key: string): Scope | null {
  const index = SCOPES.indexOf(current);
  const last = SCOPES.length - 1;
  switch (key) {
    case "ArrowRight":
    case "ArrowDown":
      return SCOPES[index === last ? 0 : index + 1] ?? null;
    case "ArrowLeft":
    case "ArrowUp":
      return SCOPES[index === 0 ? last : index - 1] ?? null;
    case "Home":
      return SCOPES[0] ?? null;
    case "End":
      return SCOPES[last] ?? null;
    default:
      return null;
  }
}
