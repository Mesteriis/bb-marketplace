import { useEffect, useState } from "react";
import { useRealtimeConnectionState, useSdk } from "@get-bb/plugin-sdk/app";
import { storageKey } from "./storage";

const submissions = new Map<string, Promise<string>>();
const draftLimit = 16_000;

export function Composer({ threadId, title }: { threadId: string; title: string }) {
  const sdk = useSdk();
  const connection = useRealtimeConnectionState();
  const key = storageKey(threadId, "draft");
  const [draft, setDraft] = useState(() => localStorage.getItem(key) ?? "");
  const [job, setJob] = useState(() => submissions.get(threadId));
  const [status, setStatus] = useState("");

  useEffect(() => {
    if (!job) return;
    let mounted = true;
    void job.then(message => {
      if (!mounted) return;
      setDraft(localStorage.getItem(key) ?? "");
      setStatus(message);
      setJob(undefined);
    });
    return () => { mounted = false; };
  }, [job, key]);

  function send() {
    const body = draft.trim();
    if (!body || connection !== "connected" || !title) return;
    const inflight = submissions.get(threadId);
    if (inflight) {
      setJob(inflight);
      return;
    }
    const sending = sdk.threads.send({
      threadId,
      mode: "steer-if-active",
      input: [{ type: "text", text: body, mentions: [] }],
    }).then(result => {
      if (localStorage.getItem(key) === draft) localStorage.removeItem(key);
      return result.delivery === "queued" ? "В очереди BB." : "BB принял уточнение.";
    }, () => "BB не подтвердил отправку. Сверьте сообщения в чате перед повтором.")
      .finally(() => submissions.delete(threadId));
    submissions.set(threadId, sending);
    setStatus("");
    setJob(sending);
  }

  return (
    <form className="tc-composer" onSubmit={event => { event.preventDefault(); send(); }}>
      <label>
        <span>Получатель · {title || threadId}</span>
        <textarea
          rows={3}
          maxLength={draftLimit}
          value={draft}
          readOnly={!!job}
          placeholder="Написать уточнение"
          onChange={event => {
            const value = event.target.value;
            localStorage.setItem(key, value);
            setDraft(value);
          }}
          onKeyDown={event => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing) {
              event.preventDefault();
              send();
            }
          }}
        />
      </label>
      <div className="tc-heading">
        <span role="status" className="tc-muted">{status}</span>
        <button type="submit" className="tc-primary" disabled={!title || !draft.trim() || !!job || connection !== "connected"}>
          {job ? "Отправляю…" : "Отправить уточнение"}
        </button>
      </div>
    </form>
  );
}
