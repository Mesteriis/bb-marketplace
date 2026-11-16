import { Forward } from "lucide-react";
import { useEffect, useState } from "react";
import type { ForumTopic, ForwardResult, ForwardTarget } from "../core/contract.ts";
import type { Chat } from "../core/demo.ts";

export type ForwardActions = {
  forwardOptions: (chatId: string, messageId: string) => Promise<boolean>;
  forwardMessage: (chatId: string, messageId: string, target: ForwardTarget) => Promise<ForwardResult>;
  searchRecipients: (query: string) => Promise<Chat[]>;
  recipients: readonly Chat[];
  loadTopics?: (chatId: string, query: string) => Promise<ForumTopic[] | null>;
};

export function MessageForward({ chatId, messageId, actions }: { chatId: string; messageId: string; actions: ForwardActions }) {
  const [open, setOpen] = useState(false);
  const [allowed, setAllowed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Chat[]>();
  const [selected, setSelected] = useState("");
  const [topicId, setTopicId] = useState("");
  const [topicResult, setTopicResult] = useState<{ id: string; topics: ForumTopic[] | null; error?: boolean }>();
  const [topicRetry, setTopicRetry] = useState(0);
  const [notice, setNotice] = useState("");
  const recipients = (results ?? actions.recipients).flatMap(({ id, name, subtitle: kind }): ForwardTarget[] =>
    kind === "Direct message" || kind === "Group" || kind === "Channel" ? [{ id, name, kind }] : []);
  const target = recipients.find(({ id }) => id === selected);
  const forum = target?.kind === "Group" && actions.loadTopics ? target.id : undefined;
  const loadTopics = actions.loadTopics;
  const matched = forum === topicResult?.id ? topicResult : undefined;
  const topics = matched?.topics;
  const topic = topics?.find(({ id }) => String(id) === topicId);
  const ready = !!target && (!forum || (!!matched && !matched.error && (topics === null || !!topic)));

  useEffect(() => {
    if (!forum || !loadTopics) return;
    let current = true;
    void loadTopics(forum, "").then(
      (topics) => { if (current) setTopicResult({ id: forum, topics }); },
      () => { if (current) setTopicResult({ id: forum, topics: null, error: true }); },
    );
    return () => { current = false; };
  }, [forum, loadTopics, topicRetry]);

  function select(id: string) {
    setSelected(id);
    setTopicId("");
    setTopicResult(undefined);
  }

  async function start() {
    setOpen(true);
    setNotice("Checking Telegram forwarding permissions…");
    setBusy(true);
    try {
      const canForward = await actions.forwardOptions(chatId, messageId);
      setAllowed(canForward);
      setNotice(canForward ? "" : "Telegram does not allow forwarding this message.");
    } catch {
      setNotice("Could not check Telegram forwarding permissions.");
    } finally {
      setBusy(false);
    }
  }

  async function search() {
    if (busy || query.trim().length < 2) return;
    setBusy(true);
    setNotice("");
    select("");
    try {
      const matches = await actions.searchRecipients(query.trim());
      setResults(matches);
      if (!matches.length) setNotice("No matching Telegram chats.");
    } catch {
      setResults([]);
      setNotice("Could not find Telegram chats.");
    } finally {
      setBusy(false);
    }
  }

  async function submit() {
    if (!target || !ready || busy) return;
    setBusy(true);
    setNotice("");
    const result = await actions.forwardMessage(chatId, messageId, { ...target, ...(topic ? { topic: { id: topic.id, name: topic.name } } : {}) }).catch(() => "unknown");
    setAllowed(false);
    setNotice(result === "sent" ? "Message forwarded." : result === "refused"
      ? "Telegram refused to forward this message." : "Telegram did not confirm delivery. Check the destination before retrying.");
    setBusy(false);
  }

  function close() {
    setOpen(false);
    setAllowed(false);
    setQuery("");
    setResults(undefined);
    select("");
    setNotice("");
  }

  if (!open) return <button type="button" className="mtg-reply-action" aria-label="Forward message" title="Forward message"
    onClick={() => void start()}><Forward size={15} aria-hidden="true" /></button>;

  return <div className="mtg-edit" role="group" aria-label="Forward Telegram message">
    {notice && <p role="status">{notice}</p>}
    {allowed && <>
      <label>Find recipient <input type="search" value={query} maxLength={128} disabled={busy}
        onChange={(event) => { setQuery(event.target.value); select(""); setResults(undefined); setNotice(""); }} /></label>
      <button type="button" className="mtg-action" disabled={busy || query.trim().length < 2} onClick={() => void search()}>Find chats</button>
      <label>Forward to <select value={selected} disabled={busy} onChange={(event) => select(event.target.value)}>
        <option value="">Select a Telegram chat</option>
        {recipients.map(({ id, name, kind }) => <option key={id} value={id}>{name} · {kind} · ID {id}</option>)}
      </select></label>
      {forum && !matched && <p role="status">Loading forum topics…</p>}
      {matched?.error && <button type="button" className="mtg-action" onClick={() => {
        setTopicResult(undefined);
        setTopicRetry((value) => value + 1);
      }}>Retry loading topics</button>}
      {topics && <label>Forward to topic <select value={topicId} disabled={busy || !topics.length}
        onChange={(event) => setTopicId(event.target.value)}>
        <option value="">{topics.length ? "Select a Telegram topic" : "No topics available"}</option>
        {topics.map(({ id, name }) => <option key={id} value={id}>{name} · ID {id}</option>)}
      </select></label>}
      <button type="button" className="mtg-action" disabled={!ready || busy} onClick={() => void submit()}>Forward</button>
    </>}
    <button type="button" className="mtg-action" disabled={busy} onClick={close}>Close</button>
  </div>;
}
