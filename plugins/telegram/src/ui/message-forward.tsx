import { useTelegramLocale } from "./i18n/index.tsx";
import { Forward, Search, X } from "lucide-react";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Button } from "../../components/ui/button.tsx";
import { AttachmentDeliveryControls, attachmentDelivery, repeatLabel, type AttachmentDeliveryDraft } from "./attachment-delivery.tsx";
import { scheduleRepeatPeriods, type ForwardDelivery, type ForwardAlbum, type ForwardPresentation, type ForumTopic, type ForwardResult,
  type ForwardTarget, type CommunitySummary, type MessageEffectChoice, type ScheduleRepeatPeriod, type TelegramFolder } from "../core/contract.ts";
import type { Chat } from "../core/demo.ts";
import { RecipientFolderSelect } from "./folder-navigation.tsx";
import { MessageEffectPicker } from "./message-effect.tsx";
import { isPlainKey } from "./composer-keys.ts";

export type RecipientPage = { chats: Chat[]; nextOffset: number | null };

export type ForwardActions = {
  forwardOptions: (chatId: string, messageId: string, album?: ForwardAlbum) => Promise<boolean>;
  forwardMessage: (chatId: string, messageId: string, target: ForwardTarget, album?: ForwardAlbum, presentation?: ForwardPresentation, delivery?: ForwardDelivery, comment?: string) => Promise<ForwardResult>;
  searchRecipients: (query: string) => Promise<Chat[]>;
  recipients: readonly Chat[];
  folders?: {
    items: readonly TelegramFolder[];
    page: (id: number, offset: number) => Promise<RecipientPage>;
    search: (id: number, query: string) => Promise<Chat[]>;
  };
  communities?: {
    list: () => Promise<CommunitySummary[] | null>;
    chats: (id: string) => Promise<ForwardTarget[] | null>;
  };
  loadTopics?: (chatId: string, query: string) => Promise<ForumTopic[] | null>;
  loadMessageEffects?: (id: string) => Promise<MessageEffectChoice[]>;
  canScheduleWhenOnline?: (id: string) => Promise<boolean>;
  canScheduleRepeats?: () => Promise<boolean>;
};

