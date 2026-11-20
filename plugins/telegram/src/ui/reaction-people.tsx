import { useTelegramLocale } from "./i18n/index.tsx";
import { createContext, useContext, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { reactionKey, type ReactionPeoplePage, type ReactionPersonReference, type SelectableReaction } from "../core/contract.ts";
import { Avatar, type AvatarLoader } from "./avatar.tsx";

export type ReactionPeopleLoader = (
  chatId: string, messageId: string, reaction: SelectableReaction | undefined, offset: string,
) => Promise<ReactionPeoplePage | null>;
export const OpenReactionPerson = createContext<((chatId: string, messageId: string, target: ReactionPersonReference, signal: AbortSignal) =>
  Promise<boolean>) | undefined>(undefined);

type Filter = { reaction: SelectableReaction; label: string; count: number };
const dateTime = new Intl.DateTimeFormat(undefined, { dateStyle: "short", timeStyle: "short" });

export function ReactionPeople({ chatId, messageId, filters, initialFilter, load, loadAvatar, artwork, close }: {
  chatId: string;
  messageId: string;
  filters: Filter[];
  initialFilter?: SelectableReaction;
  load: ReactionPeopleLoader;
  loadAvatar?: AvatarLoader;
  artwork: (reaction: SelectableReaction) => ReactNode;
  close: () => void;
}) {
  const { t: tr } = useTelegramLocale();
  const [filter, setFilter] = useState(initialFilter);
  const dialog = useRef<HTMLDialogElement>(null);
  const opening = useRef<AbortController | undefined>(undefined);
  const title = useId();
  const selectedKey = filter ? reactionKey(filter) : undefined;
  const active = filters.some(({ reaction }) => reactionKey(reaction) === selectedKey) ? filter : undefined;
  useEffect(() => {
    const viewer = dialog.current;
    if (viewer && !viewer.open) viewer.showModal();
  }, []);
  function closeDialog() {
    opening.current?.abort();
    dialog.current?.close();
  }
  function changeFilter(next: SelectableReaction | undefined) {
    if (selectedKey !== (next && reactionKey(next))) {
      opening.current?.abort();
      opening.current = undefined;
    }
    setFilter(next);
  }
  return <dialog ref={dialog} className="mtg-instant-view mtg-reaction-people" aria-labelledby={title}
    onCancel={(event) => { event.preventDefault(); closeDialog(); }} onClose={close}>
    <header>
      <h2 id={title}>{tr("Who reacted")}</h2>
      <button type="button" className="mtg-action" onClick={closeDialog}>{tr("Close reactions")}</button>
    </header>
    <div className="mtg-reaction-picker" role="group" aria-label={tr("Filter people by reaction")}>
      <button type="button" className="mtg-action" aria-pressed={active === undefined} onClick={() => changeFilter(undefined)}>{tr("All reactions")}</button>
      {filters.map(({ reaction, label, count }) => <button type="button" key={reactionKey(reaction)} className="mtg-action"
        aria-label={tr("People who reacted with {0}, {1}", [label, count])} aria-pressed={selectedKey === reactionKey(reaction)}
        onClick={() => changeFilter(reaction)}>{artwork(reaction)} {count}</button>)}
    </div>
    <PeopleList key={active ? reactionKey(active) : "all"} chatId={chatId} messageId={messageId}
      filter={active} load={load} loadAvatar={loadAvatar} artwork={artwork} opening={opening} close={closeDialog} />
  </dialog>;
}

function PeopleList({ chatId, messageId, filter, load, loadAvatar, artwork, opening, close }: {
  chatId: string; messageId: string; filter?: SelectableReaction; load: ReactionPeopleLoader;
  loadAvatar?: AvatarLoader;
  artwork: (reaction: SelectableReaction) => ReactNode;
  opening: { current: AbortController | undefined };
  close: () => void;
}) {
  const { t: tr } = useTelegramLocale();
  const open = useContext(OpenReactionPerson);
  const [profile, setProfile] = useState<"opening" | "unavailable">();
  const [request, setRequest] = useState({ offset: "" });
  const [entries, setEntries] = useState<(ReactionPeoplePage["entries"][number] & { offset: string })[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [state, setState] = useState<"loading" | "loaded" | "failed">("loading");

  useEffect(() => {
    let active = true;
    void load(chatId, messageId, filter, request.offset).then((page) => {
      if (!active) return;
      if (!page) { setState("failed"); return; }
      const rows = page.entries.map((entry) => ({ ...entry, offset: request.offset }));
      setEntries((previous) => [...new Map([...previous, ...rows].map((entry) => [
        `${entry.sender.kind}:${entry.sender.id}:${reactionKey(entry.reaction)}`, entry,
      ])).values()]);
      setNext(page.next);
      setState("loaded");
    }).catch(() => { if (active) setState("failed"); });
    return () => { active = false; };
  }, [chatId, messageId, load, filter, request]);
  useEffect(() => {
    return () => {
      opening.current?.abort();
      opening.current = undefined;
    };
  }, [opening]);

  async function openProfile(target: ReactionPersonReference) {
    if (!open || opening.current) return;
    const controller = new AbortController();
    opening.current = controller;
    setProfile("opening");
    const found = await open(chatId, messageId, target, controller.signal).catch(() => false);
    if (controller.signal.aborted) return;
    opening.current = undefined;
    if (found) close();
    else setProfile("unavailable");
  }

  function requestPage(offset: string) {
    setState("loading");
    setRequest({ offset });
  }
  return <>
    {entries.length > 0 && <ul aria-label={tr("People who reacted")}>
      {entries.map(({ sender, name, reaction, avatarJpeg, avatarFileId, reactedAt, offset }) => {
        const initials = name.trim().split(/\s+/).slice(0, 2).map((word) => Array.from(word)[0]).join("").toUpperCase();
        const date = reactedAt === undefined ? undefined : new Date(reactedAt * 1000);
        return <li key={`${sender.kind}:${sender.id}:${reactionKey(reaction)}`}>
          <Avatar chat={{ id: sender.id, initials, color: "#246dbd", avatarJpeg, avatarFileId }}
            user={sender.kind === "user"} load={loadAvatar} />
          <div className="mtg-reactor-identity">
            {open ? <button type="button" className="mtg-author-search" aria-label={tr("Open profile of {0}", [name])}
              disabled={profile === "opening"} onClick={() => void openProfile({ sender, reaction, filter, offset })}>
              <bdi>{name}</bdi>
            </button> : <bdi>{name}</bdi>}
            {date && <time dateTime={date.toISOString()}>{dateTime.format(date)}</time>}
          </div>
          <span>{artwork(reaction)}</span>
        </li>;
      })}
    </ul>}
    {profile === "opening" && <p role="status">{tr("Opening profile…")}</p>}
    {profile === "unavailable" && <p role="status">{tr("Could not open this profile. The reaction or profile may have changed.")}</p>}
    {state === "loading" && <span role="status">{tr("Loading reactions…")}</span>}
    {state === "loaded" && entries.length === 0 && next === null && <p>{tr("No reactions to show.")}</p>}
    {state === "loaded" && next !== null && <button type="button" className="mtg-action"
      onClick={() => requestPage(next)}>{tr("Load more reactions")}</button>}
    {state === "failed" && <><p role="alert">{tr("Telegram did not return the people who reacted.")}</p>
      <button type="button" className="mtg-action" onClick={() => requestPage(request.offset)}>{tr("Retry loading reactions")}</button></>}
  </>;
}
