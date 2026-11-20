import { useTelegramLocale } from "./i18n/index.tsx";
import { createContext, useState } from "react";
import type { PollVoterLoader, PollVoterPage } from "../core/contract.ts";

export const LoadPollVoters = createContext<PollVoterLoader | undefined>(undefined);

export function PollVoters({ option, load }: {
  option: string;
  load: (offset: number) => Promise<PollVoterPage | null>;
}) {
  const { t: tr } = useTelegramLocale();
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<PollVoterPage["entries"]>([]);
  const [next, setNext] = useState<number | null>(0);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  async function loadPage(offset: number) {
    setBusy(true);
    setFailed(false);
    const page = await load(offset).catch(() => null);
    if (page) {
      setEntries((previous) => [...new Map([...previous, ...page.entries]
        .map((entry) => [`${entry.sender.kind}:${entry.sender.id}`, entry])).values()]);
      setNext(page.next !== null && page.next > offset ? page.next : null);
    } else setFailed(true);
    setBusy(false);
  }

  return <div className="mtg-poll-voters">
    <button type="button" aria-expanded={open} aria-label={tr("Voters for {0}", [option])} onClick={() => {
      setOpen(!open);
      if (!open && !busy && next === 0) void loadPage(0);
    }}>{open ? tr("Hide voters") : tr("View voters")}</button>
    {open && <>
      {entries.length > 0 && <ul aria-label={tr("Voters for {0}", [option])}>
        {entries.map(({ sender, name }) => <li key={`${sender.kind}:${sender.id}`}>{name}</li>)}
      </ul>}
      {next === null && entries.length === 0 && <p>{tr("No voters to show.")}</p>}
      {busy && <span role="status">{tr("Loading voters…")}</span>}
      {failed && <span role="alert">{tr("Telegram did not return the voters.")}</span>}
      {next !== null && !busy && (failed || next > 0) && <button type="button"
        onClick={() => void loadPage(next)}>{failed ? tr("Retry") : tr("Load more voters")}</button>}
    </>}
  </div>;
}
