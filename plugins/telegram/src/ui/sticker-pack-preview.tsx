import { useTelegramLocale } from "./i18n/index.tsx";
import { useContext, useState } from "react";
import type { StickerPackPreviewData } from "../core/contract.ts";
import { CustomEmojiLoader, InlineCustomEmoji } from "./custom-emoji.tsx";
import { CopyReference } from "./copy-message-reference.tsx";

export function StickerPackPreview({ load, install, initial, emoji = false, close }: {
  initial?: StickerPackPreviewData;
  emoji?: boolean;
  close?: () => void;
  load: (offset: number) => Promise<StickerPackPreviewData | null>;
  install?: (id: string) => Promise<"installed" | "unavailable" | "unknown">;
}) {
  const { t: tr } = useTelegramLocale();
  const [pack, setPack] = useState(initial);
  const loadEmoji = useContext(CustomEmojiLoader);
  const packLabel = ((pack ?? initial)?.emoji ?? emoji) ? tr("emoji pack") : tr("sticker pack");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function show(offset: number) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const next = await load(offset);
      if (!next || (offset && (pack?.id !== next.id || pack?.emoji !== next.emoji))) {
        setError(tr("This {0} is unavailable.", [packLabel]));
        return;
      }
      const choices = offset && pack ? [...pack.choices, ...next.choices.filter(({ id }) => !pack.choices.some((choice) => choice.id === id))] : next.choices;
      setPack({ ...next, choices });
    } catch { setError(tr("Could not load this {0}.", [packLabel])); }
    finally { setBusy(false); }
  }

  async function add(id: string) {
    if (!install || busy) return;
    setBusy(true);
    setError("");
    try {
      const result = await install(id);
      if (result === "installed") setPack((previous) => previous && { ...previous, installed: true });
      else setError(result === "unavailable" ? tr("This {0} is unavailable.", [packLabel]) : "Telegram did not confirm installation.");
    } catch { setError("Could not confirm installation."); }
    finally { setBusy(false); }
  }

  return <div>
    {!pack ? <button type="button" className="mtg-action" disabled={busy} onClick={() => void show(0)}>
      {busy ? tr("Loading {0}…", [packLabel]) : tr("Open {0}", [packLabel])}
    </button> : <div role="group" aria-label={pack.emoji ? tr("Emoji pack") : tr("Sticker pack")}>
      <strong><bdi>{pack.title}</bdi></strong>
      {pack.link && <CopyReference label={pack.emoji ? tr("Emoji pack link") : tr("Sticker pack link")} value={pack.link} buttonClass="mtg-action">{tr("Copy ")}{packLabel}{tr(" link")}</CopyReference>}
      <div className="mtg-media-choices">{pack.choices.map(({ id, preview, label, customEmoji }) =>
        customEmoji && loadEmoji ? <span key={id} className="mtg-emoji-pack-preview"><InlineCustomEmoji id={customEmoji} label={label} load={loadEmoji} /></span>
          : preview ? <img key={id} width="48" height="48" loading="lazy" src={`data:${preview.mime};base64,${preview.base64}`} alt={label} />
            : <span key={id}>{label}</span>)}</div>
      {pack.next !== null && <button type="button" className="mtg-action" disabled={busy} onClick={() => void show(pack.next!)}>
        {pack.emoji ? tr("More emoji") : tr("More stickers")}
      </button>}
      {pack.installed ? <span role="status">{pack.emoji ? tr("Emoji pack installed.") : tr("Sticker pack installed.")}</span>
        : install && <button type="button" className="mtg-action" disabled={busy} onClick={() => void add(pack.id)}>{tr("Install ")}{packLabel}</button>}
      <button type="button" className="mtg-action" disabled={busy} onClick={close ?? (() => { setPack(undefined); setError(""); })}>{tr("Close ")}{packLabel}</button>
    </div>}
    {error && <p role="alert">{tr(error)}</p>}
  </div>;
}
