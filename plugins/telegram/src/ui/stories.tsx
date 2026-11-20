import { useTelegramLocale } from "./i18n/index.tsx";
import { CirclePlay } from "lucide-react";
import { createContext, useContext, useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { canonicalTelegramContentLink } from "../core/telegram-content-link.ts";
import { webLink } from "../core/message-links.ts";
import { OpenTelegramMessageLink, TelegramMessageLink, type FollowTelegramMessageLink } from "./telegram-message-link.tsx";
import { CustomEmojiLoader, InlineCustomEmoji } from "./custom-emoji.tsx";
import { ChatReport } from "./chat-report.tsx";
import { MediaPlayer } from "./media-player.tsx";
import { MessageText } from "./message-text.tsx";
import { CopyTelegramLink, type MessageLinkLoader } from "./copy-telegram-link.tsx";
import { isPlainKey } from "./composer-keys.ts";
import { defaultStoryActivityFilter, reactionKey, storyAlbumName, storyAudience, storyAudienceLabels } from "../core/contract.ts";
import type { StoryActivityFilter, StoryAudience, StoryAlbum, StoryAlbumChange, StoryAlbumChangeResult, ChatReportStep, ChatReportResult, SelectableReaction, ForwardedPost, LinkedStory, LinkedStoryAlbum, ProfileStoryPage, StoryFeed, StoryInteractionPage, StoryList, StoryManagement, StoryOrderResult, StoryReference, StoryStealthTimes, StoryStealthStatus, StoryStealthActivation, StoryView } from "../core/contract.ts";

export type StoryActions = {
  subscribeToDeletions?: (listener: (event: StoryReference) => void) => () => void;
  subscribeToFeedChanges?: (listener: () => void) => () => void;
  subscribeToStealthChanges?: (listener: (times: StoryStealthTimes) => void) => () => void;
  stealthStatus?: () => Promise<StoryStealthStatus>;
  activateStealth?: () => Promise<StoryStealthActivation>;
  reply?: (id: string, story: number, text: string) => Promise<"sent" | "failed" | "unknown">;
  resolveLink?: (url: string) => Promise<LinkedStory | null>;
  link?: MessageLinkLoader;
  interactions?: (id: string, story: number, offset?: string, filter?: StoryActivityFilter) => Promise<StoryInteractionPage>;
  changeAudience?: (id: string, story: number, expected: StoryAudience, audience: StoryAudience) => Promise<"saved" | "changed" | "unavailable">;
  editCaption?: (id: string, story: number, expected: string, caption: string) => Promise<"saved" | "changed" | "unavailable">;
  manage?: (id: string, story: number, action: StoryManagement) => Promise<boolean>;
  ownArchive?: (id: string, before?: number) => Promise<ProfileStoryPage>;
  profile?: (id: string, before?: number) => Promise<ProfileStoryPage>;
  report?: (id: string, story: number, step: ChatReportStep) => Promise<ChatReportResult>;
  music?: (id: string, story: number, fileId: number) => Promise<string>;
  postLink?: (id: string, story: number, post: ForwardedPost) => Promise<string | null>;
  albumLink?: MessageLinkLoader;
  resolveAlbumLink?: (url: string) => Promise<LinkedStoryAlbum | null>;
  albums?: (id: string) => Promise<StoryAlbum[]>;
  albumPage?: (id: string, album: number, offset?: number) => Promise<ProfileStoryPage>;
  profileEditable?: (id: string) => Promise<boolean>;
  setProfileOrder?: (id: string, expected: number[], order: number[]) => Promise<StoryOrderResult>;
  setAlbumOrder?: (id: string, expected: number[], order: number[]) => Promise<StoryOrderResult>;
  setAlbumStoryOrder?: (id: string, album: number, expected: number[], order: number[]) => Promise<StoryOrderResult>;
  albumCandidates?: (id: string, archive: boolean, before?: number) => Promise<ProfileStoryPage>;
  createAlbum?: (id: string, name: string, stories: number[]) => Promise<StoryAlbumChangeResult>;
  changeAlbum?: (id: string, album: StoryAlbum, change: StoryAlbumChange) => Promise<StoryAlbumChangeResult>;
  feed: (list: StoryList, more: boolean) => Promise<StoryFeed>;
  view: (id: string, story: number) => Promise<StoryView>;
  viewing: (id: string, story: number, opened: boolean) => Promise<boolean>;
  reactSuggested?: (id: string, story: number, reaction: SelectableReaction, remove: boolean) => Promise<boolean>;
  react?: (id: string, story: number, emoji: string | null) => Promise<boolean>;
  reactionCatalog?: (id: string, story: number) => Promise<SelectableReaction[]>;
  reactFromCatalog?: (id: string, story: number, reaction: SelectableReaction | null) => Promise<boolean>;
  move?: (id: string, from: StoryList) => Promise<boolean>;
};
type Group = StoryFeed["groups"][number];

function firstUnreadStory(group: Group) {
  return group.stories.find((story) => story.unread) ?? group.stories[0];
}

function storyNavigationDelta(event: KeyboardEvent) {
  if (event.target instanceof HTMLElement && event.target.closest("input, textarea, select, [contenteditable], video, audio, [data-story-report]")) return 0;
  return isPlainKey(event, "ArrowLeft") ? -1 : isPlainKey(event, "ArrowRight") ? 1 : 0;
}

function removeStoryFromFeed(feed: StoryFeed, { id, story }: StoryReference) {
  return { ...feed, groups: feed.groups.flatMap((group) => {
    if (group.id !== id) return [group];
    const stories = group.stories.filter((row) => row.id !== story);
    return stories.length ? [{ ...group, stories }] : [];
  }) };
}

function storyStealthCountdown(seconds: number) {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function storyStealthPeriod(seconds: number) {
  const minutes = seconds % 60 === 0;
  return new Intl.NumberFormat(undefined, { style: "unit", unit: minutes ? "minute" : "second", unitDisplay: "long" })
    .format(minutes ? seconds / 60 : seconds);
}

function StoryStealthPanel({ status, enable, subscribe }: {
  status: NonNullable<StoryActions["stealthStatus"]>;
  enable: NonNullable<StoryActions["activateStealth"]>;
  subscribe: StoryActions["subscribeToStealthChanges"];
}) {
  const { t: tr } = useTelegramLocale();
  const [info, setInfo] = useState<StoryStealthStatus>();
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const [attempt, setAttempt] = useState(0);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [activation, setActivation] = useState<StoryStealthActivation["state"]>();
  const serverChange = useRef<StoryStealthTimes>(undefined);
  const activating = useRef(false);
  const active = Math.max(0, (info?.activeUntil ?? 0) - now);
  const cooldown = Math.max(0, (info?.cooldownUntil ?? 0) - now);

  useEffect(() => {
    let mounted = true;
    const before = serverChange.current;
    const stop = subscribe?.((times) => {
      serverChange.current = times;
      setInfo((current) => current?.premium ? { ...current, ...times } : current);
      const currentTime = Math.floor(Date.now() / 1000);
      if (times.activeUntil > currentTime) setActivation(undefined);
      setNow(currentTime);
    });
    void status().then((value) => {
      if (!mounted) return;
      setInfo(value.premium && serverChange.current !== before ? { ...value, ...serverChange.current } : value);
      setNow(Math.floor(Date.now() / 1000));
    }, () => { if (mounted) setLoadFailed(true); });
    return () => { mounted = false; stop?.(); };
  }, [attempt, status, subscribe]);

  const hasDeadline = active > 0 || cooldown > 0;
  useEffect(() => {
    if (!hasDeadline) return;
    setConfirming(false);
    const timer = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(timer);
  }, [hasDeadline]);

  async function activate() {
    if (!confirming || !info?.premium || active || cooldown || activating.current) return;
    activating.current = true;
    setBusy(true);
    setActivation(undefined);
    const before = serverChange.current;
    try {
      const result = await enable();
      const times = serverChange.current !== before ? serverChange.current : result.times;
      if (times) setInfo((current) => current?.premium ? { ...current, ...times } : current);
      setActivation(times && times.activeUntil > Math.floor(Date.now() / 1000) ? undefined : result.state);
    } catch {
      setActivation("unknown");
    } finally {
      activating.current = false;
      setNow(Math.floor(Date.now() / 1000));
      setConfirming(false);
      setBusy(false);
    }
  }

  function deadline(seconds: number, until: number) {
    const date = new Date(until * 1000);
    return <><time dateTime={date.toISOString()}>{date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>
      {" "}<span aria-hidden="true">({storyStealthCountdown(seconds)})</span></>;
  }

  return <section aria-label={tr("Stealth mode for stories")}>
    {!info && !loadFailed && <p role="status">{tr("Checking stealth mode…")}</p>}
    {loadFailed && <div className="mtg-story-actions">
      <p role="alert">{tr("Could not read Telegram’s stealth mode.")}</p>
      <button type="button" className="mtg-action" onClick={() => { setLoadFailed(false); setAttempt((value) => value + 1); }}>{tr("Retry")}</button>
    </div>}
    {info && !info.premium && <p>{tr("Stealth mode requires Telegram Premium.")}</p>}
    {info?.premium && <>
      {active > 0 && <p>{tr("Stealth mode is active until ")}{deadline(active, info.activeUntil)}.</p>}
      {cooldown > 0 && <p>{tr("Available again at ")}{deadline(cooldown, info.cooldownUntil)}.</p>}
      {!hasDeadline && !confirming && <button type="button" className="mtg-action" onClick={() => {
        setActivation(undefined);
        setConfirming(true);
      }}>{tr("Enable stealth mode")}</button>}
      {confirming && !hasDeadline && <div className="mtg-story-actions">
        <p>{info.pastSeconds && info.futureSeconds
          ? tr("Telegram will hide views from the last {0} and views for the next {1}.", [storyStealthPeriod(info.pastSeconds), storyStealthPeriod(info.futureSeconds)])
          : tr("Telegram will hide recent story views and upcoming views during stealth mode.")}</p>
        <button type="button" className="mtg-action" disabled={busy}
          onClick={() => void activate()}>{busy ? tr("Enabling…") : tr("Confirm stealth mode")}</button>
        <button type="button" className="mtg-action" disabled={busy} onClick={() => setConfirming(false)}>{tr("Cancel")}</button>
      </div>}
      {!active && activation === "unknown" && <p role="alert">{tr("Telegram hasn’t confirmed stealth mode.")}</p>}
      {!active && !cooldown && activation === "unavailable" && <p role="alert">{tr("Telegram couldn’t enable stealth mode.")}</p>}
    </>}
  </section>;
}

function StoryStealthControl({ actions }: { actions: StoryActions }) {
  const { t: tr } = useTelegramLocale();
  const [open, setOpen] = useState(false);
  if (!actions.stealthStatus || !actions.activateStealth) return null;
  return <>
    <button type="button" className="mtg-action" aria-expanded={open} onClick={() => setOpen((value) => !value)}>{tr("Stealth mode")}</button>
    {open && <StoryStealthPanel status={actions.stealthStatus} enable={actions.activateStealth} subscribe={actions.subscribeToStealthChanges} />}
  </>;
}

export function Stories({ actions }: { actions: StoryActions }) {
  const { t: tr } = useTelegramLocale();
  const dialog = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<StoryList>("main");
  return <>
    <button type="button" aria-haspopup="dialog" onClick={() => { dialog.current?.showModal(); setOpen(true); }}>
      <CirclePlay size={20} aria-hidden="true" />{tr(" Stories")}</button>
    <dialog ref={dialog} className="mtg-agent-settings mtg-chat-details mtg-stories" aria-label={tr("Telegram stories")} onClose={() => setOpen(false)}>
      <h2>{tr("Telegram stories")}</h2>
      <div className="mtg-story-actions">
        <button type="button" className="mtg-action" aria-pressed={list === "main"} onClick={() => setList("main")}>{tr("Active")}</button>
        <button type="button" className="mtg-action" aria-pressed={list === "archive"} onClick={() => setList("archive")}>{tr("Archived")}</button>
        <button type="button" className="mtg-action" onClick={() => { setOpen(false); dialog.current?.close(); }}>{tr("Close stories")}</button>
      </div>
      {open && <StoryStealthControl actions={actions} />}
      {open && <StoryListView key={list} list={list} actions={actions} />}
    </dialog>
  </>;
}

export const OpenMessageStory = createContext<((target: { id: string; story: number }) => void) | undefined>(undefined);

export function MessageStoryDialog({ target, actions, close }: {
  target: { id: string; story: number }; actions: StoryActions; close: () => void;
}) {
  const { t: tr } = useTelegramLocale();
  const dialog = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => { dialog.current?.showModal(); }, []);
  return <dialog ref={dialog} className="mtg-agent-settings mtg-chat-details mtg-stories" aria-label={tr("Story from message")} onClose={close}>
    <h2>{tr("Telegram story")}</h2>
    <button type="button" className="mtg-action" onClick={() => { dialog.current?.close(); close(); }}>{tr("Close story")}</button>
    <StoryStealthControl actions={actions} />
    <StoryPlayer key={`${target.id}:${target.story}`} id={target.id} story={target.story} actions={actions} managed={(action) => { if (action === "delete") close(); }} />
  </dialog>;
}

export function LinkedStoryPreview({ target, actions }: { target: LinkedStory; actions: StoryActions }) {
  const { t: tr } = useTelegramLocale();
  const dialog = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);
  function close() {
    setOpen(false);
    dialog.current?.close();
  }
  return <>
    <button type="button" className="mtg-action" aria-haspopup="dialog" onClick={() => {
      dialog.current?.showModal();
      setOpen(true);
    }}>{tr("Open story by ")}<bdi>{target.title}</bdi></button>
    <dialog ref={dialog} className="mtg-agent-settings mtg-chat-details mtg-stories" aria-label={tr("Linked Telegram story")}
      onClose={() => setOpen(false)}>
      <h2><bdi>{target.title}</bdi></h2>
      <button type="button" className="mtg-action" onClick={close}>{tr("Close story")}</button>
      {open && <StoryStealthControl actions={actions} />}
      {open && <StoryPlayer key={`${target.id}:${target.story}`} id={target.id} story={target.story} actions={actions}
        managed={(action) => { if (action === "delete") close(); }} />}
    </dialog>
  </>;
}

function StoryListView({ list, actions }: { list: StoryList; actions: StoryActions }) {
  const { t: tr } = useTelegramLocale();
  const [feed, setFeed] = useState<StoryFeed>();
  const loadMore = useRef<() => void>(undefined);
  const [selected, setSelected] = useState<StoryReference>();
  const viewer = useRef<HTMLElement>(null);
  const authorButtons = useRef(new Map<string, HTMLButtonElement>());
  const lastAuthor = useRef<string>(undefined);
  const authors = useRef<HTMLUListElement>(null);
  const empty = useRef<HTMLParagraphElement>(null);
  const [busy, setBusy] = useState(false);
  const [moving, setMoving] = useState(false);
  const [moveFailed, setMoveFailed] = useState(false);
  const [failed, setFailed] = useState(false);
  const deleted = useRef(new Map<string, StoryReference>());
  const readThrough = useRef(new Map<string, number>());
  const groups = feed?.groups ?? [];
  const authorIndex = selected ? groups.findIndex(({ id }) => id === selected.id) : -1;
  const group = groups[authorIndex];
  const index = group?.stories.findIndex(({ id }) => id === selected?.story) ?? -1;
  const story = group?.stories[index];
  const viewingStory = story !== undefined;

  function markRead(snapshot: StoryFeed) {
    return { ...snapshot, groups: snapshot.groups.map((group) => {
      const latest = readThrough.current.get(group.id);
      return latest === undefined ? group : { ...group, stories: group.stories.map((story) =>
        story.id <= latest ? { ...story, unread: false } : story) };
    }) };
  }

  function remove(target: StoryReference) {
    deleted.current.set(`${target.id}:${target.story}`, target);
    setFeed((current) => current && removeStoryFromFeed(current, target));
    setSelected((current) => current?.id === target.id && current.story === target.story ? undefined : current);
  }

  useEffect(() => actions.subscribeToDeletions?.(remove), [actions]);
  useLayoutEffect(() => {
    if (viewingStory) {
      viewer.current?.focus({ preventScroll: true });
    } else if (lastAuthor.current !== undefined) {
      const button = authorButtons.current.get(lastAuthor.current);
      (button ?? authors.current ?? empty.current)?.focus({ preventScroll: true });
      lastAuthor.current = undefined;
    }
  }, [viewingStory]);

  useEffect(() => {
    let active = true;
    let running = false;
    let pagePending = false;
    let refreshPending = false;
    let hasSnapshot = false;

    async function synchronize() {
      if (running) return;
      running = true;
      while (active && (pagePending || refreshPending)) {
        const more = pagePending;
        pagePending = refreshPending = false;
        try {
          const value = await actions.feed(list, more);
          if (!active || refreshPending) continue;
          const next = [...deleted.current.values()].reduce(removeStoryFromFeed, markRead(value));
          if (!hasSnapshot) setFailed(false);
          hasSnapshot = true;
          setFeed(next);
          setSelected((current) => current && next.groups.some((group) => group.id === current.id
            && group.stories.some((story) => story.id === current.story)) ? current : undefined);
        } catch {
          if (active && (more || !hasSnapshot)) setFailed(true);
        } finally {
          if (active && more && !pagePending) setBusy(false);
        }
      }
      running = false;
    }

    const stop = actions.subscribeToFeedChanges?.(() => {
      refreshPending = true;
      void synchronize();
    });
    loadMore.current = () => {
      pagePending = true;
      setBusy(true);
      setFailed(false);
      void synchronize();
    };
    loadMore.current();
    return () => {
      active = false;
      loadMore.current = undefined;
      stop?.();
    };
  }, [actions, list]);

  async function moveAuthor(id: string) {
    if (!actions.move || busy || moving) return;
    setMoving(true);
    setMoveFailed(false);
    try {
      if (!await actions.move(id, list)) throw new Error("Story list did not change.");
      setFeed((current) => current && { ...current, groups: current.groups.filter((group) => group.id !== id) });
    } catch {
      setMoveFailed(true);
    } finally {
      setMoving(false);
    }
  }

  function navigate(id: string, story: number) {
    lastAuthor.current = id;
    const section = viewer.current;
    if (section?.contains(section.ownerDocument.activeElement)) section.focus({ preventScroll: true });
    setSelected({ id, story });
  }

  if (group && story) {
    const previousAuthor = groups[authorIndex - 1];
    const nextAuthor = groups[authorIndex + 1];
    const previous = group.stories[index - 1];
    const next = group.stories[index + 1];
    const previousId = previous?.id ?? previousAuthor?.stories.at(-1)?.id;
    const nextId = next?.id ?? (nextAuthor && firstUnreadStory(nextAuthor)?.id);
    const goPrevious = previousId === undefined ? undefined : () => navigate(previous ? group.id : previousAuthor!.id, previousId);
    const goNext = nextId === undefined ? undefined : () => navigate(next ? group.id : nextAuthor!.id, nextId);
    return <section ref={viewer} aria-label={tr("Story viewer")} tabIndex={0} aria-keyshortcuts="ArrowLeft ArrowRight" onKeyDown={(event) => {
      const delta = storyNavigationDelta(event);
      const move = delta === -1 ? goPrevious : delta === 1 ? goNext : undefined;
      if (!move) return;
      event.preventDefault();
      event.stopPropagation();
      move();
    }}>
      <div aria-live="polite">
        <h3><bdi>{group.title}</bdi></h3>
        <span>{index + 1} / {group.stories.length}</span>
      </div>
      <div className="mtg-story-actions">
        <button type="button" className="mtg-action" onClick={() => setSelected(undefined)}>{tr("Back to stories")}</button>
        <button type="button" className="mtg-action" disabled={!goPrevious} onClick={goPrevious}>{tr("Previous story")}</button>
        <button type="button" className="mtg-action" disabled={!goNext} onClick={goNext}>{tr("Next story")}</button>
        {!goNext && (feed?.more || failed) && <button type="button" className="mtg-action" disabled={busy} onClick={() => {
          viewer.current?.focus({ preventScroll: true });
          loadMore.current?.();
        }}>{failed ? tr("Retry loading stories") : tr("Load more stories")}</button>}
      </div>
      {busy && <p role="status">{tr("Loading stories…")}</p>}
      {failed && <p role="alert">{tr("Could not load Telegram stories.")}</p>}
      <StoryPlayer key={`${group.id}:${story.id}`} actions={actions} id={group.id} story={story.id}
        next={goNext}
        managed={(action) => {
          if (action !== "delete") return;
          remove({ id: group.id, story: story.id });
        }}
        viewed={() => {
          readThrough.current.set(group.id, Math.max(story.id, readThrough.current.get(group.id) ?? 0));
          setFeed((current) => current && markRead(current));
        }} />
    </section>;
  }
  return <>
    {busy && <p role="status">{tr("Loading stories…")}</p>}
    {failed && <p role="alert">{tr("Could not load Telegram stories.")}</p>}
    {moveFailed && <p role="alert">{tr("Could not move this author’s stories.")}</p>}
    {!busy && !failed && !groups.length && <p ref={empty} tabIndex={-1}>{tr("No stories in this list.")}</p>}
    {!!groups.length && <ul ref={authors} aria-label={tr("Story authors")} tabIndex={-1}>{groups.map((group) => {
      const story = firstUnreadStory(group);
      return <li key={group.id}>
        <button type="button" className="mtg-action" ref={(element) => {
          if (element) authorButtons.current.set(group.id, element);
          else authorButtons.current.delete(group.id);
        }} disabled={!story} onClick={() => { if (story) navigate(group.id, story.id); }}>
          <bdi>{group.title}</bdi> · {group.stories.length} {group.stories.length === 1 ? tr("story") : tr("stories")}{story?.unread && tr(" · Unread")}
        </button>
        {actions.move && (list === "archive" || group.canArchive) && <button type="button" className="mtg-action"
          disabled={busy || moving} aria-label={list === "main" ? tr("Archive stories from {0}", [group.title]) : tr("Restore stories from {0}", [group.title])}
          onClick={() => void moveAuthor(group.id)}>{list === "main" ? tr("Archive") : tr("Restore")}</button>}
      </li>;
    })}</ul>}
    {(feed?.more || failed) && <button type="button" className="mtg-action" disabled={busy || moving}
      onClick={() => loadMore.current?.()}>{failed ? tr("Retry loading stories") : tr("Load more stories")}</button>}
  </>;
}

export function StoryAlbumDialog({ target, actions, close }: { target: LinkedStoryAlbum; actions: StoryActions; close: () => void }) {
  const { t: tr } = useTelegramLocale();
  const dialog = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => { dialog.current?.showModal(); }, []);
  return <dialog ref={dialog} className="mtg-agent-settings mtg-chat-details mtg-stories" aria-label={tr("Telegram story album")} onClose={close}>
    <h2><bdi>{target.album.title}</bdi></h2>
    <button type="button" className="mtg-action" onClick={() => dialog.current?.close()}>{tr("Close story album")}</button>
    {actions.albumLink && <CopyTelegramLink chatId={target.chatId} messageId={String(target.album.id)} load={actions.albumLink} kind="story album" />}
    <ProfileStories id={target.chatId} actions={actions} album={target.album} />
  </dialog>;
}

