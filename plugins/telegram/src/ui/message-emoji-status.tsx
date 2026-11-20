import { useTelegramLocale } from "./i18n/index.tsx";
import { createContext, useContext, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { ProfileEmojiChange, ProfileEmojiStatus, StickerPackPreviewData } from "../core/contract.ts";
import { StickerPackPreview } from "./sticker-pack-preview.tsx";
import { emojiStatusDurations } from "./profile-emoji-status.tsx";
import { contextMenuKey, useObjectContextMenu } from "./object-context-menu.tsx";

export const MessageEmojiStatusActions = createContext<{
  review: (emoji: string) => Promise<{ expected: ProfileEmojiStatus | null } | null>;
  save: (change: ProfileEmojiChange & { emoji: string }) => Promise<"saved" | "changed" | "unsupported">;
} | undefined>(undefined);

export const MessageEmojiPackActions = createContext<{
  load: (emoji: string, offset: number, packId?: string) => Promise<StickerPackPreviewData | null>;
  install: (link: string, id: string) => Promise<"installed" | "unavailable" | "unknown">;
} | undefined>(undefined);

export function MessageEmojiStatusTarget({ emoji, label, children }: { emoji: string; label: string; children: ReactNode }) {
  const { t: tr } = useTelegramLocale();
  const status = useContext(MessageEmojiStatusActions);
  const pack = useContext(MessageEmojiPackActions);
  const trigger = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState<"pack" | "status">();
  const objectMenu = useObjectContextMenu(emoji);
  if (!status && !pack) return children;
  const action = pack ? "Open emoji pack" : "emoji status actions";
  const statusAction = { label: "Emoji status actions", run: () => setOpen("status") } as const;
  const alternate = status && pack ? [statusAction] : [];
  function close() {
    setOpen(undefined);
    requestAnimationFrame(() => trigger.current?.focus());
  }
  return <><span className="mtg-emoji-status-target" ref={trigger} role="button" tabIndex={0} aria-haspopup="dialog"
    aria-label={label ? `${label} ${action}` : action} aria-keyshortcuts="Shift+F10"
    data-context-label={pack ? tr("Open emoji pack") : tr("Emoji status actions")}
    onClick={(event) => {
      const selection = event.currentTarget.ownerDocument.getSelection();
      if (selection?.rangeCount && !selection.isCollapsed && selection.getRangeAt(0).intersectsNode(event.currentTarget)) return;
      event.stopPropagation();
      setOpen(pack ? "pack" : "status");
    }}
    onContextMenu={(event) => objectMenu.onContextMenu(event, alternate)}
    onKeyDown={(event) => {
      if (contextMenuKey(event)) { objectMenu.onKeyDown(event, alternate); return; }
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(pack ? "pack" : "status");
    }}>{children}</span>
    {objectMenu.content}
    {open && trigger.current && createPortal(open === "pack" && pack
      ? <MessageEmojiPackDialog key={emoji} emoji={emoji} actions={pack} close={close}
        status={status && (() => setOpen("status"))} />
      : status && <MessageEmojiStatusDialog emoji={emoji} label={label} artwork={children} actions={status} close={close}
        showPack={pack && (() => setOpen("pack"))} />,
    trigger.current.closest(".mtg") ?? trigger.current.ownerDocument.body)}
  </>;
}

function MessageEmojiPackDialog({ emoji, actions, close, status }: {
  emoji: string;
  actions: NonNullable<React.ContextType<typeof MessageEmojiPackActions>>;
  close: () => void;
  status?: () => void;
}) {
  const { t: tr } = useTelegramLocale();
  const dialog = useRef<HTMLDialogElement>(null);
  const title = useId();
  const [pack, setPack] = useState<StickerPackPreviewData | null>();
  const [failed, setFailed] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  useEffect(() => {
    let active = true;
    void actions.load(emoji, 0).then((result) => {
      if (active) setPack(result?.emoji ? result : null);
    }, () => { if (active) setFailed(true); });
    return () => { active = false; };
  }, [actions, emoji, revision]);

  const link = pack?.link;
  return <dialog ref={dialog} className="mtg-agent-settings" aria-labelledby={title}
    onCancel={(event) => { event.preventDefault(); close(); }} onKeyDown={(event) => event.stopPropagation()}>
    <h2 id={title}>{tr("Emoji pack")}</h2>
    {pack === undefined && !failed && <p role="status">{tr("Loading emoji pack…")}</p>}
    {pack === null && <p role="status">{tr("This emoji pack is unavailable.")}</p>}
    {failed && <>
      <p role="alert">{tr("Could not load this emoji pack.")}</p>
      <button type="button" className="mtg-action" onClick={() => { setFailed(false); setRevision((value) => value + 1); }}>{tr("Retry")}</button>
    </>}
    {status && <button type="button" className="mtg-action" onClick={status}>{tr("Emoji status actions")}</button>}
    {pack ? <StickerPackPreview initial={pack} emoji close={close}
      load={(offset) => actions.load(emoji, offset, pack.id)}
      install={link ? (id) => actions.install(link, id) : undefined} />
      : <button type="button" className="mtg-action" onClick={close}>{tr("Close")}</button>}
  </dialog>;
}

function MessageEmojiStatusDialog({ emoji, label, artwork, actions, close, showPack }: {
  emoji: string;
  label: string;
  artwork: ReactNode;
  actions: NonNullable<React.ContextType<typeof MessageEmojiStatusActions>>;
  close: () => void;
  showPack?: () => void;
}) {
  const { t: tr } = useTelegramLocale();
  const dialog = useRef<HTMLDialogElement>(null);
  const title = useId();
  const [expected, setExpected] = useState<ProfileEmojiStatus | null>();
  const [status, setStatus] = useState<"unavailable" | "changed" | "saved">();
  const [busy, setBusy] = useState(false);
  const [duration, setDuration] = useState(0);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  useEffect(() => {
    let active = true;
    void actions.review(emoji).then((result) => {
      if (!active) return;
      if (result) setExpected(result.expected);
      else setStatus("unavailable");
    }, () => { if (active) setStatus("unavailable"); });
    return () => { active = false; };
  }, [actions, emoji]);
  const same = expected?.key === `emoji:${emoji}`;

  async function save(remove: boolean) {
    if (busy || expected === undefined || status) return;
    setBusy(true);
    const result = await actions.save({ emoji, expected, key: remove ? null : `emoji:${emoji}`, duration: remove ? 0 : duration })
      .catch(() => "unsupported" as const);
    setStatus(result === "unsupported" ? "unavailable" : result);
    setBusy(false);
  }

  return <dialog ref={dialog} className="mtg-agent-settings" aria-labelledby={title} onCancel={(event) => {
    event.preventDefault();
    if (!busy) close();
  }} onKeyDown={(event) => event.stopPropagation()}>
    <h2 id={title}>{tr("Emoji status")}</h2>
    {showPack && <button type="button" className="mtg-action" disabled={busy} onClick={showPack}>{tr("Open emoji pack")}</button>}
    {expected === undefined && !status && <p role="status">{tr("Checking Telegram availability…")}</p>}
    {expected !== undefined && !status && <>
      <p>{same ? <>{tr("Your current emoji status is ")}{artwork}.</> : <>{tr("Set ")}{label ? artwork : tr("this emoji")}{tr(" as your Telegram status?")}</>}</p>
      <label>{tr("Duration ")}<select value={duration} disabled={busy} onChange={(event) => setDuration(Number(event.target.value))}>
        {emojiStatusDurations.map(([seconds, text]) => <option key={seconds} value={seconds}>{text}</option>)}
      </select></label>
      <button type="button" className="mtg-action" disabled={busy} onClick={() => void save(false)}>
        {same ? tr("Update duration") : tr("Set emoji status")}
      </button>
      {same && <button type="button" className="mtg-action" disabled={busy} onClick={() => void save(true)}>{tr("Remove emoji status")}</button>}
    </>}
    {status === "saved" && <p role="status">{tr("Emoji status updated.")}</p>}
    {status === "changed" && <p role="alert">{tr("Your status changed in Telegram. Open this action again to review it.")}</p>}
    {status === "unavailable" && <p role="alert">{tr("Telegram could not use this emoji as a status for your account.")}</p>}
    <button type="button" className="mtg-action" disabled={busy} onClick={close}>{status === "saved" ? tr("Done") : tr("Close")}</button>
  </dialog>;
}
