import { useEffect, useRef, useState } from "react";

export interface CardAction {
  label: string;
  href?: string;
  run(): Promise<string | readonly CardAction[]>;
}

interface Props {
  title: string;
  purpose: string;
  target?: string;
  check(): Promise<void>;
  actions: readonly CardAction[];
}

type Attempt =
  | { state: "checking" | "ready" | "busy" }
  | { state: "unavailable"; reason: string }
  | { state: "failed"; reason: string; action: CardAction }
  | { state: "requested"; result: string }
  | { state: "choose"; choices: readonly CardAction[] };

const button = "min-w-0 max-w-full whitespace-normal rounded-md border border-border px-[min(2%,0.75rem)] py-1.5 text-sm hover:bg-muted focus-visible:outline";
const reason = (error: unknown) => error instanceof Error && error.message ? error.message : "Причину отказа определить не удалось.";

export function EntryCard({ title, purpose, target, check, actions }: Props) {
  const [attempt, setAttempt] = useState<Attempt>({ state: "checking" });
  const [revision, setRevision] = useState(0);
  const generation = useRef(0);
  const pending = useRef(false);
  useEffect(() => {
    const current = ++generation.current;
    pending.current = false;
    setAttempt({ state: "checking" });
    Promise.resolve().then(check).then(
      () => { if (current === generation.current) setAttempt({ state: "ready" }); },
      error => { if (current === generation.current) setAttempt({ state: "unavailable", reason: reason(error) }); },
    );
    return () => { generation.current++; };
  }, [check, revision]);

  async function run(action: CardAction) {
    if (pending.current) return;
    pending.current = true;
    const current = generation.current;
    setAttempt({ state: "busy" });
    try {
      try {
        await check();
      } catch (error) {
        if (current === generation.current) setAttempt({ state: "unavailable", reason: reason(error) });
        return;
      }
      if (current !== generation.current) return;
      const result = await action.run();
      if (current === generation.current) setAttempt(typeof result === "string"
        ? { state: "requested", result } : { state: "choose", choices: result });
    } catch (error) {
      if (current === generation.current) setAttempt({ state: "failed", reason: reason(error), action });
    } finally {
      if (current === generation.current) pending.current = false;
    }
  }

  const status = {
    ready: "Готова к открытию", checking: "Проверяем доступность…", busy: "Открываем…",
    unavailable: "Поставщик недоступен", failed: "Открыть не удалось", requested: "Последняя попытка",
    choose: "Выберите из списка",
  }[attempt.state];
  const choices = attempt.state === "choose" ? attempt.choices : actions;
  return <section aria-label={title} className="min-h-0 min-w-0 overflow-auto px-[min(5%,1rem)] py-4 text-sm [overflow-wrap:anywhere] text-foreground">
    <h3 className="font-medium">{title}</h3>
    <p className="mt-1">{purpose}</p>
    {target && <p className="mt-1 break-all text-muted-foreground">{target}</p>}
    <div role="status" className="my-3">
      <p>{status}</p>
      {"reason" in attempt && <p>{attempt.reason}</p>}
      {attempt.state === "requested" && <p>{attempt.result}</p>}
    </div>
    <div className="flex flex-wrap gap-2">
      {attempt.state === "unavailable" && <button type="button" className={button} onClick={() => setRevision(n => n + 1)}>Повторить</button>}
      {attempt.state === "failed" && <button type="button" className={button} onClick={() => void run(attempt.action)}>Повторить</button>}
      {["ready", "requested", "choose", "failed"].includes(attempt.state) && choices.map((action, i) => (
        action === ("action" in attempt ? attempt.action : undefined) ? null :
        action.href ? <a key={i} className={button} href={action.href} onClick={event => {
          event.preventDefault();
          void run(action);
        }}>{action.label}</a> :
        <button key={i} type="button" className={button} onClick={() => void run(action)}>{action.label}</button>
      ))}
    </div>
    <p className="mt-3 text-xs text-muted-foreground">Статус внешней сессии неизвестен.</p>
  </section>;
}
