import type { Activity } from "../core/activity";

interface Props {
  rows: readonly Activity[];
  pending: boolean;
  online: boolean;
  error: boolean;
  currentStep?: string;
  needsAnswer: boolean;
  openChat(): void;
  openSource(seq: number): void;
  markViewed(): void;
  retry(): void;
}

export function Overview(props: Props) {
  return (
    <section aria-label="Что я пропустил">
      {(!props.online || props.error) && (
        <p role="status" className="tc-notice">
          Данные могут быть устаревшими.
          {props.online && <button onClick={props.retry}>Повторить</button>}
        </p>
      )}
      {props.needsAnswer && (
        <p className="tc-notice">
          BB ждёт вашего ответа. <button onClick={props.openChat}>Открыть запрос в чате</button>
        </p>
      )}
      {props.currentStep && !props.rows.some(row => row.kind === "plan" && row.detail === props.currentStep) && <p className="tc-step"><strong>Текущий этап</strong> {props.currentStep}</p>}
      <div className="tc-heading">
        <h3>Что я пропустил</h3>
        {props.rows.length > 0 && <button onClick={props.markViewed}>Отметить просмотренным</button>}
      </div>
      {props.rows.length ? (
        <ol className="tc-list">
          {props.rows.map(row => (
            <li key={row.seq} data-kind={row.kind}>
              <div className="tc-heading">
                <strong>{row.title}</strong>
                <time dateTime={new Date(row.createdAt).toISOString()}>
                  {new Date(row.createdAt).toLocaleTimeString([], {hour: "2-digit", minute: "2-digit"})}
                </time>
              </div>
              {row.detail && <p className="tc-snippet">{row.detail}</p>}
              <button onClick={() => props.openSource(row.seq)} aria-label={"Открыть источник " + row.seq}>
                Открыть источник
              </button>
            </li>
          ))}
        </ol>
      ) : <p className="tc-muted">{props.pending ? "Загружаю события…" : "Новых значимых событий нет."}</p>}
    </section>
  );
}
