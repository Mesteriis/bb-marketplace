import { useTelegramLocale } from "./i18n/index.tsx";
import { MessageActionEntry } from "./message-action-slot.tsx";
import { SmilePlus } from "lucide-react";
import { useContext, useRef, useState } from "react";
import { reactionKey, type MessageReactions as Reactions, type ReactionType, type SelectableReaction } from "../core/contract.ts";
import { CustomEmojiLoader, InlineCustomEmoji } from "./custom-emoji.tsx";
import type { AvatarLoader } from "./avatar.tsx";
import { ReactionPeople, type ReactionPeopleLoader } from "./reaction-people.tsx";
import { useObjectContextMenu } from "./object-context-menu.tsx";

export type ReactionActions = {
  listReactions: (chatId: string, messageId: string) => Promise<SelectableReaction[]>;
  setReaction: (chatId: string, messageId: string, reaction: SelectableReaction, chosen: boolean) => Promise<boolean>;
  loadPeople?: ReactionPeopleLoader;
  loadAvatar?: AvatarLoader;
  loadPaidPeople?: (chatId: string, messageId: string) => Promise<{ name: string; stars: number; own: boolean; anonymous: boolean; top: boolean }[]>;
  paidLimit?: (chatId: string, messageId: string) => Promise<number | null>;
  paidSenders?: (chatId: string) => Promise<{ id: string; name: string }[]>;
  sendPaid?: (chatId: string, messageId: string, stars: number, anonymous: boolean, asChat?: string) => Promise<"sent" | "failed" | "unknown">;
  setPaidAnonymity?: (chatId: string, messageId: string, expected: boolean, anonymous: boolean) =>
    Promise<"saved" | "changed" | "unavailable">;
  quickReaction?: SelectableReaction;
  setQuickReaction?: (reaction: SelectableReaction) => Promise<boolean>;
};

function reactionLabel(type: ReactionType) {
  return type.kind === "emoji" ? type.emoji : type.kind === "paid" ? "Stars" : "Custom emoji";
}

function PaidReactionPeople({ chatId, messageId, load, setAnonymity }: {
  chatId: string; messageId: string; load: NonNullable<ReactionActions["loadPaidPeople"]>;
  setAnonymity?: ReactionActions["setPaidAnonymity"];
}) {
  const { locale: uiLocale, t: tr } = useTelegramLocale();
  const [people, setPeople] = useState<Awaited<ReturnType<typeof load>>>();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [status, setStatus] = useState("");
  async function toggle() {
    if (busy) return;
    setStatus("");
    if (people) { setPeople(undefined); return; }
    setBusy(true);
    setFailed(false);
    try { setPeople(await load(chatId, messageId)); }
    catch { setFailed(true); }
    finally { setBusy(false); }
  }
  async function change(anonymous: boolean) {
    if (!setAnonymity || busy) return;
    setBusy(true);
    setStatus("");
    try {
      const result = await setAnonymity(chatId, messageId, anonymous, !anonymous);
      setStatus(result === "saved" ? "Stars reaction visibility updated."
        : result === "changed" ? "Your Stars reaction changed. Review the current visibility." : "Could not update Stars reaction visibility.");
      setPeople(await load(chatId, messageId));
    } catch { setStatus("Could not verify Stars reaction visibility."); }
    finally { setBusy(false); }
  }
  return <>
    <button type="button" className="mtg-action" aria-expanded={people !== undefined} disabled={busy} onClick={() => void toggle()}>
      {people ? tr("Hide top Stars reactions") : tr("Show top Stars reactions")}
    </button>
    {failed && <p role="alert">{tr("Could not load Stars reactions.")}</p>}
    {people?.length === 0 && <p>{tr("No Stars reaction details available.")}</p>}
    {!!people?.length && <ul aria-label={tr("Top Stars reactions")}>{people.map((row, index) => <li key={index}>
      <bdi>{row.name}</bdi>{row.own && row.anonymous && tr(" (anonymous)")} · {row.stars.toLocaleString(uiLocale)}{tr(" Stars")}{row.own && setAnonymity && <button type="button" className="mtg-action" disabled={busy}
        onClick={() => void change(row.anonymous)}>{row.anonymous ? tr("Show my name") : tr("Make my reaction anonymous")}</button>}
    </li>)}</ul>}
    {status && <p role="status">{tr(status)}</p>}
  </>;
}

