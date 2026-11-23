import { useEffect, useRef, useState } from "react";
import { definePluginApp, experimental_useAppPanel, ThreadChat, useBbNavigate } from "@get-bb/plugin-sdk/app";
import { Composer } from "./src/adapters/bb/Composer";
import { Evidence, Journal } from "./src/adapters/bb/Evidence";
import { useActivity } from "./src/adapters/bb/useActivity";
import { useThreadContext } from "./src/adapters/bb/useThreadContext";
import { Overview } from "./src/ui/Overview";
import { ThreadNavigation } from "./src/adapters/bb/ThreadNavigation";
import { contextTab, ContextPanel, panelId, panelPath, statusTab, StatusPanel } from "./src/adapters/bb/threadPanels";
import { threadFromPath } from "./src/core/threadRoute";
import "./app.css";

function ThreadPage({ subPath }: { subPath: string }) {
  const threadId = threadFromPath(subPath);
  const sidePanel = experimental_useAppPanel();
  const opened = useRef(false);

  useEffect(() => {
    if (threadId && !opened.current) opened.current = sidePanel.openTab({ tab: statusTab });
  }, [sidePanel, threadId]);

  return threadId ? <ThreadScreen key={threadId} threadId={threadId} /> : (
    <div className="tc-empty"><h2>Makosh TreadChat</h2><p>Выберите тред слева.</p></div>
  );
}

function ThreadScreen({ threadId }: { threadId: string }) {
  const navigate = useBbNavigate();
  const [dialogue, setDialogue] = useState(false);
  const [journal, setJournal] = useState(false);
  const [source, setSource] = useState<number>();
  const evidence = useRef<HTMLDivElement>(null);
  const lastSourceButton = useRef<HTMLElement | null>(null);
  const { title, currentStep, needsAnswer } = useThreadContext(threadId);

  function openSource(seq: number) {
    lastSourceButton.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setSource(seq);
    requestAnimationFrame(() => evidence.current?.focus());
  }

  function closeSource() {
    setSource(undefined);
    lastSourceButton.current?.focus();
  }

  return (
    <div className="tc-panel">
      <header className="tc-header">
        <div className="tc-heading">
          <h2>{title || "Тред"}</h2>
          <button onClick={() => navigate.toThread(threadId)}>Открыть чат BB</button>
        </div>
        <div className="tc-modes" role="group" aria-label="Содержимое треда">
          <button aria-pressed={!dialogue} onClick={() => setDialogue(false)}>Обзор</button>
          <button aria-pressed={dialogue} onClick={() => setDialogue(true)}>Диалог</button>
        </div>
      </header>
      {dialogue ? (
        <div className="tc-dialogue"><ThreadChat threadId={threadId} variant="timeline" /></div>
      ) : (
        <main className="tc-feed">
          <ActivityFeed threadId={threadId} currentStep={currentStep} needsAnswer={needsAnswer}
            openSource={openSource} openChat={() => navigate.toThread(threadId)} />
          {source !== undefined && (
            <div ref={evidence} tabIndex={-1}>
              <Evidence key={source} threadId={threadId} seq={source} onClose={closeSource} />
            </div>
          )}
          <button className="tc-journal" aria-expanded={journal} onClick={() => setJournal(value => !value)}>
            {journal ? "Свернуть журнал" : "Технический журнал"}
          </button>
          {journal && <Journal threadId={threadId} openSource={openSource} />}
        </main>
      )}
      <Composer threadId={threadId} title={title} />
    </div>
  );
}

function ActivityFeed({ threadId, ...props }: Pick<Parameters<typeof Overview>[0],
  "currentStep" | "needsAnswer" | "openSource" | "openChat"> & { threadId: string }) {
  const data = useActivity(threadId);
  return <Overview {...data} {...props} />;
}

export default definePluginApp(app => {
  app.slots.navPanel({
    id: panelId, path: panelPath, title: "Makosh TreadChat", icon: "MessagesSquare",
    component: ThreadPage, experimental_sidebar: ThreadNavigation,
  });
  app.slots.experimental_tab({ ...statusTab, title: "Состояние", icon: "Activity", component: StatusPanel });
  app.slots.experimental_tab({ ...contextTab, title: "Контекст", icon: "Info", component: ContextPanel });
  app.slots.experimental_threadAction({
    id: "open-treadchat", title: "TreadChat", icon: "MessagesSquare", group: "treadchat", placement: "header",
    item: ({ thread, navigate }) => ({
      label: "TreadChat", icon: "MessagesSquare",
      run: () => navigate.toPluginPanel(panelPath, { subPath: thread.id }),
    }),
  });
});
