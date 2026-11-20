import { useTelegramLocale } from "./i18n/index.tsx";
import { Pencil } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ComponentProps, type RefObject } from "react";
import { savedSourceFilter, type HistoryPage, type SavedSourceFilter, type SavedSourcePage, type SavedTag, type SavedTagType, type SendResult } from "../core/contract.ts";
import type { Message } from "../core/demo.ts";
import { localDayEnd } from "../core/message-timeline.ts";
import { CopyMessageReference } from "./copy-message-reference.tsx";
import { earlierHistoryCursor } from "../core/history-refresh.ts";
import { captureHistoryScroll, historyPageKey, historyWheelDirection, observeHistoryResize, restoreHistoryScroll } from "./history-scroll.ts";
import { HistoryRemovalAnchor } from "./history-removal-anchor.tsx";
import { MessageContent } from "./message-content.tsx";
import { MessageDeletion, type MessageDeletionActions } from "./message-deletion.tsx";
import { MessageEdit, editableMessageText, submitMessageEdit, type EditCaption, type EditDraft, type EditText } from "./message-edit.tsx";
import { MessagePin, type MessagePinActions } from "./message-pin.tsx";
import { MessageTimestamp } from "./message-timestamp.tsx";

export type SavedSourcesActions = {
  list: (offset: number) => Promise<SavedSourcePage>;
  listTags?: (id: string) => Promise<SavedTag[]>;
  setPinned?: (id: string, pinned: boolean, expected: boolean) => Promise<"updated" | "changed" | "refused">;
  reorderPinned?: (order: string[], expected: string[]) => Promise<"updated" | "changed" | "refused">;
  history: (id: string, before?: string, query?: string, date?: number, filter?: SavedSourceFilter, tag?: SavedTagType) => Promise<HistoryPage>;
};

type Media = Pick<ComponentProps<typeof MessageContent>,
  "loadPhoto" | "loadMedia" | "loadVideoStream" | "saveDocument" | "transcribeVoice"
  | "mediaCollection" | "forwardActions" | "reactionActions" | "stopPoll" | "voteInPoll">;
type Source = SavedSourcePage["sources"][number];
type EditActions = { editText?: EditText; editCaption?: EditCaption };
type OpenSourceChat = (chatId: string, signal: AbortSignal) => Promise<boolean>;