function MoveStoryEntry({ label, order, id, pending, save }: {
  label: string;
  order: number[];
  id: number;
  pending: boolean;
  save: (order: number[]) => void;
}) {
  const { t: tr } = useTelegramLocale();
  const index = order.indexOf(id);
  if (index < 0 || order.length < 2) return null;
  return <>{([-1, 1] as const).map((step) => {
    const direction = step < 0 ? "up" : "down";
    const neighbor = index + step;
    return <button key={step} className="mtg-action" type="button" aria-label={tr("Move {0} {1}", [label, direction])}
      disabled={pending || neighbor < 0 || neighbor >= order.length}
      onClick={() => {
        const next = [...order];
        next[index] = order[neighbor]!;
        next[neighbor] = id;
        save(next);
      }}>{tr("Move ")}{direction}</button>;
  })}</>;
}

const orderChanged = "The story order changed in Telegram. Review the updated list.";
const orderUnavailable = "Could not update the story order.";
const albumChanged = "The album changed in Telegram. Review the refreshed album.";
const albumUnavailable = "Could not update the story album.";

function AlbumEditor({ mode, title, load, saving, cancel, submit }: {
  mode: "create" | "rename" | "add";
  title: string;
  load?: (archive: boolean, before?: number) => Promise<ProfileStoryPage>;
  saving: boolean;
  cancel: () => void;
  submit: (name: string, stories: number[]) => void;
}) {
  const { locale: uiLocale, t: tr } = useTelegramLocale();
  const [name, setName] = useState(title);
  const [stories, setStories] = useState<number[]>([]);
  const [archive, setArchive] = useState(false);
  const [page, setPage] = useState<ProfileStoryPage>();
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const valid = storyAlbumName.safeParse(name);
  const canSubmit = mode === "add" ? stories.length > 0 : valid.success && (mode === "create" || valid.data !== title);

  async function fetchPage(nextArchive: boolean, before?: number) {
    if (!load || pending) return;
    setPending(true);
    setFailed(false);
    setArchive(nextArchive);
    if (!before) setPage(undefined);
    try {
      const incoming = await load(nextArchive, before);
      setPage((current) => !before || !current ? incoming : { ...incoming,
        stories: [...current.stories, ...incoming.stories.filter(({ id }) => !current.stories.some((row) => row.id === id))],
      });
    } catch { setFailed(true); }
    finally { setPending(false); }
  }

  return <form onSubmit={(event) => {
    event.preventDefault();
    if (!saving && !pending && canSubmit) submit(valid.data ?? "", stories);
  }}>
    {mode !== "add" && <label>{tr("Story album name ")}<input value={name} required maxLength={24} disabled={saving}
      aria-invalid={name.trim().length > 0 && !valid.success || undefined}
      onChange={(event) => setName(event.currentTarget.value)} /></label>}
    {mode !== "add" && [...name.trim()].length > 12 && <p role="alert">{tr("Use up to 12 characters for the album name.")}</p>}
    {mode !== "rename" && load && <fieldset disabled={saving || pending}>
      <legend>{tr("Select existing stories")}</legend>
      <div className="mtg-story-actions">
        <button type="button" className="mtg-action" aria-pressed={!!page && !archive}
          onClick={() => void fetchPage(false)}>{tr("Published stories")}</button>
        <button type="button" className="mtg-action" aria-pressed={!!page && archive}
          onClick={() => void fetchPage(true)}>{tr("Archived stories")}</button>
      </div>
      {stories.length > 0 && <p>{stories.length}{tr(" selected")}</p>}
      {pending && <p role="status">{tr("Loading stories…")}</p>}
      {failed && <p role="alert">{tr("Could not load stories for the album.")}</p>}
      {page?.stories.length === 0 && <p>{tr("No stories in this list.")}</p>}
      {!!page?.stories.length && <ul aria-label={tr("Stories for the album")}>{page.stories.map((story) => <li key={story.id}>
        <label><input type="checkbox" checked={stories.includes(story.id)}
          disabled={stories.length >= 100 && !stories.includes(story.id)} onChange={(event) => {
            setStories(event.currentTarget.checked ? [...stories, story.id] : stories.filter((id) => id !== story.id));
          }} /> {new Date(story.date * 1000).toLocaleString(uiLocale)}</label>
      </li>)}</ul>}
      {page?.before && <button type="button" className="mtg-action"
        onClick={() => void fetchPage(archive, page.before!)}>{tr("Load earlier stories for album")}</button>}
    </fieldset>}
    <div className="mtg-story-actions">
      <button className="mtg-action" type="submit" disabled={saving || pending || !canSubmit}>
        {mode === "create" ? tr("Create album") : mode === "rename" ? tr("Save album name") : tr("Add selected stories")}
      </button>
      <button className="mtg-action" type="button" disabled={saving} onClick={cancel}>{tr("Cancel")}</button>
    </div>
  </form>;
}

