import { experimental_useSidebarThreads, useBbNavigate } from "@get-bb/plugin-sdk/app";
import { threadFromPath } from "../../core/threadRoute";
import { panelPath } from "./threadPanels";

export function ThreadNavigation({ subPath }: { subPath: string }) {
  const currentId = threadFromPath(subPath);
  const navigate = useBbNavigate();
  const { projects, threads, status } = experimental_useSidebarThreads();

  return (
    <nav className="tc-navigation" aria-label="Треды Makosh TreadChat">
      {status === "loading" && <p role="status">Загружаю треды…</p>}
      {status === "error" && <p role="status">Список тредов недоступен.</p>}
      {status === "ready" && threads.length === 0 && <p>Откройте тред в BB.</p>}
      {projects.map(project => {
        const entries = threads.filter(thread => thread.projectId === project.id);
        if (!entries.length) return null;
        return (
          <section key={project.id} aria-label={project.name}>
            <h3>{project.name}</h3>
            <ul>
              {entries.map(thread => (
                <li key={thread.id}>
                  <button
                    aria-current={currentId === thread.id ? "page" : undefined}
                    title={thread.displayTitle}
                    onClick={() => navigate.toPluginPanel(panelPath, { subPath: thread.id })}
                  >
                    {thread.displayTitle}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </nav>
  );
}
