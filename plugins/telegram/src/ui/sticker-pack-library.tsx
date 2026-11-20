import { useTelegramLocale } from "./i18n/index.tsx";
import { useEffect, useRef, useState, type ComponentProps } from "react";
import { OwnedStickerPacks, type OwnedStickerPackActions } from "./owned-sticker-order.tsx";
import { StickerPackOrder, type StickerPackSummary } from "./sticker-pack-order.tsx";

type Action = "archive" | "restore" | "remove";
type Page = { packs: StickerPackSummary[]; next: string | null };
export type StickerPackLibraryActions = {
  installed: () => Promise<StickerPackSummary[]>;
  archived: (after?: string) => Promise<Page>;
  owned?: OwnedStickerPackActions;
  reorder?: ComponentProps<typeof StickerPackOrder>["save"];
  change: (id: string, action: Action) => Promise<"saved" | "changed" | "unavailable" | "unknown">;
};

export function StickerPackLibrary({ actions, onChanged, emoji = false }: {
  actions: StickerPackLibraryActions; onChanged: () => void; emoji?: boolean;
}) {
  const { t: tr } = useTelegramLocale();
  const packLabel = emoji ? tr("emoji pack") : tr("sticker pack");
  const title = emoji ? "Emoji pack" : "Sticker pack";
  const [ordering, setOrdering] = useState(false);
  const [view, setView] = useState<"installed" | "archived" | "owned">();
  const [page, setPage] = useState<Page>();
  const [revision, setRevision] = useState(0);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState("");
  const [remove, setRemove] = useState<StickerPackSummary>();
  const { installed, archived, change } = actions;
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    if (!view || view === "owned") return;
    let active = true;
    const load = view === "archived" ? archived() : installed().then((packs) => ({ packs, next: null }));
    void load.then((result) => { if (active) setPage(result); }, () => {
      if (active) {
        setPage(undefined);
        setNotice(tr("Could not load {0}s.", [packLabel]));
      }
    });
    return () => { active = false; };
  }, [view, revision, installed, archived, packLabel]);

  function select(next: typeof view) {
    setNotice("");
    setPage(undefined);
    setRemove(undefined);
    setOrdering(false);
    setView(next);
  }

  async function more(after: string) {
    setPending(true);
    setNotice("");
    try {
      const next = await archived(after);
      setPage((previous) => {
        if (previous?.next !== after) return previous;
        const known = new Set(previous.packs.map(({ id }) => id));
        return { packs: [...previous.packs, ...next.packs.filter(({ id }) => !known.has(id))], next: next.next };
      });
    } catch {
      setNotice(tr("Could not load more archived {0}s.", [packLabel]));
    } finally {
      setPending(false);
    }
  }

  async function apply(pack: StickerPackSummary, action: Action) {
    setPending(true);
    setNotice("");
    setRemove(undefined);
    try {
      const result = await change(pack.id, action);
      if (result === "saved") {
        if (mounted.current) onChanged();
        setNotice(`${title} ${action === "restore" ? "restored" : action === "archive" ? "archived" : "removed"}.`);
      } else {
        setNotice(result === "changed" ? tr("This {0} changed in Telegram.", [packLabel]) :
          result === "unavailable" ? "Telegram does not allow this change." : "Could not verify the change in Telegram.");
      }
      setPage(undefined);
      setRevision((value) => value + 1);
    } catch {
      setNotice("Could not verify the change in Telegram.");
    } finally {
      setPending(false);
    }
  }

  const cursor = page?.next;
  return <div className="mtg-media-choices">
    <button type="button" className="mtg-action" disabled={pending || ordering} aria-expanded={!!view}
      onClick={() => select(view ? undefined : "installed")}>{tr("Manage ")}{packLabel}s</button>
    {view && <div role="region" aria-label={tr("{0} management", [title])}>
      <button type="button" className="mtg-action" disabled={pending || ordering} aria-pressed={view === "installed"}
        onClick={() => { if (view !== "installed") select("installed"); }}>{tr("Installed")}</button>
      <button type="button" className="mtg-action" disabled={pending || ordering} aria-pressed={view === "archived"}
        onClick={() => { if (view !== "archived") select("archived"); }}>{tr("Archived")}</button>
      {actions.owned && <button type="button" className="mtg-action" disabled={pending || ordering} aria-pressed={view === "owned"}
        onClick={() => { if (view !== "owned") select("owned"); }}>{tr("My packs")}</button>}
      {view === "owned" && actions.owned ? <OwnedStickerPacks actions={actions.owned}
        onChanged={() => { if (mounted.current) onChanged(); }} /> : <>
      {!page && !notice && <p role="status">{tr("Loading ")}{packLabel}s…</p>}
      {page && !page.packs.length && !page.next && <p>{tr("No ")}{view === "archived" ? tr("archived") : tr("installed")} {packLabel}s.</p>}
      {view === "installed" && page && page.packs.length > 1 && actions.reorder && (ordering
        ? <StickerPackOrder packs={page.packs} save={actions.reorder} emoji={emoji}
          onSaved={(_, packs) => {
            setPage({ packs, next: null });
            setOrdering(false);
            setNotice(tr("{0} order saved.", [title]));
            if (mounted.current) onChanged();
          }} reload={() => { setOrdering(false); setPage(undefined); setRevision((value) => value + 1); }}
          close={() => setOrdering(false)} />
        : <button type="button" className="mtg-action" disabled={pending || !!remove}
          onClick={() => { setNotice(""); setOrdering(true); }}>{tr("Reorder ")}{packLabel}s</button>)}
      {!ordering && !!page?.packs.length && <ul>{page.packs.map((pack) => <li key={pack.id}>
        <span>{pack.title}</span>
        {view === "archived" ?
          <button type="button" className="mtg-action" disabled={pending} aria-label={tr("Restore {0}", [pack.title])}
            onClick={() => void apply(pack, "restore")}>{tr("Restore")}</button> : <>
          <button type="button" className="mtg-action" disabled={pending} aria-label={tr("Archive {0}", [pack.title])}
            onClick={() => void apply(pack, "archive")}>{tr("Archive")}</button>
          <button type="button" className="mtg-action" disabled={pending} aria-label={tr("Remove {0}", [pack.title])}
            onClick={() => setRemove(pack)}>{tr("Remove")}</button>
        </>}
      </li>)}</ul>}
      {remove && <div role="group" aria-label={tr("Remove {0}", [packLabel])}>
        <p>{tr("Remove ")}{remove.title}{tr(" from your ")}{packLabel}s?</p>
        <button type="button" className="mtg-action" onClick={() => setRemove(undefined)}>{tr("Cancel")}</button>
        <button type="button" className="mtg-action" onClick={() => void apply(remove, "remove")}>{tr("Confirm removal")}</button>
      </div>}
      {cursor && <button type="button" className="mtg-action" disabled={pending}
        onClick={() => void more(cursor)}>{tr("More archived packs")}</button>}
      {notice && <p role="status">{tr(notice)}</p>}
      </>}
    </div>}
  </div>;
}
