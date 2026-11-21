// What a panel shows when it has no live content to show. The five states
// differ in text, icon and tone, so "still opening" is never mistaken for
// "gone". Nothing here retries by itself: a retry is one explicit click.
import type { ReactNode } from "react";

export const PANEL_STATES = ["loading", "provider-missing", "session-ended", "access-denied", "lost"] as const;

/**
 * - `loading`: the content is opening.
 * - `provider-missing`: the plugin that supplies the panel is off or not installed; the panel reference is kept.
 * - `session-ended`: the session behind the panel was closed.
 * - `access-denied`: the user may not open the panel.
 * - `lost`: live content died and was not restored (a dead media context, a crashed renderer).
 */
export type PanelState = (typeof PANEL_STATES)[number];

export interface PanelStateViewProps {
  state: PanelState;
  /** Name of the panel, shown above the state when given. */
  panelTitle?: string;
  /** Replaces the state's own title. */
  title?: string;
  /** Replaces the state's own explanation. */
  description?: string;
  /** Text of the retry button. */
  retryLabel?: string;
  /**
   * Called on a click of the retry button, once per click. Without it no
   * button is drawn. `loading` never draws one: there is nothing to retry yet.
   */
  onRetry?: () => void;
}

interface StateLook {
  title: string;
  description: string;
  /** Theme colour of the icon. */
  tone: string;
  /** Contents of a 24×24 stroked icon. */
  icon: ReactNode;
}

const LOOKS: Record<PanelState, StateLook> = {
  loading: {
    title: "Загружается",
    description: "Панель открывается.",
    tone: "text-primary",
    icon: <path className="origin-center animate-spin" d="M21 12a9 9 0 1 1-6.2-8.56" />,
  },
  "provider-missing": {
    title: "Поставщик отсутствует",
    description: "Плагин этой панели выключен или не установлен. Ссылка на панель сохранена.",
    tone: "text-muted-foreground",
    icon: (
      <>
        <path d="M9 2v6M15 2v6M6 8h12v3a6 6 0 0 1-12 0z" />
        <path d="M12 17v5M3 3l18 18" />
      </>
    ),
  },
  "session-ended": {
    title: "Сессия завершена",
    description: "Сеанс этой панели закрыт. Повтор откроет новый сеанс.",
    tone: "text-foreground",
    icon: (
      <>
        <circle cx="12" cy="12" r="9" />
        <rect x="9" y="9" width="6" height="6" />
      </>
    ),
  },
  "access-denied": {
    title: "Нет доступа",
    description: "У вас нет прав на эту панель.",
    tone: "text-destructive",
    icon: (
      <>
        <rect x="5" y="11" width="14" height="10" rx="2" />
        <path d="M8 11V7a4 4 0 0 1 8 0v4" />
      </>
    ),
  },
  lost: {
    title: "Потеряна",
    description: "Живое содержимое панели утрачено и не восстановлено.",
    tone: "text-warning",
    icon: (
      <>
        <path d="M12 3 2 21h20z" />
        <path d="M12 10v5M12 18h.01" />
      </>
    ),
  },
};

const DEFAULT_RETRY_LABEL = "Повторить";

/** One of the panel states, filling the area it is put in. */
export function PanelStateView({ state, panelTitle, title, description, retryLabel, onRetry }: PanelStateViewProps) {
  const look = LOOKS[state];
  return (
    <div
      data-panel-state={state}
      role="status"
      aria-busy={state === "loading" ? true : undefined}
      className="flex h-full w-full flex-col items-center justify-center gap-2 overflow-hidden bg-background p-4 text-center"
    >
      <span data-panel-state-icon className={look.tone} aria-hidden="true">
        <svg
          viewBox="0 0 24 24"
          width="28"
          height="28"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          {look.icon}
        </svg>
      </span>
      {panelTitle === undefined ? null : (
        <span data-panel-state-panel className="max-w-full truncate text-xs text-muted-foreground">
          {panelTitle}
        </span>
      )}
      <span data-panel-state-title className="text-sm font-medium text-foreground">
        {title ?? look.title}
      </span>
      <span data-panel-state-description className="max-w-sm text-xs text-muted-foreground">
        {description ?? look.description}
      </span>
      {onRetry === undefined || state === "loading" ? null : (
        <button
          type="button"
          className="mt-1 rounded-md border border-border px-3 py-1 text-xs text-foreground hover:bg-muted"
          onClick={() => onRetry()}
        >
          {retryLabel ?? DEFAULT_RETRY_LABEL}
        </button>
      )}
    </div>
  );
}
