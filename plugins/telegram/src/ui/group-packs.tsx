import { useTelegramLocale } from "./i18n/index.tsx";
import { useEffect, useRef, useState } from "react";
import type { GroupPackChoice, GroupPackKind, GroupPacksResult, GroupPacksView } from "../core/contract.ts";

export type GroupPackActions = {
  load: (id: string) => Promise<GroupPacksView | null>;
  preview: (id: string, kind: GroupPackKind, reference: string) => Promise<GroupPackChoice | null>;
  save: (id: string, kind: GroupPackKind, expected: string | null, pack: GroupPackChoice | null) => Promise<GroupPacksResult>;
};

function PackSlot({ slot, kind, id, actions, refresh }: {
  slot: NonNullable<GroupPacksView[GroupPackKind]>; kind: GroupPackKind; id: string; actions: GroupPackActions; refresh: () => Promise<void>;
}) {
  const { t: tr } = useTelegramLocale();
  const [reference, setReference] = useState("");
  const [review, setReview] = useState<{ pack: GroupPackChoice | null; expected: string | null; previous: string }>();
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const pending = useRef(false);
  const label = kind === "sticker" ? tr("Sticker pack") : tr("Custom emoji pack");
  const current = slot.id ? slot.title ?? `Telegram pack ${slot.id}` : "None";

  async function find() {
    if (!slot.canSet || !reference.trim() || pending.current) return;
    pending.current = true;
    setBusy(true);
    setStatus("");
    try {
      const pack = await actions.preview(id, kind, reference.trim());
      if (pack) setReview({ pack, expected: slot.id, previous: current });
      else setStatus("Telegram could not find a pack of this type.");
    } catch { setStatus("Could not look up the pack."); }
    finally { pending.current = false; setBusy(false); }
  }

  async function confirm() {
    if (!review || pending.current) return;
    pending.current = true;
    setBusy(true);
    setStatus("");
    try {
      const result = await actions.save(id, kind, review.expected, review.pack);
      setReview(undefined);
      if (result === "saved") {
        setReference("");
        setStatus(review.pack ? "Group pack saved." : "Group pack removed.");
      } else setStatus(result === "changed" ? "The pack or group setting changed. Review the current selection." : "Telegram did not apply the group pack.");
      if (result !== "unavailable") await refresh();
    } catch { setStatus("Could not confirm the group pack change."); }
    finally { pending.current = false; setBusy(false); }
  }

  return <section aria-label={label}>
    <h4>{label}</h4>
    <p>{tr("Current pack · ")}<bdi>{current}</bdi></p>
    {!review && slot.canSet && <form onSubmit={(event) => { event.preventDefault(); void find(); }}>
      <label>{label}{tr(" link or name ")}<input value={reference} maxLength={160} disabled={busy}
        onChange={(event) => setReference(event.currentTarget.value)} /></label>
      <button type="submit" className="mtg-action" disabled={busy || !reference.trim()}>{tr("Find pack")}</button>
    </form>}
    {!review && slot.canRemove && <button type="button" className="mtg-action" disabled={busy}
      onClick={() => setReview({ pack: null, expected: slot.id, previous: current })}>{tr("Remove pack")}</button>}
    {review && <div role="group" aria-label={tr("Confirm {0}", [label.toLowerCase()])}>
      <p>{review.pack ? <>{tr("Set ")}<bdi>{review.pack.title}</bdi>{tr(" as the group pack?")}</> : <>{tr("Remove ")}<bdi>{review.previous}</bdi>?</>}</p>
      {review.pack && review.expected && <p>{tr("This will replace ")}<bdi>{review.previous}</bdi>.</p>}
      <button type="button" className="mtg-action" disabled={busy} onClick={() => setReview(undefined)}>{tr("Cancel")}</button>
      <button type="button" className="mtg-action" disabled={busy} onClick={() => void confirm()}>{review.pack ? tr("Confirm pack") : tr("Confirm removal")}</button>
    </div>}
    {status && <p role="status">{tr(status)}</p>}
  </section>;
}

export function GroupPacks({ id, actions }: { id: string; actions: GroupPackActions }) {
  const { t: tr } = useTelegramLocale();
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<GroupPacksView | null>();
  const current = useRef(false);
  const revision = useRef(0);
  async function refresh() {
    const requested = ++revision.current;
    const value = await actions.load(id).catch(() => null);
    if (current.current && requested === revision.current) setView(value);
  }
  useEffect(() => {
    if (!open) return;
    current.current = true;
    void refresh();
    return () => { current.current = false; revision.current++; };
  }, [open, id, actions]);

  return <details onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary>{tr("Group sticker and emoji packs")}</summary>
    {open && view === undefined && <p role="status">{tr("Loading group packs…")}</p>}
    {open && view === null && <p>{tr("Group packs are unavailable.")}</p>}
    {open && view && (["sticker", "emoji"] as const).map((kind) => view[kind] &&
      <PackSlot key={kind} kind={kind} slot={view[kind]} id={id} actions={actions} refresh={refresh} />)}
  </details>;
}
