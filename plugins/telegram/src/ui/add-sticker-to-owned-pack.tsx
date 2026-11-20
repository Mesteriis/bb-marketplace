import { useTelegramLocale } from "./i18n/index.tsx";
import { useState } from "react";
import { newStickerPackTitle, ownedStickerPackName } from "../core/contract.ts";
import type { StickerPackSummary } from "./sticker-pack-order.tsx";

type Page = { sourceFileId: number; packs: StickerPackSummary[]; next: string | null };
export type OwnedStickerDestinations = {
  list: (chatId: string, messageId: string, after?: string) => Promise<Page | null>;
  add: (chatId: string, messageId: string, sourceFileId: number, packId: string, title: string) =>
    Promise<"added" | "already" | "changed" | "unavailable" | "unknown">;
  create?: (chatId: string, messageId: string, sourceFileId: number, name: string, title: string) =>
    Promise<"created" | "nameTaken" | "nameInvalid" | "changed" | "unavailable" | "unknown">;
};

export function AddStickerToOwnedPack({ chatId, messageId, actions }: {
  chatId: string; messageId: string; actions: OwnedStickerDestinations;
}) {
  const { t: tr } = useTelegramLocale();
  const [page, setPage] = useState<Page>();
  const [selected, setSelected] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [draft, setDraft] = useState<{ name: string; title: string }>();
  const selectedPack = page?.packs.find(({ id }) => id === selected);
  const shortName = ownedStickerPackName.safeParse(draft?.name);
  const title = newStickerPackTitle.safeParse(draft?.title);

  async function load(after?: string) {
    setBusy(true);
    setNotice("");
    try {
      const next = await actions.list(chatId, messageId, after);
      if (!next || (after && next.sourceFileId !== page?.sourceFileId)) {
        setPage(undefined);
        setSelected("");
        setNotice("This sticker is unavailable. Reopen the picker to check again.");
        return;
      }
      const packs = new Map((after ? page?.packs ?? [] : []).map(({ id, title }) => [id, title]));
      for (const { id, title } of next.packs) packs.set(id, title);
      setPage({ ...next, packs: [...packs].map(([id, title]) => ({ id, title })), next: next.next === after ? null : next.next });
    } catch {
      setNotice("Could not load your sticker packs.");
    } finally { setBusy(false); }
  }

  async function add() {
    if (!page || !selectedPack || busy) return;
    setBusy(true);
    setNotice("");
    const result = await actions.add(chatId, messageId, page.sourceFileId, selectedPack.id, selectedPack.title).catch(() => "unknown" as const);
    setPage(undefined);
    setSelected("");
    setNotice(result === "added" ? "Sticker added to the pack." : result === "already" ? "This sticker is already in the pack."
      : result === "changed" ? "The sticker or pack changed in Telegram. Reopen the picker." : result === "unavailable"
        ? "Telegram cannot add this sticker to the pack." : "Telegram did not confirm the addition.");
    setBusy(false);
  }

  async function create() {
    if (!page || !actions.create || !shortName.success || !title.success || busy) return;
    setBusy(true);
    setNotice("");
    const result = await actions.create(chatId, messageId, page.sourceFileId, shortName.data, title.data).catch(() => "unknown" as const);
    if (result === "created") {
      setPage(undefined);
      setSelected("");
      setDraft(undefined);
      setNotice(tr("Sticker pack “{0}” created.", [title.data]));
    } else if (result === "changed" || result === "unavailable") {
      setPage(undefined);
      setSelected("");
      setDraft(undefined);
      setNotice("This sticker is unavailable. Reopen the picker to check again.");
    } else {
      setNotice(result === "nameTaken" ? "This Telegram short name is already in use." : result === "nameInvalid"
        ? "Telegram rejected this short name." : "Telegram did not confirm creation. Check My packs for this short name before trying again.");
    }
    setBusy(false);
  }

  return <div>
    {!page ? <button type="button" className="mtg-action" disabled={busy} onClick={() => void load()}>{tr("Add to my sticker pack")}</button>
      : <div role="group" aria-label={tr("Add to my sticker pack")}>
        {draft ? <div role="group" aria-label={tr("Create sticker pack")}>
          <label>{tr("Pack title ")}<input type="text" value={draft.title} maxLength={128} disabled={busy}
            onChange={(event) => setDraft({ ...draft, title: event.currentTarget.value })} /></label>
          <label>{tr("Telegram short name ")}<input type="text" value={draft.name} maxLength={64} disabled={busy}
            onChange={(event) => setDraft({ ...draft, name: event.currentTarget.value })} /></label>
          <p>{tr("The short name appears in the pack’s Telegram link. Use letters A–Z, numbers and underscores.")}</p>
          <button type="button" className="mtg-action" disabled={busy || !shortName.success || !title.success}
            onClick={() => void create()}>{tr("Create pack with this sticker")}</button>
          <button type="button" className="mtg-action" disabled={busy} onClick={() => {
            setDraft(undefined); setNotice("");
          }}>{tr("Back to my packs")}</button>
        </div> : <>
          {page.packs.length > 0 ? <label>{tr("My sticker pack ")}<select value={selected} disabled={busy}
            onChange={(event) => setSelected(event.currentTarget.value)}>
            <option value="">{tr("Choose a pack")}</option>
            {page.packs.map(({ id, title }) => <option key={id} value={id}>{title}</option>)}
          </select></label> : !page.next && <p>{tr("You don’t have a sticker pack with space for this sticker.")}</p>}
          {page.next && <button type="button" className="mtg-action" disabled={busy} onClick={() => void load(page.next!)}>{tr("More of my packs")}</button>}
          {page.packs.length > 0 && <button type="button" className="mtg-action" disabled={!selectedPack || busy}
            onClick={() => void add()}>{tr("Add sticker to pack")}</button>}
          {actions.create && <button type="button" className="mtg-action" disabled={busy} onClick={() => {
            setDraft({ name: "", title: "" }); setNotice("");
          }}>{tr("New sticker pack")}</button>}
          <button type="button" className="mtg-action" disabled={busy} onClick={() => {
            setPage(undefined); setSelected(""); setNotice("");
          }}>{tr("Cancel adding sticker")}</button>
        </>}
      </div>}
    {notice && <p role="status">{tr(notice)}</p>}
  </div>;
}