export function SavedSources({ chatId, actions, media, close, hidden, liveRevision, openMessage, openSourceChat, deletion, deletedIds, pinning: messagePinning, editActions }: {
  chatId: string;
  actions: SavedSourcesActions;
  media: Media;
  close: () => void;
  hidden?: boolean;
  liveRevision?: number;
  openMessage?: (id: string) => void;
  openSourceChat?: OpenSourceChat;
  deletion?: MessageDeletionActions;
  deletedIds?: ReadonlySet<string>;
  pinning?: MessagePinActions;
  editActions?: EditActions;
}) {
  const { t: tr } = useTelegramLocale();
  const [sources, setSources] = useState<Source[]>([]);
  const [selected, setSelected] = useState<Source>();
  const [request, setRequest] = useState({ offset: 0 });
  const [next, setNext] = useState<number | null>(null);
  const [status, setStatus] = useState<"loading" | "failed" | "ready">("loading");
  const [pinning, setPinning] = useState(false);
  const [pinNotice, setPinNotice] = useState("");
  const [sourceQuery, setSourceQuery] = useState("");
  const sourceTerm = sourceQuery.trim().normalize("NFC").toLocaleLowerCase();
  const visibleSources = sourceTerm
    ? sources.filter(({ title }) => title.normalize("NFC").toLocaleLowerCase().includes(sourceTerm))
    : sources;
  const pinned = sources.filter((source) => source.pinned);
  const canReorder = !!actions.reorderPinned && pinned.length >= 2 && pinned.length <= 40
    && (next === null || sources.some((source) => !source.pinned));
  const returnPosition = useRef<{ button: HTMLButtonElement; top: number }>(null);
  const sourceListPosition = useRef<{ id: string; top: number }>(null);
  const sourceListButton = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const position = sourceListPosition.current;
    if (!panel.current || !position) return;
    if (selected) {
      panel.current.scrollTop = 0;
      return;
    }
    panel.current.scrollTop = position.top;
    sourceListButton.current?.focus({ preventScroll: true });
    sourceListPosition.current = null;
  }, [selected]);
  useLayoutEffect(() => {
    const position = returnPosition.current;
    if (hidden || !position || !panel.current) return;
    returnPosition.current = null;
    panel.current.scrollTop = position.top;
    position.button.focus({ preventScroll: true });
  }, [hidden]);
  const list = actions.list;
  useEffect(() => {
    let active = true;
    void list(request.offset).then((page) => {
      if (!active) return;
      if (page.next !== null && page.next <= request.offset) {
        setStatus("failed");
        return;
      }
      setSources((previous) => request.offset === 0 ? page.sources
        : [...new Map([...previous, ...page.sources].map((source) => [source.id, source])).values()]);
      setNext(page.next);
      setStatus("ready");
    }, () => { if (active) setStatus("failed"); });
    return () => { active = false; };
  }, [list, request]);

  useEffect(() => {
    if (!sourceTerm || selected || hidden || pinning || status !== "ready" || next === null) return;
    setStatus("loading");
    setRequest({ offset: next });
  }, [sourceTerm, selected, hidden, pinning, status, next]);

  async function changePin(source: Source) {
    if (!actions.setPinned || pinning || status !== "ready") return;
    setPinning(true);
    setPinNotice("");
    try {
      const result = await actions.setPinned(source.id, !source.pinned, source.pinned);
      if (result === "refused") {
        setPinNotice("Telegram could not change this pin.");
        return;
      }
      setPinNotice(result === "changed" ? "The pin changed in Telegram." : source.pinned ? "Source unpinned." : "Source pinned.");
      setStatus("loading");
      setRequest({ offset: 0 });
    } catch {
      setPinNotice("Telegram did not confirm the pin change.");
    } finally {
      setPinning(false);
    }
  }

  async function movePin(index: number, direction: -1 | 1) {
    if (!actions.reorderPinned || pinning || status !== "ready" || !canReorder) return;
    const expected = pinned.map(({ id }) => id);
    const order = [...expected];
    const neighbor = index + direction;
    if (!order[index] || !order[neighbor]) return;
    [order[index], order[neighbor]] = [order[neighbor]!, order[index]!];
    setPinning(true);
    setPinNotice("");
    try {
      const result = await actions.reorderPinned(order, expected);
      if (result === "refused") {
        setPinNotice("Telegram could not reorder pinned sources.");
        return;
      }
      setPinNotice(result === "changed" ? "Pinned sources changed in Telegram." : "Pinned source order saved.");
      setStatus("loading");
      setRequest({ offset: 0 });
    } catch {
      setPinNotice("Telegram did not confirm the source order.");
    } finally {
      setPinning(false);
    }
  }

  return <section ref={panel} hidden={hidden} tabIndex={selected ? 0 : undefined} className={selected ? "mtg-conversation-search mtg-saved-source-history" : "mtg-conversation-search"}
    aria-label={tr("Saved Messages by chat")}>
    {selected ? <SavedSourceHistory key={selected.id} chatId={chatId} source={selected} load={actions.history} loadTags={actions.listTags} media={media}
      panel={panel} liveRevision={liveRevision} hidden={hidden}
      openSourceChat={hidden ? undefined : openSourceChat}
      deletion={deletion} deletedIds={deletedIds} pinning={messagePinning} editActions={editActions}
      openMessage={openMessage && ((id, button) => {
        returnPosition.current = { button, top: panel.current?.scrollTop ?? 0 };
        openMessage(id);
      })}
      back={() => setSelected(undefined)} /> : <>
      <button type="button" className="mtg-action" onClick={close}>{tr("Back to all saved messages")}</button>
      <div className="mtg-composer" role="search">
        <input type="search" aria-label={tr("Find saved sources")} placeholder={tr("Find saved sources")} maxLength={256}
          value={sourceQuery} onChange={(event) => setSourceQuery(event.target.value)} />
      </div>
      {visibleSources.length > 0 && <ol aria-label={tr("Saved sources")}>{visibleSources.map((source) => {
        const index = pinned.indexOf(source);
        return <li key={source.id}>
          <button type="button" className="mtg-action" ref={sourceListPosition.current?.id === source.id ? sourceListButton : undefined}
            onClick={() => {
              sourceListPosition.current = { id: source.id, top: panel.current?.scrollTop ?? 0 };
              setSelected(source);
            }}>
            <bdi>{source.title}</bdi>{source.pinned ? tr(" · Pinned") : ""}
          </button>
          {actions.setPinned && <button type="button" className="mtg-action" disabled={pinning || status !== "ready"}
            aria-label={`${source.pinned ? "Unpin" : "Pin"} ${source.title}`}
            onClick={() => void changePin(source)}>{source.pinned ? tr("Unpin") : tr("Pin")}</button>}
          {canReorder && index !== -1 && <>
            <button type="button" className="mtg-action" aria-label={tr("Move {0} up", [source.title])}
              disabled={pinning || status !== "ready" || index === 0} onClick={() => void movePin(index, -1)}>{tr("Move up")}</button>
            <button type="button" className="mtg-action" aria-label={tr("Move {0} down", [source.title])}
              disabled={pinning || status !== "ready" || index === pinned.length - 1} onClick={() => void movePin(index, 1)}>{tr("Move down")}</button>
          </>}
        </li>;
      })}</ol>}
      {pinNotice && <p role="status">{tr(pinNotice)}</p>}
      {status === "loading" && <p role="status">{sourceTerm ? tr("Searching saved sources…") : tr("Loading sources…")}</p>}
      {status === "failed" && <p role="alert">{tr("Could not load saved sources. ")}<button type="button" className="mtg-action"
        onClick={() => { setStatus("loading"); setRequest({ ...request }); }}>{tr("Retry")}</button></p>}
      {status === "ready" && next === null && !visibleSources.length && <p>{sourceTerm ? tr("No matching sources.") : tr("No saved sources.")}</p>}
      {status === "ready" && next !== null && !sourceTerm && <button className="mtg-action" type="button" disabled={pinning} onClick={() => {
        setStatus("loading");
        setRequest({ offset: next });
      }}>{tr("Load more sources")}</button>}
    </>}
  </section>;
}