export function ProfileStoryAlbums({ id, actions }: { id: string; actions: StoryActions }) {
  const { t: tr } = useTelegramLocale();
  const [albums, setAlbums] = useState<StoryAlbum[]>();
  const [selected, setSelected] = useState<StoryAlbum>();
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const [editable, setEditable] = useState(false);
  const [saving, setSaving] = useState(false);
  const [orderError, setOrderError] = useState("");
  const [editor, setEditor] = useState<"create" | "rename" | "add" | "delete">();
  const [albumVersion, setAlbumVersion] = useState(0);
  if (!actions.albums || !actions.albumPage) return null;
  const order = albums?.map((album) => album.id) ?? [];

  async function reorder(next: number[]) {
    if (!albums || !actions.setAlbumOrder || !actions.albums || saving) return;
    setSaving(true);
    setOrderError("");
    try {
      const result = await actions.setAlbumOrder(id, order, next);
      if (result === "saved") setAlbums(next.flatMap((id) => albums.find((item) => item.id === id) ?? []));
      else if (result === "changed") {
        setAlbums(await actions.albums(id));
        setOrderError(orderChanged);
      } else setOrderError(orderUnavailable);
    } catch { setOrderError(orderUnavailable); }
    finally { setSaving(false); }
  }

  async function saveAlbum(change: () => Promise<StoryAlbumChangeResult>) {
    if (!actions.albums || saving) return;
    setSaving(true);
    setOrderError("");
    try {
      const result = await change();
      if (result === "saved" || result === "changed") {
        const rows = await actions.albums(id);
        setAlbums(rows);
        setSelected((current) => current && rows.find((row) => row.id === current.id));
        setAlbumVersion((version) => version + 1);
        setEditor(undefined);
        if (result === "changed") setOrderError(albumChanged);
      } else setOrderError(result === "full" ? "The selected stories exceed Telegram’s album limit." : albumUnavailable);
    } catch { setOrderError(albumUnavailable); }
    finally { setSaving(false); }
  }

  return <section aria-label={tr("Story albums")}>
    {!albums && <button className="mtg-action" type="button" disabled={pending} onClick={async () => {
      setPending(true);
      setFailed(false);
      try {
        const [albums, editable] = await Promise.all([actions.albums!(id), actions.profileEditable?.(id).catch(() => false)]);
        setAlbums(albums);
        setEditable(editable === true);
      }
      catch { setFailed(true); }
      finally { setPending(false); }
    }}>{failed ? tr("Retry story albums") : tr("Show story albums")}</button>}
    {pending && <p role="status">{tr("Loading story albums…")}</p>}
    {failed && <p role="alert">{tr("Could not load story albums.")}</p>}
    {orderError && <p role="alert">{tr(orderError)}</p>}
    {albums?.length === 0 && <p>{tr("No story albums.")}</p>}
    {albums && !selected && !editor && editable && actions.createAlbum && <button type="button" className="mtg-action"
      disabled={saving} onClick={() => { setEditor("create"); setOrderError(""); }}>{tr("New story album")}</button>}
    {editor && editor !== "delete" && <AlbumEditor key={editor} mode={editor} title={editor === "rename" ? selected?.title ?? "" : ""}
      saving={saving} load={actions.albumCandidates && ((archive, before) => actions.albumCandidates!(id, archive, before))}
      cancel={() => setEditor(undefined)} submit={(name, stories) => {
        if (editor === "create" && actions.createAlbum) void saveAlbum(() => actions.createAlbum!(id, name, stories));
        if (selected && actions.changeAlbum && editor !== "create") void saveAlbum(() =>
          actions.changeAlbum!(id, selected, editor === "rename" ? { kind: "rename", name } : { kind: "add", stories }));
      }} />}
    {albums && !selected && <ul aria-label={tr("Available story albums")}>
      {albums.map((album) => <li key={album.id} className="mtg-story-actions">
        <button className="mtg-action" type="button" disabled={!!editor || saving} onClick={() => setSelected(album)}><bdi>{album.title}</bdi></button>
        {editable && actions.setAlbumOrder && <MoveStoryEntry label={album.title} order={order} id={album.id}
          pending={saving || !!editor} save={(next) => void reorder(next)} />}
      </li>)}
    </ul>}
    {selected && <>
      <button className="mtg-action" type="button" disabled={saving} onClick={() => { setSelected(undefined); setEditor(undefined); }}>{tr("Back to story albums")}</button>
      {editable && actions.changeAlbum && !editor && <div className="mtg-story-actions">
        <button type="button" className="mtg-action" onClick={() => setEditor("rename")}>{tr("Rename story album")}</button>
        {actions.albumCandidates && <button type="button" className="mtg-action" onClick={() => setEditor("add")}>{tr("Add stories to album")}</button>}
        <button type="button" className="mtg-action" onClick={() => { setOrderError(""); setEditor("delete"); }}>{tr("Delete story album")}</button>
      </div>}
      {editor === "delete" && <div className="mtg-story-actions">
        <p>{tr("Delete the album “")}{selected.title}{tr("”? Its stories will stay in Telegram.")}</p>
        <button type="button" className="mtg-action" disabled={saving}
          onClick={() => void saveAlbum(() => actions.changeAlbum!(id, selected, { kind: "delete" }))}>{tr("Confirm album deletion")}</button>
        <button type="button" className="mtg-action" disabled={saving} onClick={() => setEditor(undefined)}>{tr("Cancel")}</button>
      </div>}
      {actions.albumLink && <CopyTelegramLink key={`copy-telegram-link:${selected.id}`} chatId={id} messageId={String(selected.id)} load={actions.albumLink} kind="story album" />}
      <ProfileStories key={`profile-stories:${selected.id}:${albumVersion}`} id={id} actions={actions} album={selected}
        managementDisabled={saving || !!editor} />
    </>}
  </section>;
}

