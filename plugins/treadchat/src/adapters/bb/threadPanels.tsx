import { experimental_useSidebarThreads, useBbNavigate } from "@get-bb/plugin-sdk/app";
import { threadFromPath } from "../../core/threadRoute";
import { useThreadContext } from "./useThreadContext";

export const panelPath = "thread";
export const panelId = "thread-chat";

export const statusTab = {
  context: {kind: "nav-panel", panelId},
  availability: "fixed",
  id: "status",
} as const;

export const contextTab = { ...statusTab, id: "context" } as const;

export function StatusPanel({ subPath }: { subPath: string }) {
  const threadId = threadFromPath(subPath);
  return threadId && <ThreadStatus key={threadId} threadId={threadId} />;
}

function ThreadStatus({ threadId }: { threadId: string }) {
  const navigate = useBbNavigate();
  const { currentStep, needsAnswer, status } = useThreadContext(threadId);
  const labels: Record<string, string> = {
    starting: "Запускается", active: "В работе", stopping: "Останавливается",
    idle: "Ожидает сообщения", pending: "Есть сообщение в очереди", error: "Ошибка",
  };

  return (
    <section className="tc-side" aria-label="Состояние треда">
      <h2>Состояние</h2>
      {status && <p>{labels[status] ?? status}</p>}
      {currentStep && <p><strong>Текущий этап</strong> {currentStep}</p>}
      {needsAnswer && (
        <button onClick={() => navigate.toThread(threadId)}>Ответить на запрос BB</button>
      )}
    </section>
  );
}

export function ContextPanel({ subPath }: { subPath: string }) {
  const threadId = threadFromPath(subPath);
  const navigate = useBbNavigate();
  const { threads, projects } = experimental_useSidebarThreads();
  const thread = threads.find(row => row.id === threadId);
  const project = projects.find(row => row.id === thread?.projectId);
  const parent = threads.find(row => row.id === thread?.parentThreadId);

  if (!threadId) return null;
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
