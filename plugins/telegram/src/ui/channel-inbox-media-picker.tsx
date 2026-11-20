import { useTelegramLocale } from "./i18n/index.tsx";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { ChannelInboxReply, MediaChoice, MediaChoiceSelection, MediaSendOptions, SendResult } from "../core/contract.ts";
import { MediaChoiceButtons } from "./media-choice-buttons.tsx";
import { MediaSendControls } from "./media-send-controls.tsx";

type Source = { packId: string } | { stickerQuery: string };
export type InboxMediaPicker = {
  choices: (kind: MediaChoiceSelection["kind"], query?: string) => Promise<MediaChoice[]>;
  packs: () => Promise<{ id: string; title: string }[]>;
  packPage: (id: string, offset: number) => Promise<{ choices: MediaChoice[]; next: number | null }>;
  send: (channelId: string, inboxId: string, topicId: string, selection: MediaChoiceSelection, replyTo?: ChannelInboxReply) => Promise<SendResult>;
};

export function ChannelInboxMediaPicker({ kind, actions, reply, disabled, close, send }: {
  kind: MediaChoiceSelection["kind"];
  actions: Pick<InboxMediaPicker, "choices" | "packs" | "packPage">;
  reply: ReactNode;
  disabled: boolean;
  close: () => void;
  send: (selection: MediaChoiceSelection) => Promise<SendResult>;
}) {
  const { t: tr } = useTelegramLocale();
  const { choices, packs, packPage } = actions;
  const [query, setQuery] = useState("");
  const [request, setRequest] = useState<{ source?: Source; offset: number }>({ offset: 0 });
  const [rows, setRows] = useState<MediaChoice[]>([]);
  const [next, setNext] = useState<number | null>(null);
  const [installed, setInstalled] = useState<Awaited<ReturnType<typeof packs>>>();
  const [loadingPacks, setLoadingPacks] = useState(false);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<MediaChoice>();
  const [sending, setSending] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [caption, setCaption] = useState("");
  const [gifOptions, setGifOptions] = useState<MediaSendOptions>();
  const [status, setStatus] = useState("");
  const active = useRef(false);
  const pending = useRef(false);
  const source = request.source;
  const packId = source && "packId" in source ? source.packId : undefined;
  const stickerQuery = source && "stickerQuery" in source ? source.stickerQuery : undefined;
  const label = kind === "gif" ? tr("Saved GIFs") : tr("Stickers");
  const sourceLabel = kind === "gif" ? tr("Saved GIFs") : packId ? tr("Stickers in pack")
    : stickerQuery ? tr("Sticker search results") : tr("Recent and favorite stickers");
  const locked = disabled || sending || uncertain;

  useEffect(() => {
    active.current = true;
    return () => { active.current = false; };
  }, []);

  useEffect(() => {
    let current = true;
    const page = packId ? packPage(packId, request.offset) : choices(kind, stickerQuery).then((choices) => ({ choices, next: null }));
    void page.then(({ choices, next }) => {
      if (!current) return;
      setRows((rows) => request.offset
        ? [...new Map([...rows, ...choices].map((choice) => [choice.id, choice])).values()] : choices);
      setNext(next);
      setLoading(false);
    }, () => {
      if (!current) return;
      setStatus("Could not load Telegram media.");
      setLoading(false);
    });
    return () => { current = false; };
  }, [kind, choices, packPage, packId, request, stickerQuery]);

  function open(source?: Source, offset = 0) {
    if (!offset) {
      setRows([]);
      setNext(null);
      setSelected(undefined);
    }
    setStatus("");
    setLoading(true);
    setRequest({ source, offset });
  }

  async function loadPacks() {
    setLoadingPacks(true);
    setStatus("");
    try {
      const available = await packs();
      if (active.current) setInstalled(available);
    } catch {
      if (active.current) setStatus("Could not load installed sticker packs.");
    } finally {
      if (active.current) setLoadingPacks(false);
    }
  }

  async function submit() {
    if (!selected || locked || loading || pending.current) return;
    pending.current = true;
    setSending(true);
    setStatus("");
    try {
      const gif = kind === "gif" && (caption.trim() || gifOptions?.spoiler)
        ? { caption: caption.trim(), spoiler: gifOptions?.spoiler, captionAbove: gifOptions?.captionAbove } : undefined;
      const outcome = await send({ kind, fileId: selected.id, ...source, gif }).catch(() => ({ state: "unknown" as const }));
      if (!active.current) return;
      if (outcome.state === "sent") close();
      else if (outcome.state === "failed") setStatus("Could not send this media. Your selection is still here.");
      else {
        setUncertain(true);
        setStatus("Telegram did not confirm delivery. Check the conversation before retrying.");
      }
    } finally {
      pending.current = false;
      if (active.current) setSending(false);
    }
  }

  return <fieldset className="mtg-channel-inbox-composer">
    <legend>{label}</legend>
    {reply}
    {kind === "sticker" && <>
      <form className="mtg-media-choices" onSubmit={(event) => {
        event.preventDefault();
        if (query.trim() && !locked && !loading) open({ stickerQuery: query.trim() });
      }}>
        <input type="search" aria-label={tr("Search stickers")} placeholder={tr("Search stickers")} value={query} maxLength={80}
          disabled={locked} onChange={(event) => setQuery(event.currentTarget.value)} />
        <button type="submit" className="mtg-action" disabled={locked || loading || !query.trim()}>{tr("Find stickers")}</button>
      </form>
      {source && <button type="button" className="mtg-action" disabled={locked} onClick={() => open()}>{tr("Recent and favorites")}</button>}
      {installed ? installed.length ? <label>{tr("Sticker pack ")}<select value={packId ?? ""} disabled={locked}
        onChange={(event) => open(event.currentTarget.value ? { packId: event.currentTarget.value } : undefined)}>
        <option value="">{tr("Recent and favorites")}</option>
        {installed.map(({ id, title }) => <option key={id} value={id}>{title}</option>)}
      </select></label> : <p>{tr("No installed sticker packs.")}</p>
        : <button type="button" className="mtg-action" disabled={locked || loadingPacks}
          onClick={() => void loadPacks()}>{loadingPacks ? tr("Loading sticker packs…") : tr("Installed sticker packs")}</button>}
    </>}
    <div className="mtg-media-choices" aria-label={sourceLabel}>
      {loading ? <p role="status">{tr("Loading…")}</p> : !rows.length && !status && <p>{kind === "gif" ? tr("No saved GIFs.") : tr("No stickers to show.")}</p>}
      <MediaChoiceButtons choices={rows} selectedId={selected?.id} disabled={locked || loading} select={setSelected} />
    </div>
    {packId && next !== null && <button type="button" className="mtg-action" disabled={locked || loading}
      onClick={() => open({ packId }, next)}>{tr("More stickers")}</button>}
    {selected && kind === "gif" && <>
      <label>{tr("GIF caption ")}<textarea value={caption} disabled={locked} maxLength={1024}
        onChange={(event) => setCaption(event.currentTarget.value)} /></label>
      <MediaSendControls kind="GIF" options={gifOptions} hasCaption={!!caption.trim()} disabled={locked} change={setGifOptions} />
    </>}
    {selected && <button type="button" className="mtg-action" disabled={locked || loading}
      onClick={() => void submit()}>{kind === "gif" ? tr("Send GIF") : tr("Send sticker")}</button>}
    <button type="button" className="mtg-action" disabled={sending} onClick={close}>{tr("Close ")}{kind === "gif" ? "GIFs" : tr("stickers")}</button>
    {status && <p role="status">{tr(status)}</p>}
    {uncertain && <button type="button" className="mtg-action" onClick={() => {
      setUncertain(false);
      setStatus("");
    }}>{tr("Allow retry")}</button>}
  </fieldset>;
}