export function ProfileStories({ id, actions, archive = false, album, managementDisabled = false }: {
  id: string; actions: StoryActions; archive?: boolean; album?: StoryAlbum; managementDisabled?: boolean;
}) {
  const { locale: uiLocale, t: tr } = useTelegramLocale();
  const [page, setPage] = useState<ProfileStoryPage>();
  const [selected, setSelected] = useState<number>();
  const viewer = useRef<HTMLElement>(null);
  const viewingStory = selected !== undefined;
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const [editable, setEditable] = useState(false);
  const [saving, setSaving] = useState(false);
  const [orderError, setOrderError] = useState("");
  const [removeStory, setRemoveStory] = useState<number>();
  const deleted = useRef(new Set<number>());
  useEffect(() => actions.subscribeToDeletions?.((target) => {
    if (target.id !== id) return;
    deleted.current.add(target.story);
    setPage((current) => current && { ...current, stories: current.stories.filter((row) => row.id !== target.story) });
    setSelected((current) => current === target.story ? undefined : current);
  }), [actions, id]);
  useLayoutEffect(() => { if (viewingStory) viewer.current?.focus(); }, [viewingStory]);
  const fetchPage = album && actions.albumPage
    ? (chat: string, offset?: number) => actions.albumPage!(chat, album.id, offset)
    : archive ? actions.ownArchive : actions.profile;
  const section = album?.title ?? (archive ? "My story archive" : "Profile stories");
  const albumStarted = useRef(false);
  useEffect(() => {
    if (album && !albumStarted.current) {
      albumStarted.current = true;
      void load();
    }
  }, [album]);
  if (!fetchPage) return null;

  async function load(before?: number) {
    if (pending || !fetchPage) return;
    setPending(true);
    setFailed(false);
    try {
      const [incoming, mayEdit] = await Promise.all([fetchPage(id, before),
        !archive && !before ? actions.profileEditable?.(id).catch(() => false) : undefined]);
      if (!before) setEditable(mayEdit === true);
      const next = { ...incoming, stories: incoming.stories.filter((row) => !deleted.current.has(row.id)) };
      setPage((previous) => {
        if (!before || !previous) return next;
        const seen = new Set(previous.stories.map((story) => story.id));
        return { ...next, pinnedOrder: previous.pinnedOrder, stories: [...previous.stories, ...next.stories.filter((story) => !seen.has(story.id))] };
      });
    } catch {
      setFailed(true);
    } finally {
      setPending(false);
    }
  }

  const albumOrder = album ? page?.stories.map((item) => item.id) : undefined;
  const pinnedOrder = album || archive ? undefined : page?.pinnedOrder;
  const currentOrder = albumOrder ?? pinnedOrder;
  const canSaveOrder = editable && currentOrder && currentOrder.length <= 100
    && !managementDisabled && (album ? !!actions.setAlbumStoryOrder : !!actions.setProfileOrder);

  async function saveOrder(order: number[]) {
    if (!canSaveOrder || !currentOrder || saving || pending) return;
    setSaving(true);
    setOrderError("");
    try {
      const result = album
        ? await actions.setAlbumStoryOrder!(id, album.id, currentOrder, order)
        : await actions.setProfileOrder!(id, currentOrder, order);
      if (result === "saved" && album) {
        setPage((current) => current && { ...current, stories: order.flatMap((id) =>
          current.stories.find((item) => item.id === id) ?? []) });
      } else if (result === "saved" || result === "changed") {
        await load();
        if (result === "changed") setOrderError(orderChanged);
      } else setOrderError(orderUnavailable);
    } catch { setOrderError(orderUnavailable); }
    finally { setSaving(false); }
  }

  async function removeFromAlbum(story: number) {
    if (!album || !editable || !actions.changeAlbum || saving || pending || managementDisabled) return;
    setSaving(true);
    setOrderError("");
    try {
      const result = await actions.changeAlbum(id, album, { kind: "remove", story });
      if (result === "saved" || result === "changed") {
        await load();
        setRemoveStory(undefined);
        if (result === "changed") setOrderError(albumChanged);
      } else setOrderError(albumUnavailable);
    } catch { setOrderError(albumUnavailable); }
    finally { setSaving(false); }
  }

  if (selected !== undefined && page) {
    const index = page.stories.findIndex(({ id }) => id === selected);
    const previous = page.stories[index - 1]?.id;
    const next = index >= 0 ? page.stories[index + 1]?.id : undefined;
    return <section ref={viewer} aria-label={section} tabIndex={0} aria-keyshortcuts="ArrowLeft ArrowRight" onKeyDown={(event) => {
      const delta = storyNavigationDelta(event);
      const target = delta === -1 ? previous : delta === 1 ? next : undefined;
      if (target === undefined) return;
      event.preventDefault();
      event.stopPropagation();
      setSelected(target);
    }}>
      <div className="mtg-story-actions">
        <button type="button" className="mtg-action" onClick={() => setSelected(undefined)}>{album ? tr("Back to album stories") : archive ? tr("Back to my story archive") : tr("Back to profile stories")}</button>
        <button type="button" className="mtg-action" disabled={previous === undefined} onClick={() => setSelected(previous)}>{tr("Previous story")}</button>
        <button type="button" className="mtg-action" disabled={next === undefined} onClick={() => setSelected(next)}>{tr("Next story")}</button>
        {next === undefined && page.before && <button type="button" className="mtg-action" disabled={pending}
          onClick={() => void load(page.before!)}>{album ? tr("Load more album stories") : archive ? tr("Load earlier archived stories") : tr("Load earlier profile stories")}</button>}
      </div>
      {pending && <p role="status">{tr("Loading stories…")}</p>}
      {failed && <p role="alert">{tr("Could not load earlier stories.")}</p>}
      <StoryPlayer key={selected} id={id} story={selected} actions={actions} managed={(action) => {
        if (archive || album ? action !== "delete" : action === "showOnProfile") return;
        setPage((current) => current && { ...current, stories: current.stories.filter((item) => item.id !== selected) });
        setSelected((current) => current === selected ? undefined : current);
      }} />
    </section>;
  }

  return <section aria-label={section}>
    {!page && <button type="button" className="mtg-action" disabled={pending} onClick={() => void load()}>
      {failed ? tr("Retry loading {0}", [section.toLowerCase()]) : album ? tr("Show album stories") : archive ? tr("Show my story archive") : tr("Show profile stories")}
    </button>}
    {pending && <p role="status">{tr("Loading ")}{section.toLowerCase()}…</p>}
    {failed && <p role="alert">{tr("Could not load ")}{section.toLowerCase()}.</p>}
    {orderError && <p role="alert">{tr(orderError)}</p>}
    {page && !page.stories.length && <p>{album ? tr("No stories in this album.") : archive ? tr("No stories in your archive.") : tr("No published profile stories.")}</p>}
    {!!page?.stories.length && <ul aria-label={album ? tr("Album stories") : archive ? tr("Archived stories") : tr("Published stories")}>{page.stories.map((story) => <li key={story.id} className="mtg-story-actions">
      <button type="button" className="mtg-action" onClick={() => setSelected(story.id)}>
        {story.pinned ? tr("Pinned story") : tr("Story")} · {new Date(story.date * 1000).toLocaleString(uiLocale)}
      </button>
      {canSaveOrder && currentOrder && <>
        {pinnedOrder && <button className="mtg-action" type="button" disabled={saving || pending}
          aria-label={tr("{0} story from {1}", [pinnedOrder.includes(story.id) ? "Unpin" : "Pin", new Date(story.date * 1000).toLocaleString(uiLocale)])}
          onClick={() => void saveOrder(pinnedOrder.includes(story.id)
            ? pinnedOrder.filter((id) => id !== story.id) : [story.id, ...pinnedOrder])}>
          {pinnedOrder.includes(story.id) ? tr("Unpin from top") : tr("Pin to top")}
        </button>}
        <MoveStoryEntry label={tr("story from {0}", [new Date(story.date * 1000).toLocaleString(uiLocale)])}
          order={currentOrder} id={story.id} pending={saving || pending} save={(next) => void saveOrder(next)} />
      </>}
      {album && editable && actions.changeAlbum && !managementDisabled && (removeStory === story.id ? <>
        <button type="button" className="mtg-action" disabled={saving || pending}
          onClick={() => void removeFromAlbum(story.id)}>{tr("Confirm remove from album")}</button>
        <button type="button" className="mtg-action" disabled={saving} onClick={() => setRemoveStory(undefined)}>{tr("Cancel")}</button>
      </> : <button type="button" className="mtg-action" disabled={saving || pending}
        aria-label={tr("Remove story dated {0} from album", [new Date(story.date * 1000).toLocaleString(uiLocale)])}
        onClick={() => setRemoveStory(story.id)}>{tr("Remove from album")}</button>)}
    </li>)}</ul>}
    {page?.before && <button type="button" className="mtg-action" disabled={pending || saving}
      onClick={() => void load(page.before!)}>{album ? tr("Load more album stories") : archive ? tr("Load earlier archived stories") : tr("Load earlier profile stories")}</button>}
  </section>;
}