function PaidReactionComposer({ limit, senders, send }: { limit: number; senders: { id: string; name: string }[];
  send: (stars: number, anonymous: boolean, asChat?: string) => Promise<"sent" | "failed" | "unknown">;
}) {
  const { t: tr } = useTelegramLocale();
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState("1");
  const [anonymous, setAnonymous] = useState(false);
  const [asChat, setAsChat] = useState("");
  const [status, setStatus] = useState<"sent" | "failed" | "unknown">();
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const stars = Number(amount);
  const valid = Number.isSafeInteger(stars) && stars >= 1 && stars <= limit;
  async function confirm() {
    if (pending.current || !valid) return;
    pending.current = true;
    setBusy(true);
    try { setStatus(await send(stars, !asChat && anonymous, asChat || undefined).catch(() => "unknown" as const)); }
    finally { pending.current = false; setBusy(false); setOpen(false); }
  }
  return <>
    {open ? <form aria-label={tr("Stars reaction")} onSubmit={(event) => { event.preventDefault(); void confirm(); }}>
      <label>{tr("Stars ")}<input type="number" min={1} max={limit} step={1} value={amount} disabled={busy}
        onChange={(event) => setAmount(event.target.value)} /></label>
      {!!senders.length && <label>{tr("Send as ")}<select value={asChat} disabled={busy} onChange={(event) => setAsChat(event.target.value)}>
        <option value="">{tr("My account")}</option>
        {senders.map(({ id, name }) => <option key={id} value={id}>{name}</option>)}
      </select></label>}
      {!asChat && <label><input type="checkbox" checked={anonymous} disabled={busy}
        onChange={(event) => setAnonymous(event.target.checked)} />{tr(" Send anonymously")}</label>}
      <button type="submit" className="mtg-action" disabled={!valid || busy}>{tr("Confirm Stars reaction")}</button>
      <button type="button" className="mtg-action" disabled={busy} onClick={() => setOpen(false)}>{tr("Cancel")}</button>
    </form> : status !== "unknown" && <button type="button" className="mtg-action" onClick={() => { setStatus(undefined); setOpen(true); }}>{tr("React with Stars")}</button>}
    {status && <p role="status">{status === "sent" ? tr("Stars reaction sent.") : status === "failed" ? tr("Could not send the Stars reaction.")
      : tr("Telegram did not confirm the reaction. Check Stars transactions before trying again.")}</p>}
  </>;
}

