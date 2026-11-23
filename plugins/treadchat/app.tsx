import { useRef, useState } from "react";
import { definePluginApp, ThreadChat, useBbNavigate } from "@get-bb/plugin-sdk/app";
import { LegacyDraft } from "./src/adapters/bb/LegacyDraft";
import { Evidence, Journal } from "./src/adapters/bb/Evidence";
import { useActivity } from "./src/adapters/bb/useActivity";
import { useThreadContext } from "./src/adapters/bb/useThreadContext";
import { Overview } from "./src/ui/Overview";
import { ThreadNavigation } from "./src/adapters/bb/ThreadNavigation";
import { panelId, panelPath, ThreadInspector } from "./src/adapters/bb/threadPanels";
import { threadFromPath } from "./src/core/threadRoute";
import "./app.css";

function ThreadPage({ subPath }: { subPath: string }) {
  const threadId = threadFromPath(subPath);
  return threadId ? (
    <div className="tc-workspace">
      <div className="tc-layout">
        <ThreadScreen key={threadId} threadId={threadId} />
        <ThreadInspector threadId={threadId} />
      </div>
    </div>
  ) : (
    <div className="tc-empty"><h2>Makosh TreadChat</h2><p>Выберите тред слева.</p></div>
  );
}

function ThreadScreen({ threadId }: { threadId: string }) {
  const navigate = useBbNavigate();
  const [mode, setMode] = useState<"overview" | "dialogue" | "journal">("overview");
  const [source, setSource] = useState<number>();
  const evidence = useRef<HTMLDivElement>(null);
  const lastSourceButton = useRef<HTMLElement | null>(null);
  const { title, currentStep, needsAnswer, status } = useThreadContext(threadId);

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
          <div className="tc-identity">
            <span className="tc-mark" aria-hidden="true">◈</span>
            <div>
              <h2>{title || "Тред"}</h2>
              {status === "active" && <span className="tc-running">● В работе</span>}
            </div>
          </div>
          <button onClick={() => navigate.toThread(threadId)}>Открыть чат BB</button>
        </div>
        <div className="tc-modes" role="group" aria-label="Содержимое треда">
          <button aria-pressed={mode === "overview"} onClick={() => setMode("overview")}>Обзор</button>
          <button aria-pressed={mode === "dialogue"} onClick={() => setMode("dialogue")}>Диалог</button>
          <button aria-pressed={mode === "journal"} onClick={() => setMode("journal")}>Технический журнал</button>
        </div>
      </header>
      <LegacyDraft threadId={threadId} />
      {(mode !== "dialogue" || source !== undefined) && (
        <section className="tc-feed" aria-label="Подробности треда">
          {mode === "overview" && <ActivityFeed threadId={threadId} currentStep={currentStep} needsAnswer={needsAnswer}
            openSource={openSource} openChat={() => navigate.toThread(threadId)} />}
          {mode === "journal" && <Journal threadId={threadId} openSource={openSource} />}
          {source !== undefined && (
            <div ref={evidence} tabIndex={-1}>
              <Evidence key={source} threadId={threadId} seq={source} onClose={closeSource} />
            </div>
          )}
        </section>
      )}
      <div className="tc-dialogue"><ThreadChat threadId={threadId} variant="full" permissionPolicy="editable" /></div>
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
  app.slots.experimental_threadAction({
    id: "open-treadchat", title: "TreadChat", icon: "MessagesSquare", group: "treadchat", placement: "header",
    item: ({ thread, navigate }) => ({
      label: "TreadChat", icon: "MessagesSquare",
      run: () => navigate.toPluginPanel(panelPath, { subPath: thread.id }),
    }),
  });
});