function StoryActivity({ load, personal, pause }: {
  load: (offset?: string, filter?: StoryActivityFilter) => Promise<StoryInteractionPage>;
  personal: boolean;
  pause: () => void;
}) {
  const { locale: uiLocale, t: tr } = useTelegramLocale();
  const loadEmoji = useContext(CustomEmojiLoader);
  const [opened, setOpened] = useState(false);
  const [page, setPage] = useState<StoryInteractionPage>();
  const [draft, setDraft] = useState(defaultStoryActivityFilter);
  const [applied, setApplied] = useState(defaultStoryActivityFilter);
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const request = useRef(false);

  async function fetchPage(offset?: string, filter?: StoryActivityFilter) {
    if (request.current) return;
    request.current = true;
    setOpened(true);
    if (!offset) {
      setPage(undefined);
      setApplied(filter ?? defaultStoryActivityFilter);
    }
    setPending(true);
    setFailed(false);
    try {
      const next = await load(offset, filter);
      setPage((current) => {
        if (!offset || !current) return next;
        const existing = new Set(current.rows.map(({ key }) => key));
        return { ...next, rows: [...current.rows, ...next.rows.filter(({ key }) => !existing.has(key))] };
      });
    } catch {
      setFailed(true);
    } finally {
      request.current = false;
      setPending(false);
    }
  }

  return <section aria-label={tr("Story activity")}>
    {!opened ? <button type="button" className="mtg-action"
      onClick={() => { pause(); void fetchPage(); }}>{tr("Show story activity")}</button>
      : <form className="mtg-story-actions" onSubmit={(event) => {
        event.preventDefault();
        void fetchPage(undefined, { ...draft, query: draft.query.trim() });
      }}>
        {personal && <>
          <label>{tr("Search story activity ")}<input type="search" value={draft.query} maxLength={128} disabled={pending}
            onChange={(event) => setDraft({ ...draft, query: event.currentTarget.value })} /></label>
          <label><input type="checkbox" checked={draft.contactsOnly} disabled={pending}
            onChange={(event) => setDraft({ ...draft, contactsOnly: event.currentTarget.checked })} />{tr(" Contacts only")}</label>
        </>}
        <label>{tr("Story activity order ")}<select value={draft.order} disabled={pending} onChange={(event) => {
          const order = event.currentTarget.value;
          if (order === "recent" || order === "forwards" || (personal && order === "reactions")) setDraft({ ...draft, order });
        }}>
          <option value="recent">{tr("Newest first")}</option>
          {personal && <option value="reactions">{tr("Reactions first")}</option>}
          <option value="forwards">{tr("Forwards first")}</option>
        </select></label>
        <button type="submit" className="mtg-action" disabled={pending}>{failed && !page ? tr("Retry story activity") : tr("Apply activity filters")}</button>
      </form>}
    {pending && <p role="status">{tr("Loading story activity…")}</p>}
    {failed && <p role="alert">{tr("Could not load story activity.")}</p>}
    {page && !page.rows.length && !pending && !page.next && <p>{tr("No story activity available.")}</p>}
    {!!page?.rows.length && <ul aria-label={tr("Story interactions")}>{page.rows.map(({ key, name, date, kind, emoji, customEmoji }) => <li key={key}>
      <bdi>{name}</bdi> · {{ view: "Viewed", reaction: "Reacted", forward: "Forwarded", repost: "Reposted" }[kind]} {emoji}
      {customEmoji && (loadEmoji ? <InlineCustomEmoji id={customEmoji} label={tr("Custom emoji")} load={loadEmoji} /> : tr("Custom emoji"))}
      {" · "}<time dateTime={new Date(date * 1000).toISOString()}>{new Date(date * 1000).toLocaleString(uiLocale)}</time>
    </li>)}</ul>}
    {page?.next && <button type="button" className="mtg-action" disabled={pending}
      onClick={() => void fetchPage(page.next ?? undefined, applied)}>{tr("Load more story activity")}</button>}
  </section>;
}

