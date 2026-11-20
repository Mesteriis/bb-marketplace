import { useTelegramLocale } from "./i18n/index.tsx";
import { useEffect, useState } from "react";
import { chatMemberInviteLimit, type ChatMemberInviteOutcome, type ContactPage } from "../core/contract.ts";

type Contact = ContactPage["contacts"][number];
const resultLabels = { added: "Added", alreadyMember: "Already a member", changed: "Contact information changed",
  unavailable: "Addition could not be confirmed" } satisfies Record<ChatMemberInviteOutcome, string>;

export type ChatMemberInviteActions = {
  canAdd: (id: string, title: string) => Promise<boolean>;
  load: (query: string, offset?: number) => Promise<ContactPage>;
  add: (id: string, title: string, contacts: Contact[]) => Promise<{ id: string; outcome: ChatMemberInviteOutcome }[]>;
};

export function ChatMemberInvite({ chatId, title, actions }: { chatId: string; title: string; actions: ChatMemberInviteActions }) {
  const { t: tr } = useTelegramLocale();
  const [available, setAvailable] = useState(false);
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [search, setSearch] = useState({ query: "", offset: 0 });
  const [page, setPage] = useState<ContactPage>();
  const [selected, setSelected] = useState<Contact[]>([]);
  const [reviewing, setReviewing] = useState(false);
  const [results, setResults] = useState<{ contact: Contact; outcome: ChatMemberInviteOutcome }[]>([]);
  const [loading, setLoading] = useState(false);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState(false);
  const [feedback, setFeedback] = useState("");

  useEffect(() => {
    let active = true;
    setAvailable(false);
    void actions.canAdd(chatId, title).then((result) => {
      if (active) setAvailable(result);
    }, () => { if (active) setAvailable(false); });
    return () => { active = false; };
  }, [actions, chatId, title]);

  useEffect(() => {
    if (!available || !open) return;
    let active = true;
    setLoading(true);
    setError(false);
    void actions.load(search.query, search.offset).then((result) => {
      if (!active) return;
      setPage((previous) => search.offset && previous
        ? { ...result, contacts: [...new Map([...previous.contacts, ...result.contacts].map((contact) => [contact.id, contact])).values()] }
        : result);
    }, () => { if (active) setError(true); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [actions, available, open, search]);

  async function addSelected() {
    if (!reviewing || !selected.length || adding) return;
    setAdding(true);
    setFeedback("");
    try {
      const result = await actions.add(chatId, title, selected);
      const outcomes = new Map(result.map(({ id, outcome }) => [id, outcome]));
      setResults(selected.map((contact) => ({ contact, outcome: outcomes.get(contact.id) ?? "unavailable" })));
      if (result.some(({ outcome }) => outcome === "changed")) {
        setPage(undefined);
        setSearch((previous) => ({ ...previous, offset: 0 }));
      }
    } catch {
      setFeedback("Telegram did not confirm the addition. Check the member list.");
    } finally {
      setAdding(false);
      setSelected([]);
      setReviewing(false);
    }
  }

  if (!available) return null;
  return <details onToggle={(event) => {
    setOpen(event.currentTarget.open);
    if (!event.currentTarget.open) {
      setSelected([]);
      setReviewing(false);
    }
  }}>
    <summary>{tr("Add contacts to this chat")}</summary>
    {open && <>
      <form className="mtg-composer" onSubmit={(event) => {
        event.preventDefault();
        if (adding || reviewing) return;
        setPage(undefined);
        setFeedback("");
        setSearch({ query: text.trim(), offset: 0 });
      }}>
        <input type="search" aria-label={tr("Find a contact to add")} placeholder={tr("Find a contact")} maxLength={128}
          value={text} disabled={adding || reviewing} onChange={(event) => setText(event.currentTarget.value)} />
        <button type="submit" className="mtg-action" disabled={adding || reviewing}>{tr("Find")}</button>
      </form>
      {loading && <p role="status">{tr("Loading contacts…")}</p>}
      {feedback && <p role="status">{tr(feedback)}</p>}
      {!!results.length && <ul aria-label={tr("Results of adding contacts")}>
        {results.map(({ contact, outcome }) => <li key={contact.id}><bdi>{contact.name}</bdi> · {tr(resultLabels[outcome])}</li>)}
      </ul>}
      {error && <p role="alert">{tr("Could not load Telegram contacts. ")}<button type="button" className="mtg-action"
        onClick={() => setSearch({ ...search })}>{tr("Retry")}</button></p>}
      {page && !page.contacts.length && page.next === null && !loading && !error && <p>{tr("No matching contacts.")}</p>}
      {!!page?.contacts.length && <ul className="mtg-scheduled-list" aria-label={tr("Contacts to add")}>
        {page.contacts.map((contact) => {
          const checked = selected.some(({ id }) => contact.id === id);
          return <li key={contact.id}><label>
            <input type="checkbox" checked={checked}
              disabled={adding || loading || reviewing || (!checked && selected.length >= chatMemberInviteLimit)}
              onChange={(event) => {
                const include = event.currentTarget.checked;
                setSelected((rows) => include ? [...rows, contact] : rows.filter(({ id }) => id !== contact.id));
              }} /> <bdi>{contact.name}</bdi>
          </label></li>;
        })}
      </ul>}
      {page?.next != null && !error && <button type="button" className="mtg-action" disabled={loading || adding || reviewing}
        onClick={() => setSearch({ ...search, offset: page.next! })}>{tr("Load more contacts")}</button>}
      {!!selected.length && <div role="group" aria-label={reviewing ? tr("Confirm adding contacts") : tr("Selected contacts")}>
        {reviewing ? <p>{tr("Add the selected contacts to ")}<bdi>{title}</bdi>?</p> : <p>{tr("Selected contacts (")}{selected.length})</p>}
        <ul>{selected.map(({ id, name }) => <li key={id}><bdi>{name}</bdi>
          {!reviewing && <button type="button" className="mtg-action" aria-label={tr("Remove {0} from selection", [name])}
            onClick={() => setSelected((rows) => rows.filter((row) => row.id !== id))}>{tr("Remove")}</button>}
        </li>)}</ul>
        {reviewing ? <>
          <button type="button" className="mtg-action" disabled={adding} onClick={() => void addSelected()}>{tr("Confirm add members")}</button>
          <button type="button" className="mtg-action" disabled={adding} onClick={() => setReviewing(false)}>{tr("Cancel")}</button>
        </> : <button type="button" className="mtg-action" disabled={loading} onClick={() => {
          setFeedback(""); setResults([]); setReviewing(true);
        }}>{tr("Review selected contacts")}</button>}
      </div>}
    </>}
  </details>;
}
