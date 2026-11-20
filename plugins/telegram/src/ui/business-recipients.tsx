import { useTelegramLocale } from "./i18n/index.tsx";
import { useRef, useState } from "react";
import type { BusinessGreeting } from "../core/contract.ts";

export type BusinessRecipientChat = { id: string; name: string };
export const initialBusinessRecipients: BusinessGreeting["recipients"] = {
  chats: [], existing: false, newChats: false, contacts: false, nonContacts: false, exclude: false,
};
const categories = { existing: "Existing private chats", newChats: "New private chats",
  contacts: "Contacts", nonContacts: "People outside contacts" } as const;
export function BusinessRecipientEditor({ label, recipients, knownChats, findRecipients, setRecipients }: {
  label: string; recipients: BusinessGreeting["recipients"]; knownChats: readonly BusinessRecipientChat[];
  findRecipients: (query: string) => Promise<BusinessRecipientChat[]>; setRecipients: (value: BusinessGreeting["recipients"]) => void;
}) {
  const { t: tr } = useTelegramLocale();
  return <fieldset>
    <legend>{label}</legend>
    <label>{tr("Recipient rule ")}<select value={recipients.exclude ? "exclude" : "include"}
      onChange={(event) => setRecipients({ ...recipients, exclude: event.target.value === "exclude" })}>
      <option value="include">{tr("Only selected chats and categories")}</option>
      <option value="exclude">{tr("All private chats except selected")}</option>
    </select></label>
    {Object.entries(categories).map(([key, label]) => {
      const field = key as keyof typeof categories;
      return <label key={field}><input type="checkbox" checked={recipients[field]}
        onChange={(event) => setRecipients({ ...recipients, [field]: event.target.checked })} />{label}</label>;
    })}
    <SelectedPrivateChats selected={recipients.chats} known={knownChats} find={findRecipients}
      change={(chats) => setRecipients({ ...recipients, chats })} />
  </fieldset>;
}

export function SelectedPrivateChats({ selected, known, find, change, label = "Find a private chat" }: {
  label?: string;
  selected: readonly string[]; known: readonly BusinessRecipientChat[]; find: (query: string) => Promise<BusinessRecipientChat[]>; change: (ids: string[]) => void;
}) {
  const { t: tr } = useTelegramLocale();
  const call = useRef(0);
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<BusinessRecipientChat[]>();
  const [names, setNames] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  async function search() {
    const term = query.trim();
    if (!term) return;
    const id = ++call.current;
    setBusy(true);
    setError(false);
    try {
      const rows = await find(term);
      if (call.current !== id) return;
      setMatches(rows);
      setNames((current) => ({ ...current, ...Object.fromEntries(rows.map(({ id, name }) => [id, name])) }));
    } catch { if (call.current === id) setError(true); }
    finally { if (call.current === id) setBusy(false); }
  }
  return <>
    <label>{label} <input type="search" value={query} maxLength={128}
      onChange={(event) => {
        call.current++;
        setQuery(event.target.value); setMatches(undefined); setBusy(false); setError(false);
      }} onKeyDown={(event) => {
        if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); void search(); }
      }} /></label>
    <button type="button" className="mtg-action" disabled={busy || !query.trim()} onClick={() => void search()}>{tr("Find chats")}</button>
    {error && <p role="alert">{tr("Could not find private chats.")}</p>}
    {matches?.length === 0 && <p>{tr("No private chats found.")}</p>}
    {!!matches?.length && <ul aria-label={tr("Matching private chats")}>{matches.map(({ id, name }) => <li key={id}>
      <button type="button" className="mtg-action" disabled={selected.includes(id) || selected.length >= 1000}
        onClick={() => change([...selected, id])}>{tr("Select ")}<bdi>{name}</bdi></button>
    </li>)}</ul>}
    {!!selected.length && <ul aria-label={tr("Selected private chats")}>{selected.map((id) => <li key={id}>
      <button type="button" className="mtg-action" onClick={() => change(selected.filter((entry) => entry !== id))}>{tr("Remove ")}<bdi>{names[id] ?? known.find((row) => row.id === id)?.name ?? tr("Chat {0}", [id])}</bdi>
      </button>
    </li>)}</ul>}
  </>;
}