function StoryReactionCatalog({ load, choose, current, disabled, pause }: {
  load: () => Promise<SelectableReaction[]>;
  choose: (value: SelectableReaction | null) => void;
  current?: SelectableReaction;
  disabled: boolean;
  pause: () => void;
}) {
  const { t: tr } = useTelegramLocale();
  const loadEmoji = useContext(CustomEmojiLoader);
  const [choices, setChoices] = useState<SelectableReaction[]>();
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);

  async function open() {
    if (pending) return;
    pause();
    setPending(true);
    setFailed(false);
    try { setChoices(await load()); }
    catch { setFailed(true); }
    finally { setPending(false); }
  }

  const selected = current && reactionKey(current);
  return <>
    {choices === undefined ? <button type="button" className="mtg-action" disabled={disabled || pending}
      onClick={() => void open()}>{failed ? tr("Retry story reactions") : tr("More story reactions")}</button>
      : <div className="mtg-story-actions" role="group" aria-label={tr("Available story reactions")}>
        <button type="button" className="mtg-action" onClick={() => setChoices(undefined)}>{tr("Hide story reactions")}</button>
        {!choices.length && <p>{tr("No additional reactions available.")}</p>}
        {choices.map((item, index) => {
          const key = reactionKey(item);
          const chosen = key === selected;
          return <button key={key} type="button" className="mtg-action" aria-pressed={chosen}
            aria-label={item.kind === "emoji" ? tr("React with {0}", [item.emoji]) : tr("React with custom emoji {0}", [index + 1])}
            disabled={disabled} onClick={() => choose(chosen ? null : item)}>
            {item.kind === "emoji" ? item.emoji : loadEmoji ? <InlineCustomEmoji id={item.id} label="✦" load={loadEmoji} /> : "✦"}
          </button>;
        })}
      </div>}
    {pending && <span role="status">{tr("Loading story reactions…")}</span>}
    {failed && <span role="alert">{tr("Could not load story reactions.")}</span>}
  </>;
}

function StoryAudienceEditor({ audience, save }: {
  audience: StoryAudience;
  save: (value: StoryAudience) => Promise<"saved" | "changed" | "unavailable">;
}) {
  const { t: tr } = useTelegramLocale();
  const [target, setTarget] = useState(audience);
  const [status, setStatus] = useState<"pending" | "saved" | "changed" | "unavailable">();

  async function submit() {
    if (status === "pending" || target === audience) return;
    setStatus("pending");
    setStatus(await save(target).catch(() => "unavailable" as const));
  }

  return <form className="mtg-story-actions" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
    <label>{tr("Story audience ")}<select value={target} disabled={status === "pending" || status === "changed"} onChange={(event) => {
      const value = storyAudience.safeParse(event.currentTarget.value);
      if (value.success) setTarget(value.data);
      setStatus(undefined);
    }}>
      {storyAudience.options.map((value) => <option key={value} value={value}>{storyAudienceLabels[value]}</option>)}
    </select></label>
    <button type="submit" className="mtg-action" disabled={target === audience || status === "pending" || status === "changed"}>{tr("Save story audience")}</button>
    {status === "saved" && <span role="status">{tr("Story audience updated.")}</span>}
    {status === "changed" && <span role="alert">{tr("The audience changed in Telegram. Reopen the story before editing.")}</span>}
    {status === "unavailable" && <span role="alert">{tr("Could not change the story audience.")}</span>}
  </form>;
}

function StoryReply({ send, open, setOpen }: {
  send: (text: string) => Promise<"sent" | "failed" | "unknown">;
  open: boolean; setOpen: (open: boolean) => void;
}) {
  const { t: tr } = useTelegramLocale();
  const [text, setText] = useState("");
  const [status, setStatus] = useState<"pending" | "sent" | "failed" | "unknown">();

  async function submit() {
    if (status === "pending" || !text.trim()) return;
    setStatus("pending");
    const result = await send(text.trim()).catch(() => "unknown" as const);
    setStatus(result);
    if (result !== "failed") { setText(""); setOpen(false); }
  }

  return <section aria-label={tr("Story reply")}>
    {!open && <button type="button" className="mtg-action" onClick={() => { setOpen(true); setStatus(undefined); }}>{tr("Reply to story")}</button>}
    {open && <form onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <label>{tr("Reply to story ")}<textarea value={text} maxLength={4096} disabled={status === "pending"}
        onChange={(event) => setText(event.currentTarget.value)} /></label>
      <button type="submit" className="mtg-action" disabled={!text.trim() || status === "pending"}>{tr("Send story reply")}</button>
      <button type="button" className="mtg-action" disabled={status === "pending"} onClick={() => {
        setText(""); setOpen(false); setStatus(undefined);
      }}>{tr("Cancel reply")}</button>
    </form>}
    {status === "sent" && <p role="status">{tr("Reply sent.")}</p>}
    {status === "failed" && <p role="alert">{tr("Telegram could not send this reply.")}</p>}
    {status === "unknown" && <p role="status">{tr("Telegram did not confirm delivery. Check the chat before trying again.")}</p>}
  </section>;
}

function StoryPostArea({ load, open }: {
  load: () => Promise<string | null>;
  open: FollowTelegramMessageLink;
}) {
  const { t: tr } = useTelegramLocale();
  const [status, setStatus] = useState<"loading" | "unavailable">();
  const request = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => request.current?.abort(), []);
  return <>
    <button type="button" className="mtg-story-post-area" disabled={status === "loading"} onClick={async (event) => {
      const viewer = event.currentTarget.closest("dialog");
      const controller = new AbortController();
      request.current = controller;
      setStatus("loading");
      try {
        const url = await load();
        if (controller.signal.aborted) return;
        const opened = url && await open(url, controller.signal);
        if (!controller.signal.aborted) {
          if (opened && viewer?.open) viewer.close();
          else setStatus(opened ? undefined : "unavailable");
        }
      } catch {
        if (!controller.signal.aborted) setStatus("unavailable");
      }
    }}><span className="mtg-story-link-label">{tr("Open linked post")}</span></button>
    {status === "unavailable" && <span className="mtg-story-link-label" role="status">{tr("Post unavailable")}</span>}
  </>;
}

const storyTemperature = new Intl.NumberFormat(undefined, { style: "unit", unit: "celsius", maximumFractionDigits: 1 });