export function MessageForward({ chatId, messageId, actions, album, hasCaption, selectionCount, onOpenChange, game, reviewRequest }: {
  chatId: string; messageId: string; actions: ForwardActions; album?: ForwardAlbum; hasCaption?: boolean;
  selectionCount?: number; onOpenChange?: (open: boolean) => void;
  game?: true; reviewRequest?: number;
}) {
  const { t: tr } = useTelegramLocale();
  const subject = selectionCount ? "selected messages" : album ? "album" : game ? "game" : "message";
  const actionLabel = selectionCount ? tr("Forward selected messages") : album ? tr("Forward album") : tr("Forward message");
  const title = game ? tr("Share game") : selectionCount ? tr("Forward {0} messages", [selectionCount]) : actionLabel;
  const dialogId = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const searchField = useRef<HTMLInputElement>(null);
  const dispatching = useRef(false);
  const reviewed = useRef<number>(undefined);
  const [deliveryDraft, setDeliveryDraft] = useState<AttachmentDeliveryDraft>();
  const [whenOnline, setWhenOnline] = useState(false);
  const [repeatEvery, setRepeatEvery] = useState<ScheduleRepeatPeriod>();
  const [scheduleAvailability, setScheduleAvailability] = useState<{ id: string; online: boolean; repeat: boolean }>();
  const [effect, setEffect] = useState<MessageEffectChoice>();
  const delivery = attachmentDelivery(deliveryDraft);
  const [hideSender, setHideSender] = useState(false);
  const [removeCaption, setRemoveCaption] = useState(false);
  const [open, setOpen] = useState(false);
  const [allowed, setAllowed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Chat[]>();
  const [folder, setFolder] = useState<{ id: number; page?: RecipientPage }>();
  const folderAvailable = folder && !!actions.folders?.items.some(({ id }) => id === folder.id);
  const [communities, setCommunities] = useState<CommunitySummary[]>();
  const [community, setCommunity] = useState<{ id: string; recipients: ForwardTarget[] }>();
  const [selected, setSelected] = useState("");
  const [topicId, setTopicId] = useState("");
  const [topicResult, setTopicResult] = useState<{ id: string; topics: ForumTopic[] | null; error?: boolean }>();
  const [topicRetry, setTopicRetry] = useState(0);
  const [notice, setNotice] = useState("");
  const [comment, setComment] = useState("");
  const listedChats = folder ? folder.page?.chats ?? [] : actions.recipients;
  const candidateChats = folder && !folderAvailable ? [] : results ?? listedChats;
  const recipients = community?.recipients ?? candidateChats.flatMap(({ id, name, subtitle: kind }): ForwardTarget[] =>
    kind === "Direct message" || kind === "Group" || kind === "Channel" ? [{ id, name, kind }] : []);
  const target = recipients.find(({ id }) => id === selected);
  const singleMessage = !album && !selectionCount && !game;
  const canChooseEffect = singleMessage && target?.kind === "Direct message" && target.name !== "Saved Messages";
  const availability = scheduleAvailability?.id === target?.id ? scheduleAvailability : undefined;
  const scheduled = whenOnline || !!deliveryDraft?.date;
  const forum = target?.kind === "Group" && actions.loadTopics ? target.id : undefined;
  const loadTopics = actions.loadTopics;
  const matched = forum === topicResult?.id ? topicResult : undefined;
  const topics = matched?.topics;
  const topic = topics?.find(({ id }) => String(id) === topicId);
  const ready = !!target && (!forum || (!!matched && !matched.error && (topics === null || !!topic)));
  const { forwardOptions, canScheduleWhenOnline, canScheduleRepeats } = actions;

  useLayoutEffect(() => {
    if (!open) {
      returnFocus.current?.focus({ preventScroll: true });
      returnFocus.current = null;
      return;
    }
    const panel = dialog.current;
    if (!panel || panel.open) return;
    if (typeof panel.showModal === "function") panel.showModal();
    else panel.open = true;
    heading.current?.focus({ preventScroll: true });
  }, [open]);

  useLayoutEffect(() => {
    if (open && allowed) searchField.current?.focus({ preventScroll: true });
  }, [open, allowed]);

  const scheduleTargetId = !game ? target?.id : undefined;
  const privateTarget = target?.kind === "Direct message" && target.name !== "Saved Messages";
  useEffect(() => {
    if (!open || !allowed || !scheduleTargetId || (!canScheduleWhenOnline && !canScheduleRepeats)) return;
    let active = true;
    void Promise.all([
      privateTarget && canScheduleWhenOnline ? canScheduleWhenOnline(scheduleTargetId).catch(() => false) : false,
      singleMessage && canScheduleRepeats ? canScheduleRepeats().catch(() => false) : false,
    ]).then(([online, repeat]) => { if (active) setScheduleAvailability({ id: scheduleTargetId, online, repeat }); });
    return () => { active = false; };
  }, [open, allowed, scheduleTargetId, privateTarget, singleMessage, canScheduleWhenOnline, canScheduleRepeats]);

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
    setEffect(undefined);
    setWhenOnline(false);
    setRepeatEvery(undefined);
    setScheduleAvailability(undefined);
    setTopicId("");
    setTopicResult(undefined);
  }

  const start = useCallback(async () => {
    if (open) return;
    const messageMenu = trigger.current?.closest(".mtg-message-actions")?.parentElement
      ?.querySelector<HTMLButtonElement>("[data-message-menu][aria-expanded=true]");
    returnFocus.current = messageMenu ?? trigger.current;
    messageMenu?.click();
    setOpen(true);
    onOpenChange?.(true);
    setNotice("Checking Telegram forwarding permissions…");
    setBusy(true);
    try {
      const canForward = await forwardOptions(chatId, messageId, ...(album ? [album] as const : []));
      setAllowed(canForward);
      setNotice(canForward ? "" : selectionCount ? "Telegram does not allow forwarding the entire selection." : tr("Telegram does not allow forwarding this {0}.", [tr(subject)]));
    } catch {
      setNotice("Could not check Telegram forwarding permissions.");
    } finally {
      setBusy(false);
    }
  }, [open, onOpenChange, forwardOptions, chatId, messageId, album, selectionCount, subject, tr]);

  useEffect(() => {
    if (reviewRequest === undefined || reviewRequest === reviewed.current) return;
    reviewed.current = reviewRequest;
    void start();
  }, [reviewRequest, start]);

  async function search() {
    if (busy || query.trim().length < 2 || (folder && !folderAvailable)) return;
    setBusy(true);
    setNotice("");
    select("");
    setCommunity(undefined);
    try {
      const matches = folder && actions.folders
        ? await actions.folders.search(folder.id, query.trim())
        : await actions.searchRecipients(query.trim());
      setResults(matches);
      if (!matches.length) setNotice("No matching Telegram chats.");
    } catch {
      setResults([]);
      setNotice("Could not find Telegram chats.");
    } finally {
      setBusy(false);
    }
  }

  async function loadFolder(id: number, offset = 0) {
    if (busy || !actions.folders?.items.some((item) => item.id === id)) return;
    setBusy(true);
    setNotice("");
    try {
      const page = await actions.folders.page(id, offset);
      setFolder((current) => {
        if (current?.id !== id) return current;
        const chats = new Map((offset ? current.page?.chats ?? [] : []).map((chat) => [chat.id, chat]));
        for (const chat of page.chats) chats.set(chat.id, chat);
        return { id, page: { chats: [...chats.values()], nextOffset: page.nextOffset } };
      });
      if (!offset && !page.chats.length && page.nextOffset === null) setNotice("No chats in this folder.");
    } catch {
      setNotice("Could not load chats in this folder.");
    } finally {
      setBusy(false);
    }
  }

  function chooseFolder(id?: number) {
    if (busy) return;
    setQuery("");
    setResults(undefined);
    setCommunity(undefined);
    select("");
    setNotice("");
    setFolder(id === undefined ? undefined : { id });
    if (id !== undefined) void loadFolder(id);
  }

  async function browseCommunities() {
    if (!actions.communities || busy) return;
    setBusy(true);
    setNotice("");
    try {
      const available = await actions.communities.list();
      if (!available) throw new Error("Community browsing is unavailable.");
      setCommunities(available);
      if (!available.length) setNotice("No joined Telegram communities.");
    } catch {
      setNotice("Could not load Telegram communities.");
    } finally {
      setBusy(false);
    }
  }

  async function chooseCommunity(id: string) {
    if (!actions.communities || busy) return;
    setFolder(undefined);
    setQuery("");
    setResults(undefined);
    select("");
    setNotice("");
    if (!id) {
      setCommunity(undefined);
      return;
    }
    setBusy(true);
    setCommunity({ id, recipients: [] });
    try {
      const chats = await actions.communities.chats(id);
      if (!chats) throw new Error("Community chats are unavailable.");
      setCommunity({ id, recipients: chats });
      if (!chats.length) setNotice("No available chats in this community.");
    } catch {
      setCommunity(undefined);
      setNotice("Could not load chats in this community.");
    } finally {
      setBusy(false);
    }
  }

  async function submit() {
    if (!target || !ready || busy || delivery === null || dispatching.current
      || (whenOnline && !availability?.online) || (repeatEvery !== undefined && !availability?.repeat)) return;
    dispatching.current = true;
    setBusy(true);
    setNotice("");
    const presentation: ForwardPresentation | undefined = hideSender
      ? { hideSender: true, ...(hasCaption && removeCaption ? { removeCaption: true } : {}) } : undefined;
    const trimmedComment = comment.trim();
    const effectId = canChooseEffect ? effect?.id : undefined;
    const options: ForwardDelivery | undefined = whenOnline || repeatEvery || effectId ? {
      ...delivery, ...(whenOnline && { whenOnline: true }), ...(repeatEvery && { repeatEvery }), ...(effectId && { effect: effectId }),
    } : delivery;
    const args: [album?: ForwardAlbum, presentation?: ForwardPresentation, delivery?: ForwardDelivery, comment?: string] = trimmedComment
      ? [album, presentation, options, trimmedComment]
      : options ? [album, presentation, options] : presentation ? [album, presentation] : album ? [album] : [];
    const result = await actions.forwardMessage(chatId, messageId, { ...target, ...(topic ? { topic: { id: topic.id, name: topic.name } } : {}) }, ...args).catch(() => "unknown" as const);
    setAllowed(false);
    const confirmedComment = scheduled ? "Comment scheduled." : "Comment sent.";
    const partialStatus: Partial<Record<ForwardResult, string>> = {
      commentRefused: "Telegram refused the comment. Forwarding was skipped.",
      commentUnknown: "Telegram did not confirm the comment. Check the destination before retrying.",
      forwardRefusedAfterComment: `${confirmedComment} Telegram refused the forward.`,
      forwardUnknownAfterComment: `${confirmedComment} Telegram did not confirm the forward. Check the destination before retrying.`,
    };
    setNotice(partialStatus[result] ?? (result === "sent" ? scheduled ? "Forward scheduled."
      : selectionCount ? "Selected messages forwarded." : album ? "Album forwarded." : game ? "Game forwarded." : "Message forwarded."
      : result === "refused" ? selectionCount ? "Telegram refused to forward the selection." : tr("Telegram refused to forward this {0}.", [tr(subject)])
      : "Telegram did not confirm delivery. Check the destination before retrying."));
    setBusy(false);
  }

  function close() {
    setOpen(false);
    dispatching.current = false;
    onOpenChange?.(false);
    setAllowed(false);
    setDeliveryDraft(undefined);
    setHideSender(false);
    setRemoveCaption(false);
    setQuery("");
    setComment("");
    setResults(undefined);
    setCommunity(undefined);
    setCommunities(undefined);
    setFolder(undefined);
    select("");
    setNotice("");
  }

  const host = trigger.current?.closest("dialog[open], .mtg") ?? trigger.current?.ownerDocument.body;
  const opener = <button ref={trigger} type="button" className={`${game ? "mtg-action" : "mtg-reply-action"} mtg-forward-trigger`} hidden={open}
    aria-label={game ? undefined : actionLabel} title={game ? undefined : actionLabel}
    aria-haspopup="dialog" aria-controls={open ? dialogId : undefined} onClick={() => void start()}>
    {game ? tr("Share game") : <><Forward size={15} aria-hidden="true" />{selectionCount && <span aria-hidden="true">{tr("Forward")}</span>}</>}
  </button>;
  if (!open || !host) return opener;

  return <>{opener}{createPortal(<dialog ref={dialog} id={dialogId} className="mtg-forward-dialog" aria-labelledby={`${dialogId}-title`}
    onKeyDown={(event) => {
      if (!isPlainKey(event, "Escape") || event.currentTarget.querySelector(":is(select:open)")) return;
      event.preventDefault();
      event.stopPropagation();
      if (!busy) close();
    }}
    onCancel={(event) => {
      event.preventDefault();
      event.stopPropagation();
      if (!busy) close();
    }}>
    <header className="mtg-forward-header">
      <h2 id={`${dialogId}-title`} ref={heading} tabIndex={-1}>{title}</h2>
      <Button type="button" size="icon" variant="ghost" aria-label={tr("Close")} disabled={busy} onClick={close}>
        <X size={18} aria-hidden="true" />
      </Button>
    </header>
    <div className="mtg-forward-body">
      {notice && <p role="status" className="mtg-forward-status">{tr(notice)}</p>}
      {allowed && <>
        <form className="mtg-forward-search" onSubmit={(event) => { event.preventDefault(); event.stopPropagation(); void search(); }}>
          <label>{tr("Find recipient ")}<input ref={searchField} type="search" value={query} maxLength={128} disabled={busy}
            onChange={(event) => { setQuery(event.target.value); select(""); setResults(undefined); setCommunity(undefined); setNotice(""); }} /></label>
          <Button type="submit" size="icon" variant="outline" aria-label={tr("Find chats")}
            disabled={busy || query.trim().length < 2 || (!!folder && !folderAvailable)}>
            <Search size={16} aria-hidden="true" />
          </Button>
        </form>
        {actions.folders && <RecipientFolderSelect folders={actions.folders.items} selected={folderAvailable ? folder.id : undefined}
          defaultLabel="Current chat list" disabled={busy} select={chooseFolder} />}
        {folder && !folderAvailable && <button type="button" className="mtg-action" disabled={busy}
          onClick={() => chooseFolder()}>{tr("Return to current chat list")}</button>}
        {actions.communities && (communities?.length
          ? <label>{tr("Find in community ")}<select value={community?.id ?? ""} disabled={busy}
            onChange={(event) => void chooseCommunity(event.currentTarget.value)}>
            <option value="">{tr("All chats")}</option>
            {communities.map(({ id, name }) => <option key={id} value={id}>{name}{tr(" · ID ")}{id}</option>)}
          </select></label>
          : <button type="button" className="mtg-action" disabled={busy}
            onClick={() => void browseCommunities()}>{tr("Browse communities")}</button>)}
        <label>{tr("Forward to ")}<select value={selected} disabled={busy} onChange={(event) => select(event.target.value)}>
          <option value="">{tr("Select a Telegram chat")}</option>
          {recipients.map(({ id, name, kind }) => <option key={id} value={id}>{name} · {tr(kind)}{tr(" · ID ")}{id}</option>)}
        </select></label>
        {folderAvailable && results === undefined && folder.page?.nextOffset !== null && <button type="button" className="mtg-action" disabled={busy}
          onClick={() => void loadFolder(folder.id, folder.page?.nextOffset ?? 0)}>
          {folder.page ? tr("Load more chats in folder") : busy ? tr("Loading chats in folder…") : tr("Retry loading folder")}
        </button>}
        {forum && !matched && <p role="status">{tr("Loading forum topics…")}</p>}
        {matched?.error && <button type="button" className="mtg-action" onClick={() => {
          setTopicResult(undefined);
          setTopicRetry((value) => value + 1);
        }}>{tr("Retry loading topics")}</button>}
        {topics && <label>{tr("Forward to topic ")}<select value={topicId} disabled={busy || !topics.length}
          onChange={(event) => setTopicId(event.target.value)}>
          <option value="">{topics.length ? tr("Select a Telegram topic") : tr("No topics available")}</option>
          {topics.map(({ id, name }) => <option key={id} value={id}>{name}{tr(" · ID ")}{id}</option>)}
        </select></label>}
        <label className="mtg-link-preview-option">
          <input type="checkbox" checked={hideSender} disabled={busy} onChange={(event) => {
            setHideSender(event.currentTarget.checked);
            if (!event.currentTarget.checked) setRemoveCaption(false);
          }} />{tr(" Hide sender name")}</label>
        {hasCaption && hideSender && <label className="mtg-link-preview-option">
          <input type="checkbox" checked={removeCaption} disabled={busy} onChange={(event) => setRemoveCaption(event.currentTarget.checked)} />{tr(" Remove media caption")}</label>}
        <label>{tr("Comment (optional) ")}<textarea rows={2} maxLength={4096} value={comment} disabled={busy}
          onChange={(event) => setComment(event.currentTarget.value)} /></label>
        <AttachmentDeliveryControls subject="forward" draft={deliveryDraft} disabled={busy} dateDisabled={whenOnline}
          change={(value) => { setDeliveryDraft(value); if (!value.date) setRepeatEvery(undefined); }}>
          {availability?.online && <label className="mtg-link-preview-option"><input type="checkbox" checked={whenOnline} disabled={busy}
            onChange={(event) => {
              const enabled = event.currentTarget.checked;
              setWhenOnline(enabled);
              if (enabled) {
                setRepeatEvery(undefined);
                setDeliveryDraft((draft) => draft ? { ...draft, date: "" } : draft);
              }
            }} />{tr(" Forward when online")}</label>}
          {availability?.repeat && !!deliveryDraft?.date && <label>{tr("Repeat forward")}<select value={repeatEvery ?? ""} disabled={busy} onChange={(event) =>
              setRepeatEvery(scheduleRepeatPeriods.find((seconds) => seconds === Number(event.currentTarget.value)))}>
              <option value="">{tr("Never")}</option>
              {scheduleRepeatPeriods.map((seconds) => <option key={seconds} value={seconds}>{repeatLabel(seconds)}</option>)}
            </select>
          </label>}
        </AttachmentDeliveryControls>
        {canChooseEffect && actions.loadMessageEffects && <MessageEffectPicker key={target.id} chatId={target.id}
          subject="forward" load={actions.loadMessageEffects} selected={effect} choose={setEffect} disabled={busy} />}
      </>}
    </div>
    {allowed && <footer className="mtg-forward-footer">
      <Button type="button" disabled={!ready || busy || delivery === null} onClick={() => void submit()}>
        {comment.trim() ? scheduled ? tr("Schedule forward with comment") : tr("Forward with comment")
          : scheduled ? tr("Schedule forward") : selectionCount ? tr("Forward {0} messages", [selectionCount]) : album ? tr("Forward album") : tr("Forward")}
      </Button>
    </footer>}
  </dialog>, host)}</>;
}
