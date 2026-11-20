import { useTelegramLocale } from "./i18n/index.tsx";
import { useRef, useState } from "react";
import type { ChatBoostPage } from "../core/contract.ts";

export type LoadChatBoostHistory = (id: string, onlyGiftCodes: boolean, offset?: string) => Promise<ChatBoostPage | null>;

const boostSources = { premium: "Telegram Premium", giftCode: "Premium gift code", giveaway: "Giveaway" } as const;

function BoostDate({ seconds }: { seconds: number }) {
  const { locale: uiLocale } = useTelegramLocale();
  const date = new Date(seconds * 1000);
  return <time dateTime={date.toISOString()}>{date.toLocaleDateString(uiLocale)}</time>;
}

export function ChatBoostHistory({ id, load }: { id: string; load: LoadChatBoostHistory }) {
  const { locale: uiLocale, t: tr } = useTelegramLocale();
  const [open, setOpen] = useState(false);
  const [onlyGiftCodes, setOnlyGiftCodes] = useState(false);
  const [page, setPage] = useState<ChatBoostPage>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const cursors = useRef(new Set<string>());

  async function request(filter: boolean, cursor?: string) {
    if (busy) return;
    setBusy(true);
    setError("");
    if (!cursor) {
      cursors.current.clear();
      setPage(undefined);
    }
    try {
      const result = await load(id, filter, cursor);
      if (!result) {
        setPage(undefined);
        setError("Telegram did not make the boost history available.");
        return;
      }
      if (cursor) cursors.current.add(cursor);
      const next = result.next && !cursors.current.has(result.next) ? result.next : null;
      setPage((previous) => ({
        next, boosts: [...new Map([...(cursor ? previous?.boosts ?? [] : []), ...result.boosts].map((row) => [row.id, row])).values()],
      }));
    } catch { setError("Could not load the boost history."); }
    finally { setBusy(false); }
  }

  return <section aria-label={tr("Boost history")}>
    <button type="button" className="mtg-action" aria-expanded={open} disabled={busy} onClick={() => {
      setOpen(!open);
      if (!open) void request(onlyGiftCodes);
    }}>{tr("Boost history")}</button>
    {open && <>
      <label>
        <input type="checkbox" checked={onlyGiftCodes} disabled={busy} onChange={(event) => {
          const filter = event.target.checked;
          setOnlyGiftCodes(filter);
          void request(filter);
        }} />{tr(" Gift codes and giveaways only")}</label>
      {busy && <p role="status">{tr("Loading boosts…")}</p>}
      {error && <p role="alert">{tr(error)}</p>}
      {page?.boosts.length === 0 && <p>{tr("No boosts found.")}</p>}
      {!!page?.boosts.length && <ul aria-label={tr("Boosts applied to this chat")}>
        {page.boosts.map((boost) => <li key={boost.id}>
          {boost.name && <><bdi>{boost.name}</bdi> · </>}
          {boostSources[boost.source]} · {boost.count} {boost.count === 1 ? tr("boost") : tr("boosts")}
          {boost.stars && <> · {boost.stars.toLocaleString(uiLocale)}{tr(" Stars")}</>}
          {boost.unclaimed && tr(" · Unclaimed")}
          {boost.startedAt > 0 && <>{tr(" · Applied ")}<BoostDate seconds={boost.startedAt} /></>}
          {tr(" · Expires ")}<BoostDate seconds={boost.expiresAt} />
        </li>)}
      </ul>}
      {page?.next && <button type="button" className="mtg-action" disabled={busy}
        onClick={() => void request(onlyGiftCodes, page.next!)}>{tr("Load more boosts")}</button>}
    </>}
  </section>;
}