function weatherColors(argb: number | undefined) {
  if (argb === undefined) return;
  const red = (argb >>> 16) & 255;
  const green = (argb >>> 8) & 255;
  const blue = argb & 255;
  const alpha = (argb >>> 24) / 255;
  const brightness = 0.299 * red + 0.587 * green + 0.114 * blue;
  return {
    backgroundColor: `rgba(${red}, ${green}, ${blue}, ${alpha})`,
    color: alpha >= 0.85 && brightness >= 150 ? "#101827" : "#fff",
    textShadow: alpha < 0.85 ? "0 1px 3px #000, 0 0 4px #000" : undefined,
  };
}

function StoryAreas({ links, resolvePost, onReaction, activeReaction, reacting }: {
  links: NonNullable<StoryView["links"]>; resolvePost?: (post: ForwardedPost) => Promise<string | null>;
  onReaction?: (reaction: SelectableReaction, remove: boolean) => void; activeReaction?: SelectableReaction; reacting: boolean;
}) {
  const { locale: uiLocale, t: tr } = useTelegramLocale();
  const loadEmoji = useContext(CustomEmojiLoader);
  const openTelegram = useContext(OpenTelegramMessageLink);
  return links.map((area, index) => {
    const { x, y, width, height, rotation } = area;
    const style = { left: `${x}%`, top: `${y}%`, width: `${width}%`, height: `${height}%`,
      transform: `translate(-50%, -50%) rotate(${rotation}deg)` };
    if ("post" in area) return resolvePost && openTelegram
      ? <div key={index} className="mtg-story-link-area" style={style}>
        <StoryPostArea load={() => resolvePost(area.post)} open={openTelegram} />
      </div> : null;
    if ("weather" in area) {
      const { temperature, emoji, color } = area.weather;
      return <div key={index} className="mtg-story-link-area mtg-story-weather-area" style={style}>
        <span className="mtg-story-weather" style={weatherColors(color)}>
          <span aria-hidden="true">{emoji}</span> <bdi>{storyTemperature.format(temperature)}</bdi>
        </span>
      </div>;
    }
    if ("suggested" in area) {
      if (!onReaction) return null;
      const reaction = area.suggested;
      const selected = activeReaction !== undefined && reactionKey(activeReaction) === reactionKey(reaction);
      const label = reaction.kind === "emoji" ? tr("React {0}", [reaction.emoji]) : tr("React with suggested custom emoji");
      return <div key={index} className="mtg-story-link-area" style={style}>
        <button type="button" className="mtg-story-reaction-area" data-dark={area.dark} data-flipped={area.flipped}
          aria-label={label} aria-pressed={selected} disabled={reacting} onClick={() => onReaction(reaction, selected)}>
          {reaction.kind === "emoji" ? reaction.emoji : loadEmoji
            ? <InlineCustomEmoji id={reaction.id} label={tr("Suggested custom emoji")} load={loadEmoji} /> : "☆"}
          <span>{area.count.toLocaleString(uiLocale)}</span>
        </button>
      </div>;
    }
    const target = webLink(area.url);
    if (!target) return null;
    const telegram = canonicalTelegramContentLink(target.href);
    const label = <span className="mtg-story-link-label">{area.label ? <bdi>{area.label}</bdi> : <>{tr("Open ")}<bdi>{target.hostname}</bdi></>}</span>;
    return <div key={index} className="mtg-story-link-area" style={style}>
      {telegram && openTelegram ? <TelegramMessageLink url={telegram} follow={openTelegram}>{label}</TelegramMessageLink>
        : <a href={target.href} target="_blank" rel="noopener noreferrer">{label}</a>}
    </div>;
  });
}

function StoryMusic({ id, story, music, load }: {
  id: string; story: number; music: NonNullable<StoryView["music"]>; load: NonNullable<StoryActions["music"]>;
}) {
  const { t: tr } = useTelegramLocale();
  const stream = useCallback(() => load(id, story, music.fileId), [id, story, music.fileId, load]);
  return <section aria-label={tr("Story music")}>
    <p><bdi>{music.title || tr("Story soundtrack")}</bdi>{music.performer && <> · <bdi>{music.performer}</bdi></>}</p>
    <MediaPlayer chatId={id} messageId={`story:${story}:music:${music.fileId}`} mime={music.mime} stream={stream} />
  </section>;
}

function StoryRepost({ repost, pause }: { repost: NonNullable<StoryView["repost"]>; pause: () => void }) {
  const { t: tr } = useTelegramLocale();
  const openStory = useContext(OpenMessageStory);
  const label = repost.edited ? tr("Edited repost") : tr("Reposted story");
  return <p className="mtg-story-repost">
    {label}{"posterName" in repost && <>{tr(" from ")}<bdi>{repost.posterName}</bdi></>}
    {"origin" in repost && openStory && <> <button type="button" className="mtg-action" onClick={() => {
      pause();
      openStory(repost.origin);
    }}>{tr("Open original story")}</button></>}
  </p>;
}