export function MessageReactions({ chatId, messageId, reactions, actions }: {
  chatId: string;
  messageId: string;
  reactions?: Reactions;
  actions?: ReactionActions;
}) {
  const { t: tr } = useTelegramLocale();
  const objectMenu = useObjectContextMenu(`${chatId}:${messageId}`);
  const loadEmoji = useContext(CustomEmojiLoader);
  const [choices, setChoices] = useState<SelectableReaction[]>();
  const [paidLimit, setPaidLimit] = useState<number | null>(null);
  const [paidSenders, setPaidSenders] = useState<{ id: string; name: string }[]>([]);
  const [choosingQuick, setChoosingQuick] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [people, setPeople] = useState<{ trigger: HTMLButtonElement; filter?: SelectableReaction }>();
  const loadPeople = reactions?.canView ? actions?.loadPeople : undefined;

  async function open() {
    if (!actions || busy) return;
    if (choices) { setChoices(undefined); setChoosingQuick(false); return; }
    setError(undefined);
    setBusy(true);
    try {
      const [reactions, limit] = await Promise.all([actions.listReactions(chatId, messageId),
        actions.sendPaid ? actions.paidLimit?.(chatId, messageId).catch(() => null) : null]);
      const senders = limit ? await actions.paidSenders?.(chatId).catch(() => []) ?? [] : [];
      setChoices(reactions);
      setPaidLimit(limit ?? null);
      setPaidSenders(senders);
    } catch {
      setError("Could not load available reactions.");
    } finally {
      setBusy(false);
    }
  }

  async function choose(reaction: SelectableReaction, chosen: boolean) {
    if (!actions || busy) return;
    setError(undefined);
    setBusy(true);
    try {
      if (await actions.setReaction(chatId, messageId, reaction, chosen)) setChoices(undefined);
      else setError("Telegram did not confirm the reaction.");
    } catch {
      setError("Telegram did not confirm the reaction.");
    } finally {
      setBusy(false);
    }
  }

  async function saveQuick(reaction: SelectableReaction) {
    if (!actions?.setQuickReaction || busy) return;
    setError(undefined);
    setBusy(true);
    try {
      if (await actions.setQuickReaction(reaction)) {
        setChoosingQuick(false);
        setChoices(undefined);
      } else {
        setError("Telegram did not confirm the quick reaction.");
      }
    } catch {
      setError("Telegram did not confirm the quick reaction.");
    } finally {
      setBusy(false);
    }
  }

  function artwork(type: ReactionType) {
    return type.kind === "custom" && loadEmoji
      ? <span role="img" aria-label={reactionLabel(type)}><span aria-hidden="true">
        <InlineCustomEmoji key={type.id} id={type.id} label="✦" load={loadEmoji} />
      </span></span> : reactionLabel(type);
  }
  const quick = actions?.quickReaction;
  const quickKey = quick && reactionKey(quick);
  const quickChosen = reactions?.items.some(({ type, chosen }) => chosen && reactionKey(type) === quickKey) ?? false;

  function peopleAction(trigger: HTMLButtonElement, filter: SelectableReaction) {
    return { label: "Who reacted", run: () => setPeople({ trigger, filter }) };
  }

  return <>
    {reactions && <ul className="mtg-reactions" aria-label={reactions.tags ? tr("Message tags") : tr("Message reactions")}>
      {reactions.items.map(({ type, count, chosen }) => {
        return <li key={reactionKey(type)} className={chosen ? "mtg-reaction-chosen" : undefined}>
          {actions && type.kind !== "paid"
            ? <button type="button" aria-pressed={chosen} aria-label={tr("React {0}, {1}", [reactionLabel(type), count])}
              aria-keyshortcuts={loadPeople ? "Shift+F10" : undefined}
              onContextMenu={loadPeople ? (event) => objectMenu.onContextMenu(event, [peopleAction(event.currentTarget, type)]) : undefined}
              onKeyDown={loadPeople ? (event) => {
                if (!event.repeat) objectMenu.onKeyDown(event, [peopleAction(event.currentTarget, type)]);
              } : undefined}
              disabled={busy} onClick={() => void choose(type, !chosen)}>{artwork(type)} <span>{count}</span></button>
            : <>{artwork(type)} <span>{count}</span>{chosen && <span className="mtg-visually-hidden">{tr(" · You reacted")}</span>}</>}
        </li>;
      })}
    </ul>}
    {objectMenu.content}
    <MessageActionEntry>
    {reactions?.items.some(({ type }) => type.kind === "paid") && actions?.loadPaidPeople &&
      <PaidReactionPeople key={`paid-reaction-people:${chatId}:${messageId}`} chatId={chatId} messageId={messageId}
        load={actions.loadPaidPeople} setAnonymity={actions.setPaidAnonymity} />}
    {reactions && loadPeople && <button type="button" className="mtg-action" aria-haspopup="dialog"
      onClick={(event) => setPeople({ trigger: event.currentTarget })}>{tr("Who reacted")}</button>}
    {reactions && loadPeople && people && <ReactionPeople chatId={chatId} messageId={messageId}
      filters={reactions.items.flatMap(({ type, count }) => type.kind === "paid"
        ? [] : [{ reaction: type, label: reactionLabel(type), count }])}
      initialFilter={people.filter} load={loadPeople} loadAvatar={actions?.loadAvatar} artwork={artwork} close={() => {
        people.trigger.focus({ preventScroll: true });
        setPeople(undefined);
      }} />}
    </MessageActionEntry>
    <MessageActionEntry reactionPicker>
    <div className="mtg-message-reaction-shortcuts">
    {quick && <button type="button" className="mtg-reply-action" data-quick-reaction aria-pressed={quickChosen}
      aria-label={tr("Quick reaction {0}", [reactionLabel(quick)])} title={tr("Quick reaction")}
      disabled={busy} onClick={() => void choose(quick, !quickChosen)}>{artwork(quick)}</button>}
    {actions && <button type="button" className="mtg-reply-action" aria-label={tr("Add reaction")} title={tr("Add reaction")}
      aria-expanded={choices !== undefined} disabled={busy} onClick={() => void open()}><SmilePlus size={15} aria-hidden="true" /></button>}
    </div>
    {!!choices?.length && <div className="mtg-reaction-picker" role="group"
      aria-label={choosingQuick ? tr("Choose a quick reaction") : tr("Available reactions")}>
      {choices.map((type) => {
        const key = reactionKey(type);
        const chosen = reactions?.items.some((row) => row.chosen && reactionKey(row.type) === key) ?? false;
        return <button type="button" key={key} className="mtg-action" aria-label={tr("React {0}", [reactionLabel(type)])}
          aria-pressed={choosingQuick ? key === quickKey : chosen} disabled={busy}
          onClick={() => void (choosingQuick ? saveQuick(type) : choose(type, !chosen))}>{artwork(type)}</button>;
      })}
      {actions?.setQuickReaction && <button type="button" className="mtg-action" disabled={busy}
        onClick={() => setChoosingQuick(!choosingQuick)}>{choosingQuick ? tr("Back to reactions") : tr("Set quick reaction")}</button>}
    </div>}
    {choices && !choosingQuick && paidLimit && actions?.sendPaid &&
      <PaidReactionComposer key={`paid-reaction-composer:${chatId}:${messageId}`} limit={paidLimit} senders={paidSenders}
        send={(stars, anonymous, asChat) => asChat
          ? actions.sendPaid!(chatId, messageId, stars, anonymous, asChat) : actions.sendPaid!(chatId, messageId, stars, anonymous)} />}
    {choices?.length === 0 && !paidLimit && <span role="status">{tr("No available reactions.")}</span>}
    {error && <p role="alert">{tr(error)}</p>}
    </MessageActionEntry>
  </>;
}
