import type { ReactNode } from "react";
import { classes } from "../chrome/primitives.tsx";

/**
 * What a thread panel says when it cannot take input: an error, or the thread
 * is in another window. The owning window shows nothing here; handing the
 * thread over is an item of the tile menu.
 */
export function HandoffNotice(props: {
  owner: boolean;
  ownerId?: string | null;
  error: string | null;
  onRecover?: () => void;
}): ReactNode {
  if (props.error) return <p role="alert" className="px-2 py-1 text-xs text-destructive">{props.error}</p>;
  if (props.owner) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 px-2 py-1 text-xs text-muted-foreground">
      {props.onRecover ? (
        <button type="button" className={classes.button} onClick={props.onRecover}>
          Вернуть панель в это окно
        </button>
      ) : props.ownerId ? (
        "Панель в окне " + props.ownerId.slice(0, 8)
      ) : (
        "Ожидание права ввода"
      )}
    </div>
  );
}

export function IncomingTransfer(props: {
  title: string;
  enabled: boolean;
  problem: string;
  onCancel(): void;
  onAccept(): void;
}) {
  return (
    <aside
      className="fixed bottom-4 right-4 z-50 flex max-w-sm flex-col gap-2 rounded-lg border border-border bg-card p-3 text-sm text-card-foreground shadow-md"
      aria-label="Передача панели"
    >
      <p>Принять панель «{props.title}»?</p>
      {!props.enabled && <p className="text-xs text-muted-foreground">Откройте Чертог в этом окне и проверьте доступ к треду.</p>}
      {props.problem && <p role="alert" className="text-xs text-destructive">{props.problem}</p>}
      <div className="flex gap-2">
        <button type="button" className={classes.primaryButton} disabled={!props.enabled} onClick={props.onAccept}>
          Принять
        </button>
        <button type="button" className={classes.button} onClick={props.onCancel}>
          Отказаться
        </button>
      </div>
    </aside>
  );
}

export function ReturnedPanel(props: {
  title: string;
  held: boolean;
  canOpen: boolean;
  problem: string;
  onOpen(): void;
  onDismiss(): void;
}) {
  return (
    <aside className="flex max-w-sm flex-col gap-2 rounded-lg border border-border bg-card p-3 text-sm text-card-foreground shadow-md">
      <p role="status">Окно закрылось. Панель «{props.title}» возвращена в это окно.</p>
      {props.problem && <p role="alert" className="text-xs text-destructive">{props.problem}</p>}
      <div className="flex gap-2">
        {!props.held && (
          <button type="button" className={classes.primaryButton} disabled={!props.canOpen} onClick={props.onOpen}>
            Показать панель
          </button>
        )}
        <button type="button" className={classes.button} onClick={props.onDismiss}>
          {props.held ? "Понятно" : "Скрыть"}
        </button>
      </div>
    </aside>
  );
}
