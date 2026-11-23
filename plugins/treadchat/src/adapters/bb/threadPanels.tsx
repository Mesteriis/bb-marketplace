import { experimental_useSidebarThreads, useBbNavigate } from "@get-bb/plugin-sdk/app";
import { useState } from "react";
import { useThreadContext } from "./useThreadContext";

export const panelPath = "thread";
export const panelId = "thread-chat";

export function ThreadInspector({ threadId }: { threadId: string }) {
  const [section, setSection] = useState<"status" | "context">("status");

  return (
    <aside className="tc-inspector" aria-label="Правая панель TreadChat">
      <div className="tc-inspector-modes" role="group" aria-label="Правая панель">
        <button aria-pressed={section === "status"} onClick={() => setSection("status")}>Состояние</button>
        <button aria-pressed={section === "context"} onClick={() => setSection("context")}>Контекст</button>
      </div>
      <div className="tc-inspector-content">
        {section === "status" ? <ThreadStatus key={threadId} threadId={threadId} /> : <ContextPanel threadId={threadId} />}
      </div>
    </aside>
  );
}

function ThreadStatus({ threadId }: { threadId: string }) {
  const navigate = useBbNavigate();
  const { steps, needsAnswer, status } = useThreadContext(threadId);
  const labels: Record<string, string> = {
    starting: "Запускается", active: "В работе", stopping: "Останавливается",
    idle: "Ожидает сообщения", pending: "Есть сообщение в очереди", error: "Ошибка",
  };

  const completed = steps.filter(step => step.status === "completed").length;
  const stepLabels = { completed: "Готово", active: "В работе", failed: "Ошибка", pending: "Ожидает" };

  return (
    <section className="tc-side" aria-label="Состояние треда">
      {!!steps.length && (
        <section className="tc-card" aria-label="Прогресс задачи">
          <div className="tc-heading"><h3>Прогресс задачи</h3><span>{completed} / {steps.length}</span></div>
          <progress value={completed} max={steps.length} aria-label="Выполнено шагов" />
          <ol className="tc-plan">
            {steps.map((step, index) => (
              <li key={index} data-status={step.status} aria-current={step.status === "active" ? "step" : undefined}>
                <span aria-label={stepLabels[step.status]}>{({ completed: "✓", active: "◉", failed: "!", pending: "○" })[step.status]}</span>
                {step.title}
              </li>
            ))}
          </ol>
        </section>
      )}
      {status && <section className="tc-card"><h3>Выполнение</h3><p>{labels[status] ?? status}</p></section>}
      {needsAnswer && (
        <button onClick={() => navigate.toThread(threadId)}>Ответить на запрос BB</button>
      )}
    </section>
  );
}

function ContextPanel({ threadId }: { threadId: string }) {
  const navigate = useBbNavigate();
  const { threads, projects } = experimental_useSidebarThreads();
  const thread = threads.find(row => row.id === threadId);
  const project = projects.find(row => row.id === thread?.projectId);
  const parent = threads.find(row => row.id === thread?.parentThreadId);

  return (
    <section className="tc-side" aria-label="Контекст треда">
      <h2>Контекст</h2>
      {project && <p><strong>Проект</strong> {project.name}</p>}
      {thread && <p><strong>Тред</strong> {thread.displayTitle}</p>}
      {parent && <button onClick={() => navigate.toPluginPanel(panelPath, {subPath: parent.id})}>{parent.displayTitle}</button>}
      <button onClick={() => navigate.toThread(threadId)}>Открыть штатный чат BB</button>
    </section>
  );
}
