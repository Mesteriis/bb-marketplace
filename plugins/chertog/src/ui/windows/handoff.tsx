import type { ReactNode } from "react";

export function HandoffControls(props: {
  owner: boolean;
  ownerId?: string | null;
  windowId?: string | null;
  targets: string[];
  show: boolean;
  busy: boolean;
  error: string | null;
  onToggle(): void;
  onPick(target: string): void;
  onCancel?: () => void;
  onRecover?: () => void;
}): ReactNode {
  if (props.error) return <p role="alert">{props.error}</p>;
  if (!props.owner)
    return (
      <div>
        {props.onRecover ? (
          <button onClick={props.onRecover}>Вернуть панель в это окно</button>
        ) : props.ownerId ? (
          "Панель в окне " + props.ownerId.slice(0, 8)
        ) : (
          "Ожидание права ввода"
        )}
      </div>
    );
  return (
    <div className="flex flex-wrap gap-2 px-2 text-xs">
      <button disabled={props.busy} onClick={props.onToggle} aria-expanded={props.show}>
        Передать в другое окно
      </button>
      {props.onCancel && <button onClick={props.onCancel}>Отменить передачу</button>}
      {props.show && props.windowId && <span>Это окно {props.windowId.slice(0, 8)}</span>}
      {props.show &&
        (props.targets.length ? (
          props.targets.map((id) => (
            <button key={id} onClick={() => props.onPick(id)}>
              Окно {id.slice(0, 8)}
            </button>
          ))
        ) : (
          <span>Откройте второе окно через New Window.</span>
        ))}
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
    <aside className="fixed bottom-4 right-4 z-50 rounded border bg-background p-3 text-foreground" aria-label="Передача панели">
      <p>Принять панель «{props.title}»?</p>
      {!props.enabled && <p>Откройте Чертог в этом окне и проверьте доступ к треду.</p>}
      {props.problem && <p role="alert">{props.problem}</p>}
      <button disabled={!props.enabled} onClick={props.onAccept}>
        Принять
      </button>{" "}
      <button onClick={props.onCancel}>Отказаться</button>
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
    <aside className="rounded border bg-background p-3 text-foreground">
      <p role="status">Окно закрылось. Панель «{props.title}» возвращена в это окно.</p>
      {!props.held && <button disabled={!props.canOpen} onClick={props.onOpen}>Показать панель</button>}
      {props.problem && <p role="alert">{props.problem}</p>}
      <button onClick={props.onDismiss}>{props.held ? "Понятно" : "Скрыть"}</button>
    </aside>
  );
}
