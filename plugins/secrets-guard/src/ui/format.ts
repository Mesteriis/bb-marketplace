// Russian labels for the guard's state. Times are unix seconds.
import type { GuardView } from "../core/service.ts";
import type { Scope } from "../core/state.ts";

const SCOPE_LABELS: Record<Scope, string> = {
  thread: "Этот чат",
  tree: "Этот чат и субтреды",
  global: "Глобально",
};

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