function SavedSourceHistory({ chatId, source, load, loadTags, media, panel, liveRevision, hidden, back, openMessage, openSourceChat, deletion, deletedIds, pinning, editActions }: {
  chatId: string;
  source: Source;
  load: SavedSourcesActions["history"];
  loadTags?: SavedSourcesActions["listTags"];
  media: Media;
  panel: RefObject<HTMLElement | null>;
  liveRevision?: number;
  hidden?: boolean;
  back: () => void;
  openMessage?: (id: string, button: HTMLButtonElement) => void;
  openSourceChat?: OpenSourceChat;
  deletion?: MessageDeletionActions;
  deletedIds?: ReadonlySet<string>;
  pinning?: MessagePinActions;
  editActions?: EditActions;
}) {
  const { t: tr } = useTelegramLocale();
  const [messages, setMessages] = useState<Message[]>([]);
  const [deferredLatest, setDeferredLatest] = useState<HistoryPage>();
  const seenRevision = useRef(liveRevision);
  const renderedMessages = useRef(messages);
  const [queryText, setQueryText] = useState("");
  const [filter, setFilter] = useState<SavedSourceFilter>();
  const [tags, setTags] = useState<SavedTag[]>([]);
  const [tagIndex, setTagIndex] = useState<number>();
  const [tagError, setTagError] = useState(false);
  const tag = tagIndex === undefined ? undefined : tags[tagIndex]?.type;
  const [day, setDay] = useState("");
  const [selectedDay, setSelectedDay] = useState("");
  const [request, setRequest] = useState<{ before?: string; query?: string; date?: number; filter?: SavedSourceFilter; tag?: SavedTagType }>({});
  const [next, setNext] = useState<string | null>(null);
  const [status, setStatus] = useState<"loading" | "failed" | "ready">("loading");
  const [editing, setEditing] = useState<EditDraft>();
  const [unpinned, setUnpinned] = useState<ReadonlySet<string>>(() => new Set());
  const previousTop = useRef(0);
  const pageAnchor = useRef<{ request: typeof request; position: ReturnType<typeof captureHistoryScroll> } | undefined>(undefined);
  const removed = request.filter === "pinned" ? new Set([...(deletedIds ?? []), ...unpinned]) : deletedIds;
  const visible = messages.filter(({ id }) => !removed?.has(id));
  const searching = !!request.query || !!request.filter || !!request.tag;
  const canPage = status === "ready" && !!next && !editing;
  const loadNext = useCallback(() => {
    if (!canPage || !next) return;
    setStatus("loading");
    setRequest((previous) => previous.before === next ? previous
      : { query: request.query, filter: request.filter, tag: request.tag, before: next });
  }, [canPage, next, request]);

  useLayoutEffect(() => {
    renderedMessages.current = messages;
    const anchor = pageAnchor.current;
    pageAnchor.current = undefined;
    const list = panel.current;
    if (!list || list.hidden || anchor?.request !== request) return;
    restoreHistoryScroll(list, anchor.position);
    previousTop.current = list.scrollTop;
  }, [deferredLatest, messages, panel, request]);

  useLayoutEffect(() => {
    const list = panel.current;
    if (!list) return;
    return observeHistoryResize(list, () => !list.hidden, () => false,
      () => { previousTop.current = list.scrollTop; });
  }, [panel, messages, deletedIds, unpinned]);

  useLayoutEffect(() => {
    const list = panel.current;
    if (!list || !canPage || searching) return;
    previousTop.current = list.scrollTop;
    let requested = false;
    function requestEarlier() {
      if (requested) return;
      requested = true;
      loadNext();
    }
    function onScroll() {
      if (!list || list.hidden) return;
      const top = list.scrollTop;
      const downward = top > previousTop.current;
      previousTop.current = top;
      if (downward && list.scrollHeight - list.clientHeight - top <= 96) requestEarlier();
    }
    function atEnd() {
      return list && !list.hidden && list.scrollHeight - list.clientHeight - list.scrollTop <= 1;
    }
    function onWheel(event: WheelEvent) {
      if (atEnd() && historyWheelDirection(event) === "down") requestEarlier();
    }
    function onKeyDown(event: KeyboardEvent) {
      if (!atEnd() || !historyPageKey(event, "down")) return;
      event.preventDefault();
      requestEarlier();
    }
    list.addEventListener("scroll", onScroll, { passive: true });
    list.addEventListener("wheel", onWheel, { passive: true });
    list.addEventListener("keydown", onKeyDown);
    return () => {
      list.removeEventListener("scroll", onScroll);
      list.removeEventListener("wheel", onWheel);
      list.removeEventListener("keydown", onKeyDown);
    };
  }, [canPage, loadNext, panel, searching]);

  useEffect(() => {
    if (!loadTags) return;
    let active = true;
    void loadTags(source.id).then((page) => {
      if (active) {
        setTags(page);
        setTagError(false);
      }
    }, () => { if (active) setTagError(true); });
    return () => { active = false; };
  }, [loadTags, source.id]);

  useEffect(() => {
    let active = true;
    const args = [source.id, request.before, request.query, request.date, request.filter] as const;
    const pageResult = request.tag ? load(...args, request.tag) : load(...args);
    void pageResult.then((page) => {
      if (!active) return;
      const list = panel.current;
      if (request.before && list && !list.hidden) {
        pageAnchor.current = { request, position: captureHistoryScroll(list, "keep") };
      }
      setMessages((previous) => {
        const rows = new Map(previous.map((message) => [message.id, message]));
        for (const message of page.messages) {
          if (!request.before || !rows.has(message.id)) rows.set(message.id, message);
        }
        return [...rows.values()];
      });
      setNext(earlierHistoryCursor(request.before, page.before));
      setStatus("ready");
    }, () => { if (active) setStatus("failed"); });
    return () => { active = false; };
  }, [load, panel, request, source.id]);

  useEffect(() => {
    if (hidden || status !== "ready" || searching || selectedDay || editing || liveRevision === seenRevision.current) return;
    let active = true;
    void load(source.id).then((page) => {
      if (!active) return;
      seenRevision.current = liveRevision;
      const previous = renderedMessages.current;
      const list = panel.current;
      if (list && !list.hidden && list.scrollTop > 1) {
        pageAnchor.current = { request, position: captureHistoryScroll(list, "keep") };
      }
      if (previous.length && page.before && Number(page.before) > Number(previous[0]?.id)) {
        setDeferredLatest(page);
        return;
      }
      setDeferredLatest(undefined);
      if (!previous.length) setNext(earlierHistoryCursor(undefined, page.before));
      setMessages((current) => {
        const oldest = Number(current.at(-1)?.id ?? 0);
        const rows = new Map(current.map((message) => [message.id, message]));
        for (const message of page.messages) if (Number(message.id) >= oldest) rows.set(message.id, message);
        return [...rows.values()].sort((left, right) => Number(right.id) - Number(left.id));
      });
    }, () => { /* Keep the displayed history available until the next update. */ });
    return () => { active = false; };
  }, [editing, hidden, liveRevision, load, panel, request, searching, selectedDay, source.id, status]);

  function restart(request: { query?: string; date?: number; filter?: SavedSourceFilter; tag?: SavedTagType }, dateLabel = "") {
    seenRevision.current = liveRevision;
    setDeferredLatest(undefined);
    setEditing(undefined);
    setMessages([]);
    setUnpinned(new Set());
    setNext(null);
    setStatus("loading");
    setSelectedDay(dateLabel);
    setRequest(request);
  }

  const setMessagePinned = pinning?.setMessagePinned;
  const updatePin: MessagePinActions["setMessagePinned"] = async (id, messageId, pinned) => {
    if (!setMessagePinned) return "refused";
    const result = await setMessagePinned(id, messageId, pinned);
    if (result === "updated") {
      setUnpinned((previous) => {
        const next = new Set(previous);
        if (pinned) next.delete(messageId);
        else next.add(messageId);
        return next;
      });
    }
    return result;
  };

  const saveEdit: ComponentProps<typeof MessageEdit>["save"] = async (event, styles, removeLinkPreview, placement, links, customEmoji) => {
    event.preventDefault();
    if (!editing || editing.busy || !editActions || deletedIds?.has(editing.message.id)) return;
    const { message, text } = editing;
    setEditing({ ...editing, busy: true, error: undefined });
    let result: SendResult;
    try {
      result = await (submitMessageEdit(chatId, message, text.trim(), editActions, styles, removeLinkPreview, placement, links, undefined, customEmoji) ?? { state: "failed" });
    } catch {
      result = { state: "unknown" };
    }
    if (result.state === "sent" && result.message.id === message.id) {
      if (searching) restart({ query: request.query, filter: request.filter, tag: request.tag });
      else {
        const updated = result.message;
        setMessages((previous) => previous.map((row) => row.id === updated.id ? updated : row));
        setEditing(undefined);
      }
    } else {
      setEditing({ ...editing, busy: false, error: result.state === "failed"
        ? "The message changed or Telegram rejected the edit." : "Telegram did not confirm the edit." });
    }
  };

  return <>
    <button type="button" className="mtg-action" onClick={back}>{tr("Back to saved sources")}</button>
    <h3><bdi>{source.title}</bdi></h3>
    {source.chatId && openSourceChat && <OpenSourceChatButton chatId={source.chatId} open={openSourceChat} />}
    <form className="mtg-composer" role="search" onSubmit={(event) => {
      event.preventDefault();
      const query = queryText.trim() || undefined;
      if ((query || filter || tag) && !editing?.busy) restart({ query, filter, tag });
    }}>
      <input type="search" aria-label={tr("Search saved messages")} placeholder={tr("Search saved messages")}
        maxLength={128} value={queryText} onChange={(event) => setQueryText(event.target.value)} />
      <select aria-label={tr("Saved message type")} value={tagIndex === undefined ? filter ?? "" : `tag:${tagIndex}`} onChange={(event) => {
        const choice = event.currentTarget.value;
        const value = savedSourceFilter.safeParse(choice);
        setFilter(value.success ? value.data : undefined);
        setTagIndex(choice.startsWith("tag:") ? Number(choice.slice(4)) : undefined);
      }}>
        <option value="">{tr("All types")}</option>
        <option value="photo">{tr("Photos")}</option>
        <option value="video">{tr("Videos")}</option>
        <option value="document">{tr("Documents")}</option>
        <option value="audio">{tr("Music and audio")}</option>
        <option value="voiceVideoNotes">{tr("Voice and video messages")}</option>
        <option value="gif">GIFs</option>
        <option value="link">{tr("Links")}</option>
        <option value="pinned">{tr("Pinned messages")}</option>
        {tags.length > 0 && <optgroup label={tr("Saved tags")}>{tags.map(({ type, label, count }, index) => (
          <option key={index} value={`tag:${index}`}>{label || (type.kind === "emoji" ? type.emoji : tr("Custom emoji {0}", [type.id]))} ({count})</option>
        ))}</optgroup>}
      </select>
      <button type="submit" className="mtg-action" disabled={(!queryText.trim() && !filter && !tag) || editing?.busy}>{tr("Find")}</button>
      {searching && <button type="button" className="mtg-action" disabled={editing?.busy} onClick={() => {
        setQueryText("");
        setFilter(undefined);
        setTagIndex(undefined);
        restart({});
      }}>{tr("Clear search")}</button>}
    </form>
    {tagError && <p role="status">{tr("Could not load saved tags.")}</p>}
    <form className="mtg-composer" onSubmit={(event) => {
      event.preventDefault();
      const date = localDayEnd(day);
      if (date === undefined || editing?.busy) return;
      setQueryText("");
      setFilter(undefined);
      setTagIndex(undefined);
      restart({ date }, day);
    }}>
      <label>{tr("Jump to date ")}<input type="date" min="1970-01-01" max="2038-01-19" required
        value={day} onChange={(event) => setDay(event.target.value)} /></label>
      <button type="submit" className="mtg-action" disabled={!day || editing?.busy}>{tr("Go to date")}</button>
      {selectedDay && <button type="button" className="mtg-action" disabled={editing?.busy} onClick={() => {
        setDay("");
        restart({});
      }}>{tr("Back to latest")}</button>}
    </form>
    {selectedDay && <p>{tr("Messages on or before ")}<time dateTime={selectedDay}>{selectedDay}</time></p>}
    {deferredLatest && <button type="button" className="mtg-action" disabled={status !== "ready" || !!editing} onClick={() => {
      const list = panel.current;
      if (list) list.scrollTop = 0;
      previousTop.current = 0;
      setMessages(deferredLatest.messages);
      setNext(earlierHistoryCursor(undefined, deferredLatest.before));
      setDeferredLatest(undefined);
    }}>{tr("Jump to latest saved messages")}</button>}
    <HistoryRemovalAnchor list={panel} removed={removed} onAdjusted={(top) => { previousTop.current = top; }}>
    {visible.length > 0 && <ol aria-label={tr("Messages saved from this source")}>{visible.map((message) =>
      <li key={message.id} data-message-id={message.id}>
        <MessageContent chatId={chatId} message={message} {...media} />
        <MessageTimestamp message={message} />
        {!message.retained && !message.pendingDelivery &&
          <CopyMessageReference chatId={chatId} messageId={message.id} />}
        {!message.retained && !message.pendingDelivery && /^[1-9]\d{0,15}$/.test(message.id) && <>
          {pinning && <MessagePin chatId={chatId} messageId={message.id} pinStatus={pinning.pinStatus} setMessagePinned={updatePin} />}
          {deletion && <MessageDeletion chatId={chatId} messageId={message.id} {...deletion} />}
          {(message.editableCaption ? editActions?.editCaption : message.editable && editActions?.editText) &&
            <button type="button" className="mtg-reply-action" disabled={editing?.busy || status !== "ready"}
              aria-label={message.editableCaption ? tr("Edit caption") : tr("Edit message")}
              onClick={() => setEditing({ message, text: editableMessageText(message), busy: false })}>
              <Pencil size={15} aria-hidden="true" />
            </button>}
        </>}
        {openMessage && !message.retained && /^[1-9]\d{0,15}$/.test(message.id) &&
          <button className="mtg-action" type="button" onClick={(event) => openMessage(message.id, event.currentTarget)}>{tr("Open in Saved Messages")}</button>}
        {editing?.message.id === message.id && <MessageEdit draft={editing} save={saveEdit}
          change={(text) => setEditing({ ...editing, text })} cancel={() => setEditing(undefined)} />}
      </li>)}</ol>}
    </HistoryRemovalAnchor>
    {status === "loading" && <p role="status" className={next ? "mtg-visually-hidden" : undefined}>{tr("Loading saved messages…")}</p>}
    {status === "failed" && <p role="alert">{tr("Could not load saved messages. ")}<button type="button" className="mtg-action"
      onClick={() => { setStatus("loading"); setRequest({ ...request }); }}>{tr("Retry")}</button></p>}
    {status === "ready" && !visible.length && !next && <p>{searching ? tr("No matching saved messages.")
      : selectedDay ? tr("No saved messages on or before this date.") : tr("No messages saved from this source.")}</p>}
    {status !== "failed" && next && <button className="mtg-action" type="button" disabled={!!editing}
      aria-disabled={status === "loading"} aria-busy={status === "loading"}
      onClick={loadNext}>{searching ? tr("Load more matches") : tr("Load earlier saved messages")}</button>}
  </>;
}

function OpenSourceChatButton({ chatId, open }: { chatId: string; open: OpenSourceChat }) {
  const { t: tr } = useTelegramLocale();
  const attempt = useRef<AbortController>(null);
  const [status, setStatus] = useState<"pending" | "failed">();
  useEffect(() => () => attempt.current?.abort(), []);

  async function openChat() {
    if (attempt.current) return;
    const controller = new AbortController();
    attempt.current = controller;
    setStatus("pending");
    const opened = await open(chatId, controller.signal).catch(() => false);
    if (controller.signal.aborted) return;
    attempt.current = null;
    setStatus(opened ? undefined : "failed");
  }

  return <>
    <button type="button" className="mtg-action" disabled={status === "pending"} onClick={() => void openChat()}>
      {status === "pending" ? tr("Opening original chat…") : tr("Open original chat")}
    </button>
    {status === "failed" && <p role="alert">{tr("Could not open the original chat.")}</p>}
  </>;
}
