import { useRef, useState } from "react";
import { definePluginApp, useBbNavigate } from "@get-bb/plugin-sdk/app";
import { Composer } from "./src/adapters/bb/Composer";
import { Evidence, Journal } from "./src/adapters/bb/Evidence";
import { useActivity } from "./src/adapters/bb/useActivity";
import { useThreadContext } from "./src/adapters/bb/useThreadContext";
import { Overview } from "./src/ui/Overview";
import "./app.css";

function ThreadPanel({ threadId }: { threadId: string }) {
  const navigate = useBbNavigate();
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
          <h2>Обзор треда</h2>
          <button onClick={() => navigate.toThread(threadId)}>Открыть чат BB</button>
        </div>
        <div className="tc-thread" title={title || threadId}>{title || threadId}</div>
      </header>
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
  app.slots.experimental_tab({
    context: { kind: "thread" },
    availability: "fixed",
    id: "overview",
    title: "Makosh TreadChat",
    icon: "MessagesSquare",
    layout: "flush",
    component: ({ threadId }) => <ThreadPanel key={threadId} threadId={threadId} />,
  });
});
