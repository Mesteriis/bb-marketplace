import { useEffect, useState } from "react";
import { useComposers } from "@get-bb/plugin-sdk/app";
import { storageKey } from "./storage";

export function LegacyDraft({ threadId }: { threadId: string }) {
  const key = storageKey(threadId, "draft");
  const [draft, setDraft] = useState(() => localStorage.getItem(key));
  return draft ? <RestoreDraft storageId={key} draft={draft} threadId={threadId} onRestored={() => setDraft(null)} /> : null;
}

function RestoreDraft({ storageId, draft, threadId, onRestored }: {
  storageId: string;
  draft: string;
  threadId: string;
  onRestored(): void;
}) {
  const composer = useComposers().find(handle =>
    handle.scope.kind === "thread" && handle.scope.threadId === threadId);
  const text = composer?.text;
  const [requested, setRequested] = useState(false);

  useEffect(() => {
    if (!requested || text !== draft) return;
    if (localStorage.getItem(storageId) === draft) localStorage.removeItem(storageId);
    onRestored();
  }, [draft, onRestored, requested, storageId, text]);

  return (
    <details className="tc-legacy">
      <summary>Черновик из предыдущей версии</summary>
      <pre>{draft}</pre>
      <button disabled={!composer?.isEmpty} onClick={() => {
        if (!composer?.isEmpty) return;
        composer.replace({ text: draft, mentions: [] });
        composer.focus();
        setRequested(true);
      }}>
        Перенести в пустое поле ввода
      </button>
    </details>
  );
}
