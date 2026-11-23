import { experimental_useSidebarThreads, useBbNavigate } from "@get-bb/plugin-sdk/app";
import { useState } from "react";
import type { InspectorSource } from "../../core/inspector";
import { useInspectorActivity } from "./useInspectorActivity";
import { useThreadContext } from "./useThreadContext";

export const panelPath = "thread";
export const panelId = "thread-chat";

interface InspectorProps {
  threadId: string;
  openSource(seq: number): void;
}

export function ThreadInspector({ threadId, openSource }: InspectorProps) {
  const [section, setSection] = useState<"status" | "context">("status");

  return (
    <aside className="tc-inspector" aria-label="Правая панель TreadChat">
      <div className="tc-inspector-modes" role="group" aria-label="Правая панель">
        <button aria-pressed={section === "status"} onClick={() => setSection("status")}>Состояние</button>
        <button aria-pressed={section === "context"} onClick={() => setSection("context")}>Контекст</button>
      </div>
      <div className="tc-inspector-content">
        {section === "status" ? <ThreadStatus key={threadId} threadId={threadId} openSource={openSource} /> : <ContextPanel threadId={threadId} />}
      </div>
    </aside>
  );
}

function ThreadStatus({ threadId, openSource }: InspectorProps) {
  const navigate = useBbNavigate();
  const { steps, needsAnswer, status } = useThreadContext(threadId);
  const { artifacts, decisions, check, stale } = useInspectorActivity(threadId);
  const labels: Record<string, string> = {
    starting: "Запускается", active: "В работе", stopping: "Останавливается",
    idle: "Ожидает сообщения", pending: "Есть сообщение в очереди", error: "Ошибка",
  };

  const completed = steps.filter(step => step.status === "completed").length;
  const stepLabels = { completed: "Готово", active: "В работе", failed: "Ошибка", pending: "Ожидает" };

  return (
    <section className="tc-side" aria-label="Состояние треда">
      {stale && <p role="status" className="tc-inspector-stale">Данные могут быть устаревшими.</p>}
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
      <SourceCard title="Ключевые решения" items={decisions} openSource={openSource} />
      <SourceCard title="Артефакты" items={artifacts} openSource={openSource} />
      {(status || check || needsAnswer) && (
        <section className="tc-card" aria-label="Выполнение">
          <h3>Выполнение</h3>
          {status && <p>{labels[status] ?? status}</p>}
          {check && <button className="tc-source-link" onClick={() => openSource(check.seq)}>{check.title}</button>}
          {needsAnswer && <button onClick={() => navigate.toThread(threadId)}>Ответить на запрос BB</button>}
        </section>
      )}
    </section>
  );
}

function SourceCard({ title, items, openSource }: {
  title: string;
  items: readonly InspectorSource[];
  openSource(seq: number): void;
}) {
  if (!items.length) return null;
  return (
    <section className="tc-card" aria-label={title}>
      <h3>{title}</h3>
      <ul className="tc-inspector-sources">
        {items.map(item => (
          <li key={item.title + item.seq}>
            <button className="tc-source-link" onClick={() => openSource(item.seq)}>{item.title}</button>
          </li>
        ))}
      </ul>
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
