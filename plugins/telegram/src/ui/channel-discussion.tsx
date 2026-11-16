import { submitComposerOnEnter } from "./composer-keys.ts";
import { useEffect, useState, type ComponentProps } from "react";
import type { DiscussionPage, SendResult } from "../core/contract.ts";
import { MessageTimestamp } from "./message-timestamp.tsx";
import { MessageContent } from "./message-content.tsx";
import { MessageAuthor, type AvatarLoader } from "./avatar.tsx";

export type ChannelDiscussionLoader = (id: string, messageId: string, before?: string) => Promise<DiscussionPage>;
type Media = Pick<ComponentProps<typeof MessageContent>, "loadPhoto" | "loadMedia" | "loadVideoStream" | "transcribeVoice" | "saveDocument" | "mediaCollection">;

export function ChannelDiscussion({ chatId, postId, load, send, close, loadAvatar, ...media }: Media & {
  chatId: string;
  postId: string;
  load: ChannelDiscussionLoader;
  send?: (id: string, postId: string, group: string, root: string, text: string) => Promise<SendResult>;
  close: () => void;
  loadAvatar?: AvatarLoader;
}) {
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [sendStatus, setSendStatus] = useState("");
  const [page, setPage] = useState<DiscussionPage>();
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);

  useEffect(() => {
    let active = true;
    setError(false);
    void load(chatId, postId).then(
      (result) => { if (active) setPage(result); },
      () => { if (active) setError(true); },
    );
    return () => { active = false; };
  }, [chatId, postId, load, revision]);

  async function more() {
    if (!page?.before || loadingOlder) return;
    const cursor = page.before;
    setLoadingOlder(true);
    setError(false);
    try {
      const older = await load(chatId, postId, cursor);
      setPage((previous) => {
        if (!previous || previous.before !== cursor) return previous;
        const merged = new Map(older.messages.map((row) => [row.id, row]));
        for (const row of previous.messages) merged.set(row.id, row);
        return { ...previous, messages: [...merged.values()], before: older.before };
      });
    } catch { setError(true); }
    finally { setLoadingOlder(false); }
  }

  async function submit() {
    const text = draft.trim();
    if (!send || !page || !text || sending) return;
    const { chat, root } = page;
    setSending(true);
    setSendStatus("");
    try {
      const result = await send(chatId, postId, chat.id, root, text);
      if (result.state === "sent") {
        const sent = result.message;
        setPage((previous) => previous && previous.root === root && previous.chat.id === chat.id
          && !previous.messages.some(({ id }) => id === sent.id) ? { ...previous, messages: [...previous.messages, sent] } : previous);
        setDraft((previous) => previous.trim() === text ? "" : previous);
      } else setSendStatus(result.state === "failed" ? "Telegram rejected the comment. Check that you can post in the discussion group."
        : "Delivery unconfirmed. Refresh the discussion before retrying.");
    } catch { setSendStatus("Delivery unconfirmed. Refresh the discussion before retrying."); }
    finally { setSending(false); }
  }

  return <section className="mtg-conversation-search" aria-label="Channel comments">
    <button type="button" autoFocus className="mtg-action" onClick={close}>Back to channel</button>
    {page && !error && <button type="button" className="mtg-action" disabled={loadingOlder} onClick={() => setRevision((value) => value + 1)}>Refresh comments</button>}
    {!page && !error && <p role="status">Loading comments…</p>}
    {error && <p role="alert">Could not load comments. <button type="button" className="mtg-action"
      onClick={() => setRevision((value) => value + 1)}>Refresh</button></p>}
    {page && <>
      <h3>{page.chat.name}</h3>
      {page.before && <button type="button" className="mtg-action" disabled={loadingOlder}
        onClick={() => void more()}>Load earlier comments</button>}
      {!page.messages.length && !page.before && <p>No comments.</p>}
      {!!page.messages.length && <ol aria-label="Comments">{page.messages.map((message) => <li key={message.id}>
        <MessageAuthor message={message} chat={page.chat} load={loadAvatar} />
        <div className="mtg-message-time"><MessageTimestamp message={message} /></div>
        <MessageContent chatId={page.chat.id} message={message} {...media} />
      </li>)}</ol>}
      {send && <form className="mtg-composer" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        <textarea rows={1} onKeyDown={submitComposerOnEnter} aria-label="Write a comment" placeholder="Write a comment" maxLength={4096} value={draft}
          onChange={(event) => setDraft(event.target.value)} />
        <button type="submit" className="mtg-action" disabled={sending || !draft.trim()}>
          {sending ? "Sending…" : "Send comment"}
        </button>
      </form>}
      {sendStatus && <p role="alert">{sendStatus}</p>}
    </>}
  </section>;
}