function StoryPlayer({ id, story, actions, viewed, managed, next }: {
  id: string; story: number; actions: StoryActions; viewed?: () => void; managed: (action: StoryManagement) => void;
  next?: () => void;
}) {
  const { locale: uiLocale, t: tr } = useTelegramLocale();
  const [view, setView] = useState<StoryView>();
  const [displayed, setDisplayed] = useState(false);
  const [replyOpen, setReplyOpen] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const [pageHidden, setPageHidden] = useState(() => document.hidden);
  const [photoPaused, setPhotoPaused] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [reacting, setReacting] = useState(false);
  const [reactionFailed, setReactionFailed] = useState(false);
  const [confirmation, setConfirmation] = useState<StoryManagement>();
  const [managing, setManaging] = useState(false);
  const [captionDraft, setCaptionDraft] = useState<string>();
  const [captionError, setCaptionError] = useState("");
  const [manageFailed, setManageFailed] = useState(false);
  const [failed, setFailed] = useState(false);
  const lifecycle = useRef<{ active: boolean; loaded?: boolean; opening?: Promise<boolean> }>(undefined);
  const player = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const state: { active: boolean; opening?: Promise<boolean> } = { active: true };
    lifecycle.current = state;
    void actions.view(id, story).then(
      (value) => { if (state.active) setView(value); },
      () => { if (state.active) setFailed(true); },
    );
    return () => {
      state.active = false;
      if (state.opening) void state.opening.then((opened) => opened && actions.viewing(id, story, false)).catch(() => {});
    };
  }, [actions, attempt, id, story]);

  function mediaReady() {
    const state = lifecycle.current;
    if (!state?.active) return;
    state.loaded = true;
    if (state.opening || document.hidden) return;
    setDisplayed(true);
    state.opening = actions.viewing(id, story, true).catch(() => false);
    void state.opening.then((opened) => { if (opened) viewed?.(); });
  }

  useEffect(() => {
    function visibilityChanged() {
      const video = player.current;
      setPageHidden(document.hidden);
      if (document.hidden) {
        if (video && !video.paused) video.pause();
      } else if (lifecycle.current?.loaded && !failed) {
        mediaReady();
      }
    }
    document.addEventListener("visibilitychange", visibilityChanged);
    return () => document.removeEventListener("visibilitychange", visibilityChanged);
  });

  const activeReaction: SelectableReaction | undefined = view?.customReaction ? { kind: "custom", id: view.customReaction }
    : view?.reaction ? { kind: "emoji", emoji: view.reaction } : undefined;

  async function changeReaction(nextReaction: SelectableReaction | null, apply: () => Promise<boolean>) {
    if (!displayed || reacting) return;
    setReacting(true);
    setReactionFailed(false);
    try {
      if (!await apply()) throw new Error("Story reaction did not change.");
      const previous = activeReaction && reactionKey(activeReaction);
      const next = nextReaction && reactionKey(nextReaction);
      setView((current) => current && { ...current,
        reaction: nextReaction?.kind === "emoji" ? nextReaction.emoji : undefined,
        customReaction: nextReaction?.kind === "custom" ? nextReaction.id : undefined,
        links: current.links?.map((area) => {
          if (!("suggested" in area)) return area;
          const key = reactionKey(area.suggested);
          return { ...area, count: Math.max(0, area.count + Number(key === next) - Number(key === previous)) };
        }),
      });
    } catch {
      setReactionFailed(true);
    } finally {
      setReacting(false);
    }
  }

  function react(emoji: string | null) {
    if (actions.react) void changeReaction(emoji === null ? null : { kind: "emoji", emoji }, () => actions.react!(id, story, emoji));
  }

  const pauseStory = useCallback(() => {
    setPhotoPaused(true);
    if (player.current && !player.current.paused) player.current.pause();
  }, []);
  const loadStoryMusic = useCallback<NonNullable<StoryActions["music"]>>((chat, storyId, fileId) => {
    pauseStory();
    return actions.music!(chat, storyId, fileId);
  }, [actions.music, pauseStory]);
  const editing = replyOpen || reportOpen || managing || !!confirmation || captionDraft !== undefined;
  function advance() {
    if (!document.hidden && !editing
      && !document.activeElement?.closest("input, textarea, select, a, [contenteditable]")) next?.();
  }

  async function manage(action: StoryManagement) {
    if (!actions.manage || managing) return;
    setManaging(true);
    setManageFailed(false);
    try {
      if (!await actions.manage(id, story, action)) throw new Error("Story did not change.");
      if (action !== "delete") setView((current) => current && { ...current, profileVisibility: action === "showOnProfile" });
      setConfirmation(undefined);
      managed(action);
    } catch {
      setManageFailed(true);
    } finally {
      setManaging(false);
    }
  }

  async function saveCaption() {
    if (!actions.editCaption || !view || managing || captionDraft === undefined || captionDraft.length > 200) return;
    setManaging(true);
    setCaptionError("");
    try {
      const result = await actions.editCaption(id, story, view.caption, captionDraft);
      if (result === "saved") {
        setView((current) => current && { ...current, caption: captionDraft,
          captionLinks: undefined, captionStyles: undefined, captionEmoji: undefined });
        setCaptionDraft(undefined);
      } else {
        setCaptionError(result === "changed" ? "The caption changed in Telegram. Reopen this story before editing."
          : "Could not save the story caption.");
      }
    } catch {
      setCaptionError("Could not save the story caption.");
    } finally {
      setManaging(false);
    }
  }

  if (failed) return <div>
    <p role="alert">{tr("Could not display this Telegram story.")}</p>
    <button type="button" className="mtg-action" onClick={() => {
      setFailed(false);
      setView(undefined);
      setDisplayed(false);
      setReplyOpen(false);
      setPhotoPaused(false);
      setAttempt((value) => value + 1);
    }}>{tr("Retry story")}</button>
  </div>;
  if (!view) return <p role="status">{tr("Loading story…")}</p>;
  const timedPhoto = next && displayed && view.kind === "photo";
  return <>
    {timedPhoto && <div className="mtg-story-actions">
      <button type="button" className="mtg-action" onClick={() => setPhotoPaused((paused) => !paused)}>
        {photoPaused ? tr("Resume story timer") : tr("Pause story timer")}
      </button>
    </div>}
    {view.repost && <StoryRepost repost={view.repost} pause={pauseStory} />}
    <figure className="mtg-story-player">
      {timedPhoto && <div aria-hidden="true" className="mtg-story-photo-progress">
        <span style={{ animationPlayState: photoPaused || pageHidden || editing ? "paused" : "running" }}
          onAnimationEnd={() => { if (!photoPaused) advance(); }} />
      </div>}
      <div className="mtg-story-media">
      {view.kind === "photo"
        ? <img src={view.url} alt={tr("Telegram story photo")} onLoad={mediaReady} onError={() => setFailed(true)} />
        : <video ref={player} src={view.url} controls playsInline preload="metadata" disablePictureInPicture aria-label={tr("Telegram story video")}
          onEnded={next ? advance : undefined}
          onLoadedData={mediaReady} onError={() => setFailed(true)} />}
      {displayed && view.links && <StoryAreas links={view.links} resolvePost={actions.postLink && ((post) => actions.postLink!(id, story, post))}
        activeReaction={activeReaction} reacting={reacting} onReaction={actions.reactSuggested && ((reaction, remove) =>
          void changeReaction(remove ? null : reaction, () => actions.reactSuggested!(id, story, reaction, remove)))} />}
      </div>
      {view.caption && <figcaption dir="auto"><MessageText text={view.caption} inline links={view.captionLinks}
        styles={view.captionStyles} customEmoji={view.captionEmoji} /></figcaption>}
    </figure>
    {displayed && view.music && actions.music && <StoryMusic id={id} story={story} music={view.music} load={loadStoryMusic} />}
    {displayed && actions.report && (reportOpen
      ? <div data-story-report>
        <ChatReport id={id} name="this story" story actions={{ report: (_id, _name, step) => actions.report!(id, story, step) }}
          close={() => setReportOpen(false)} />
      </div>
      : <button type="button" className="mtg-action" onClick={() => { pauseStory(); setReportOpen(true); }}>{tr("Report story")}</button>)}
    {view.canReply && actions.reply && displayed && <StoryReply open={replyOpen} setOpen={(open) => {
      setReplyOpen(open);
      if (open && player.current && !player.current.paused) player.current.pause();
    }} send={(text) => actions.reply!(id, story, text)} />}
    {view.editableAudience && actions.changeAudience && <StoryAudienceEditor audience={view.editableAudience} save={async (audience) => {
      const result = await actions.changeAudience!(id, story, view.editableAudience!, audience);
      if (result === "saved") setView((current) => current && { ...current, editableAudience: audience,
        canCopyLink: current.canCopyLink && audience === "everyone" });
      return result;
    }} />}
    {view.canCopyLink && actions.link && <CopyTelegramLink chatId={id} messageId={String(story)} load={actions.link} kind="story" />}
    {view.counts && <p aria-label={tr("Story counts")}>
      {view.counts.views.toLocaleString(uiLocale)}{tr(" views · ")}{view.counts.forwards.toLocaleString(uiLocale)}{tr(" forwards · ")}{view.counts.reactions.toLocaleString(uiLocale)}{tr(" reactions")}</p>}
    {view.canGetInteractions && actions.interactions && <StoryActivity personal={!id.startsWith("-")} pause={pauseStory}
      load={(offset, filter) => actions.interactions!(id, story, offset, filter)} />}
    {actions.editCaption && view.canEditCaption && !confirmation && (captionDraft === undefined
      ? <button type="button" className="mtg-action" disabled={managing} onClick={() => setCaptionDraft(view.caption)}>{tr("Edit story caption")}</button>
      : <form onSubmit={(event) => { event.preventDefault(); void saveCaption(); }}>
        <label>{tr("Story caption ")}<textarea value={captionDraft} maxLength={200} disabled={managing}
          onChange={(event) => setCaptionDraft(event.currentTarget.value)} /></label>
        <button type="submit" className="mtg-action" disabled={managing || captionDraft.length > 200 || captionDraft === view.caption}>{tr("Save caption")}</button>
        <button type="button" className="mtg-action" disabled={managing} onClick={() => {
          setCaptionDraft(undefined);
          setCaptionError("");
        }}>{tr("Cancel caption edit")}</button>
        {captionError && <p role="alert">{tr(captionError)}</p>}
      </form>)}
    {captionDraft === undefined && actions.manage && (view.canDelete || view.profileVisibility !== undefined) && (
      <div className="mtg-story-actions" role="group" aria-label={tr("Manage story")}>
        {confirmation ? <>
          <span>{confirmation === "delete" ? tr("Permanently delete this Telegram story?")
            : confirmation === "hideFromProfile" ? tr("Remove this story from the profile?")
            : tr("Keep this story visible on the profile after it expires?")}</span>
          <button type="button" className="mtg-action" disabled={managing}
            onClick={() => void manage(confirmation)}>{tr("Confirm ")}{confirmation === "delete" ? tr("deletion") : tr("profile change")}</button>
          <button type="button" className="mtg-action" disabled={managing}
            onClick={() => { setConfirmation(undefined); setManageFailed(false); }}>{tr("Cancel")}</button>
        </> : <>
          {view.profileVisibility !== undefined && <button type="button" className="mtg-action"
            onClick={() => setConfirmation(view.profileVisibility ? "hideFromProfile" : "showOnProfile")}>
            {view.profileVisibility ? tr("Remove from profile") : tr("Keep on profile")}
          </button>}
          {view.canDelete && <button type="button" className="mtg-action" onClick={() => setConfirmation("delete")}>{tr("Delete story")}</button>}
        </>}
        {manageFailed && <p role="alert">{tr("Could not update this Telegram story.")}</p>}
      </div>
    )}
    {actions.react && displayed && <div className="mtg-story-actions" role="group" aria-label={tr("Story reactions")}>
      {["❤", "👍", "🔥", "😂"].map((emoji) => {
        const chosen = view.reaction?.replaceAll("\uFE0F", "") === emoji;
        return <button key={emoji} type="button" className="mtg-action" aria-label={tr("React {0}", [emoji])}
          aria-pressed={chosen} disabled={reacting} onClick={() => void react(chosen ? null : emoji)}>{emoji}</button>;
      })}
      {activeReaction && <button type="button" className="mtg-action" disabled={reacting}
        onClick={() => void react(null)}>{tr("Remove reaction")}</button>}
    </div>}
    {displayed && actions.reactionCatalog && actions.reactFromCatalog && <StoryReactionCatalog current={activeReaction}
      disabled={reacting} pause={pauseStory} load={() => actions.reactionCatalog!(id, story)}
      choose={(choice) => void changeReaction(choice, () => actions.reactFromCatalog!(id, story, choice))} />}
    {reactionFailed && <p role="alert">{tr("Could not update your reaction.")}</p>}
  </>;
}
