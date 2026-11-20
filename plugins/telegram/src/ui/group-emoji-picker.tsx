import { useTelegramLocale } from "./i18n/index.tsx";
import { createContext, useContext, useRef, useState } from "react";
import { Smile, SmilePlus } from "lucide-react";
import type { GroupEmojiChoice, GroupEmojiChoicePage } from "../core/contract.ts";
import { StickerPackDiscovery, type StickerPackDiscoveryActions } from "./sticker-pack-discovery.tsx";
import { StickerPackLibrary, type StickerPackLibraryActions } from "./sticker-pack-library.tsx";
import { CustomEmojiLoader, InlineCustomEmoji } from "./custom-emoji.tsx";

export type LoadGroupEmoji = (id: string, offset: number, packId?: string) => Promise<GroupEmojiChoicePage | null>;

function GroupEmojiPicker({ id, load, disabled, insert, compact }: {
  id: string;
  load: LoadGroupEmoji;
  disabled: boolean;
  insert: (choice: GroupEmojiChoice) => boolean;
  compact?: boolean;
}) {
  const { t: tr } = useTelegramLocale();
  const loadArtwork = useContext(CustomEmojiLoader);
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState<GroupEmojiChoicePage | null>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const request = useRef(0);
  const toggle = useRef<HTMLButtonElement>(null);

  function close() {
    request.current++;
    setOpen(false);
    setBusy(false);
    setPage(undefined);
    setError("");
  }

  async function browse(offset = 0, previous?: GroupEmojiChoicePage) {
    const token = ++request.current;
    setOpen(true);
    setBusy(true);
    setError("");
    try {
      const next = await load(id, offset, previous?.id);
      if (token !== request.current) return;
      if (!next || (previous && previous.id !== next.id)) {
        setPage(null);
        return;
      }
      const known = new Set(previous?.choices.map(({ id: emojiId }) => emojiId));
      setPage(previous ? { ...next, choices: [...previous.choices, ...next.choices.filter(({ id: emojiId }) => !known.has(emojiId))] } : next);
    } catch {
      if (token === request.current) setError("Could not load the group emoji pack.");
    } finally {
      if (token === request.current) setBusy(false);
    }
  }

  return <div className="mtg-composer-media" onKeyDown={(event) => {
    if (open && event.key === "Escape" && !event.nativeEvent.isComposing) {
      event.preventDefault();
      event.stopPropagation();
      close();
      toggle.current?.focus();
    }
  }}>
    <button ref={toggle} type="button" className={compact ? "mtg-compose-icon" : "mtg-action"} aria-expanded={open} disabled={disabled}
      aria-label={tr("Group emoji")} title={tr("Group emoji")} onClick={() => open ? close() : void browse()}>
      {compact ? <SmilePlus size={17} aria-hidden="true" /> : tr("Group emoji")}
    </button>
    {open && <div className="mtg-media-choices" role="group" aria-label={tr("Group emoji pack")}>
      {page && <bdi>{page.title}</bdi>}
      {busy && <span role="status">{tr("Loading group emoji…")}</span>}
      {(page === null || page?.choices.length === 0) && <span role="status">{tr("No group emoji available.")}</span>}
      {page?.choices.map((choice) => <button key={choice.id} type="button" className="mtg-action"
        aria-label={tr("Insert {0}", [choice.emoji])} disabled={disabled || busy} onClick={() => {
          if (insert(choice)) close();
          else setError("Could not insert this emoji at the current selection.");
        }}>{loadArtwork ? <InlineCustomEmoji id={choice.id} label={choice.emoji} load={loadArtwork} /> : choice.emoji}</button>)}
      {page?.next != null && <button type="button" className="mtg-action" disabled={disabled || busy}
        onClick={() => void browse(page.next!, page)}>{tr("More emoji")}</button>}
      {error && <span role="alert">{tr(error)}</span>}
      {error && page === undefined && <button type="button" className="mtg-action" disabled={disabled || busy}
        onClick={() => void browse()}>{tr("Retry")}</button>}
    </div>}
  </div>;
}

export type InstalledEmojiActions = {
  list: () => Promise<{ id: string; title: string }[]>;
  page: (id: string, offset: number) => Promise<GroupEmojiChoicePage | null>;
  library?: StickerPackLibraryActions;
  discovery?: StickerPackDiscoveryActions;
};

export const InstalledEmojiPacks = createContext<InstalledEmojiActions | undefined>(undefined);

export function ComposerEmojiPickers({ group, disabled, insert, manage, compact }: {
  group?: { id: string; load: LoadGroupEmoji };
  manage?: boolean;
  compact?: boolean;
  disabled: boolean;
  insert: (choice: GroupEmojiChoice) => boolean;
}) {
  const actions = useContext(InstalledEmojiPacks);
  return <>
    {actions && <InstalledEmojiPicker actions={actions} disabled={disabled} insert={insert} manage={manage} compact={compact} />}
    {group && <GroupEmojiPicker {...group} disabled={disabled} insert={insert} compact={compact} />}
  </>;
}

