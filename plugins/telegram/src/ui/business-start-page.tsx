import { useTelegramLocale } from "./i18n/index.tsx";
import { useRef, useState, type FormEvent } from "react";
import type { z } from "zod";
import type { schemas } from "../core/contract.ts";
import { InstalledStickerPicker, type StickerChoice, type StickerPacks, type StickerPage } from "./installed-sticker-picker.tsx";

type StartPage = z.infer<typeof schemas.businessStartPage.output>;
type SaveStartPage = (input: z.input<typeof schemas.saveBusinessStartPage.input>) => Promise<z.infer<typeof schemas.saveBusinessStartPage.output>>;


export function BusinessStartPageSettings({ read, save, listPacks, loadPack }: {
  read: () => Promise<StartPage>; save: SaveStartPage; listPacks?: StickerPacks; loadPack?: StickerPage;
}) {
  const { t: tr } = useTelegramLocale();
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<StartPage>();
  const [title, setTitle] = useState("");
  const [message, setMessage] = useState("");
  const [stale, setStale] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [picker, setPicker] = useState(false);
  const [sticker, setSticker] = useState<StickerChoice | null>();
  const tooLong = !!view && ([...title].length > view.titleLimit || [...message].length > view.messageLimit);
  const unchanged = title === view?.title && message === view?.message && sticker === undefined;

  async function load() {
    const current = await read();
    setView(current);
    setTitle(current?.title ?? "");
    setMessage(current?.message ?? "");
    setPicker(false);
    setSticker(undefined);
    setStale(false);
  }

  async function run(work: () => Promise<void>, failure: string) {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try { await work(); }
    catch { setError(failure); }
    finally { pending.current = false; setBusy(false); }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!view?.editable || stale || tooLong || unchanged) return;
    void run(async () => {
      const result = await save({ title, message, revision: view.revision, ...(sticker !== undefined && {
        sticker: sticker && { packId: sticker.packId, fileId: sticker.fileId },
      }) });
      if (result === "saved") {
        setNotice("Start page saved.");
        setStale(true);
        try { await load(); }
        catch { setError("Could not reload the start page. Reload before editing again."); }
      } else if (result === "changed") {
        setError("The start page changed in Telegram. Reload before editing.");
        setStale(true);
      } else if (result === "invalid") setError("Telegram rejected the title, message, or sticker.");
      else setError("The start page cannot be edited for this account.");
    }, "Could not confirm the start page update.");
  }

  return <>
    <h3>{tr("Business start page")}</h3>
    <button type="button" className="mtg-action" disabled={busy} onClick={() => void run(load, "Could not load the Business start page.")}>
      {view === undefined ? tr("Load start page") : tr("Reload start page")}
    </button>
    {view === null && <p>{tr("The Business start page is unavailable for this account.")}</p>}
    {view && <form onSubmit={submit}>
      <label>{tr("Start page title ")}<input value={title} maxLength={1024} disabled={busy || stale || !view.editable}
        onChange={(event) => setTitle(event.target.value)} /></label>
      <label>{tr("Start page message ")}<textarea value={message} maxLength={4096} disabled={busy || stale || !view.editable}
        onChange={(event) => setMessage(event.target.value)} /></label>
      {sticker ? <p>{tr("Greeting sticker selected: ")}<bdi>{sticker.label}</bdi></p> : sticker === null
        ? <p>{tr("The greeting sticker will be removed when you save.")}</p>
        : view.hasSticker && <p>{tr("Current greeting sticker selected.")}</p>}
      {view.editable && !stale && <>
        {listPacks && loadPack && <button type="button" className="mtg-action" disabled={busy} aria-expanded={picker}
          onClick={() => setPicker((open) => !open)}>{picker ? tr("Close sticker picker") : tr("Choose greeting sticker")}</button>}
        {view.hasSticker && sticker === undefined && <button type="button" className="mtg-action" disabled={busy}
          onClick={() => { setSticker(null); setPicker(false); }}>{tr("Remove greeting sticker")}</button>}
        {sticker !== undefined && <button type="button" className="mtg-action" disabled={busy}
          onClick={() => setSticker(undefined)}>{tr("Undo sticker change")}</button>}
        {picker && listPacks && loadPack && <InstalledStickerPicker label={tr("Greeting sticker pack")} list={listPacks} load={loadPack} busy={busy} choose={(choice) => {
          setSticker(choice);
          setPicker(false);
        }} />}
      </>}
      {!view.editable && <p>{tr("This start page cannot be edited in BB.")}</p>}
      {tooLong && <p role="alert">{tr("Use up to ")}{view.titleLimit}{tr(" characters for the title and ")}{view.messageLimit}{tr(" for the message.")}</p>}
      <button type="submit" className="mtg-action" disabled={busy || stale || !view.editable || tooLong
        || unchanged}>{tr("Save start page")}</button>
    </form>}
    {busy && <p role="status">{tr("Updating start page…")}</p>}
    {notice && <p role="status">{tr(notice)}</p>}
    {error && <p role="alert">{tr(error)}</p>}
  </>;
}
