import { useTelegramLocale } from "./i18n/index.tsx";
import { useEffect, useState } from "react";
import type { z } from "zod";
import type { schemas } from "../core/contract.ts";

export type StickerPacks = () => Promise<z.infer<typeof schemas.installedStickerPacks.output>>;
export type StickerPage = (packId: string, offset: number) => Promise<z.infer<typeof schemas.stickerPackPage.output>>;
export type StickerChoice = { packId: string; fileId: number; label: string };

export function InstalledStickerPicker({ list, load, busy, choose, label }: {
  list: StickerPacks; load: StickerPage; busy: boolean; label: string; choose: (choice: StickerChoice) => void;
}) {
  const { t: tr } = useTelegramLocale();
  const [packs, setPacks] = useState<Awaited<ReturnType<StickerPacks>> | null>();
  const [packId, setPackId] = useState("");
  const [offsets, setOffsets] = useState([0]);
  const [page, setPage] = useState<Awaited<ReturnType<StickerPage>> | null>();
  const offset = offsets.at(-1) ?? 0;
  useEffect(() => {
    let active = true;
    void list().then((rows) => {
      if (active) { setPacks(rows); setPackId(rows[0]?.id ?? ""); }
    }, () => { if (active) setPacks(null); });
    return () => { active = false; };
  }, [list]);
  useEffect(() => {
    if (!packId) return;
    let active = true;
    void load(packId, offset).then((result) => { if (active) setPage(result); }, () => { if (active) setPage(null); });
    return () => { active = false; };
  }, [load, packId, offset]);
  if (packs === undefined) return <p role="status">{tr("Loading sticker packs…")}</p>;
  if (packs === null) return <p role="alert">{tr("Could not load sticker packs.")}</p>;
  if (!packs.length) return <p>{tr("No installed sticker packs.")}</p>;
  return <div>
    <label>{label} <select value={packId} disabled={busy} onChange={(event) => {
      setPage(undefined); setOffsets([0]); setPackId(event.target.value);
    }}>
      {packs.map(({ id, title }) => <option key={id} value={id}>{title}</option>)}
    </select></label>
    {page === undefined && <p role="status">{tr("Loading stickers…")}</p>}
    {page === null && <p role="alert">{tr("Could not load this sticker pack.")}</p>}
    {page?.choices.length === 0 && <p>{tr("No stickers on this page.")}</p>}
    {page?.choices.map(({ id, label, preview }) => <button key={id} type="button" className="mtg-action" disabled={busy}
      aria-label={tr("Use sticker {0}", [label])} onClick={() => choose({ packId, fileId: id, label })}>
      {preview ? <img alt="" width={40} height={40} src={`data:${preview.mime};base64,${preview.base64}`} /> : <bdi>{label}</bdi>}
    </button>)}
    {offsets.length > 1 && <button type="button" className="mtg-action" disabled={busy} onClick={() => {
      setPage(undefined); setOffsets((previous) => previous.slice(0, -1));
    }}>{tr("Previous stickers")}</button>}
    {page?.next != null && page.next > offset && <button type="button" className="mtg-action" disabled={busy} onClick={() => {
      const next = page.next;
      if (next !== null) { setPage(undefined); setOffsets((previous) => [...previous, next]); }
    }}>{tr("Next stickers")}</button>}
  </div>;
}