function InstalledEmojiPicker({ actions, disabled, insert, manage, compact }: {
  actions: InstalledEmojiActions;
  manage?: boolean;
  compact?: boolean;
  disabled: boolean;
  insert: (choice: GroupEmojiChoice) => boolean;
}) {
  const { t: tr } = useTelegramLocale();
  const loadArtwork = useContext(CustomEmojiLoader);
  const [open, setOpen] = useState(false);
  const [packs, setPacks] = useState<Awaited<ReturnType<InstalledEmojiActions["list"]>>>();
  const [selected, setSelected] = useState("");
  const [page, setPage] = useState<GroupEmojiChoicePage | null>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const request = useRef(0);
  const toggle = useRef<HTMLButtonElement>(null);

  function close() {
    request.current++;
    setOpen(false);
    setBusy(false);
    setPacks(undefined);
    setSelected("");
    setPage(undefined);
    setError("");
  }

  async function loadPacks() {
    const token = ++request.current;
    setBusy(true);
    setError("");
    setSelected("");
    setPage(undefined);
    setPacks(undefined);
    try {
      const list = await actions.list();
      if (token === request.current) setPacks(list);
    } catch {
      if (token === request.current) setError("Could not load your emoji packs.");
    } finally {
      if (token === request.current) setBusy(false);
    }
  }

  async function loadPage(id: string, offset = 0) {
    const token = ++request.current;
    setSelected(id);
    setError("");
    if (!offset) setPage(undefined);
    if (!id) {
      setBusy(false);
      return;
    }
    setBusy(true);
    try {
      const next = await actions.page(id, offset);
      if (token !== request.current) return;
      if (!next || next.id !== id) {
        setPage(null);
        return;
      }
      setPage((previous) => {
        if (!offset || previous?.id !== id) return next;
        const known = new Set(previous.choices.map((choice) => choice.id));
        return { ...next, choices: [...previous.choices, ...next.choices.filter((choice) => !known.has(choice.id))] };
      });
    } catch {
      if (token === request.current) setError("Could not load this emoji pack.");
    } finally {
      if (token === request.current) setBusy(false);
    }
  }

  return <div className="mtg-composer-media" onKeyDown={(event) => {
    if (open && event.key === "Escape" && !event.nativeEvent.isComposing) {
      event.preventDefault();
      event.stopPropagation();
      close();
      toggle.current?.focus();
    }
  }}>
    <button ref={toggle} type="button" className={compact ? "mtg-compose-icon" : "mtg-action"} aria-expanded={open} disabled={disabled}
      aria-label={tr("Emoji packs")} title={tr("Emoji packs")}
      onClick={() => {
        if (open) close();
        else { setOpen(true); void loadPacks(); }
      }}>{compact ? <Smile size={17} aria-hidden="true" /> : tr("Emoji packs")}</button>
    {open && <div className="mtg-media-choices mtg-installed-emoji" role="group" aria-label={tr("Installed emoji packs")}>
      {packs && packs.length > 0 && <label>{tr("Emoji pack ")}<select value={selected} disabled={disabled}
        onChange={(event) => void loadPage(event.currentTarget.value)}>
        <option value="">{tr("Choose an emoji pack")}</option>
        {packs.map(({ id, title }) => <option key={id} value={id}>{title}</option>)}
      </select></label>}
      {busy && <span role="status">{tr("Loading emoji…")}</span>}
      {packs?.length === 0 && <span role="status">{tr("No installed emoji packs.")}</span>}
      {page === null && <span role="status">{tr("This installed emoji pack is unavailable.")}</span>}
      {page?.choices.length === 0 && <span role="status">{tr("No emoji available in this pack.")}</span>}
      {page?.choices.map((choice) => <button key={choice.id} type="button" className="mtg-action"
        aria-label={tr("Insert {0}", [choice.emoji])} disabled={disabled || busy} onClick={() => {
          if (insert(choice)) close();
          else setError("Could not insert this emoji at the current selection.");
        }}>{loadArtwork ? <InlineCustomEmoji id={choice.id} label={choice.emoji} load={loadArtwork} /> : choice.emoji}</button>)}
      {page?.next != null && <button type="button" className="mtg-action" disabled={disabled || busy}
        onClick={() => void loadPage(page.id, page.next!)}>{tr("More emoji")}</button>}
      {error && <span role="alert">{tr(error)}</span>}
      {error && page === undefined && <button type="button" className="mtg-action" disabled={disabled || busy}
        onClick={() => selected ? void loadPage(selected) : void loadPacks()}>{tr("Retry")}</button>}
    </div>}
    {open && manage && actions.discovery && <StickerPackDiscovery emoji actions={actions.discovery} onInstalled={() => void loadPacks()} />}
    {open && manage && actions.library && <StickerPackLibrary emoji actions={actions.library} onChanged={() => void loadPacks()} />}
  </div>;
}
