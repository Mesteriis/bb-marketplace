import { useTelegramLocale } from "./i18n/index.tsx";
import { useEffect, useRef, useState } from "react";
import { Cake } from "lucide-react";
import { formatBirthdate, isBirthdate, useBirthdayCalendar } from "./contact-birthday.ts";
import type { ContactBirthday, ContactDirectoryPage, ContactPage } from "../core/contract.ts";
import type { Chat } from "../core/demo.ts";

export type ContactActions = {
  load: (query: string, offset?: number) => Promise<ContactPage>;
  birthdays?: () => Promise<ContactBirthday[]>;
  directory?: (initial?: string, offset?: number) => Promise<ContactDirectoryPage>;
  open: (id: string) => Promise<Chat>;
};

export function ContactResults({ query, actions, birthdaysRevision, select }: {
  query: string;
  actions: ContactActions;
  birthdaysRevision?: number;
  select: (chat: Chat) => void;
}) {
  const { t: tr } = useTelegramLocale();
  const [page, setPage] = useState<ContactPage>();
  const [offset, setOffset] = useState<number>();
  const [indexMode, setIndexMode] = useState(false);
  const [initial, setInitial] = useState<string>();
  const [initials, setInitials] = useState<string[]>([]);
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(false);
  const [opening, setOpening] = useState(false);
  const [birthdays, setBirthdays] = useState<ContactBirthday[]>([]);
  const loadBirthdays = actions.birthdays;
  useEffect(() => {
    if (query || !loadBirthdays) return;
    let active = true;
    void loadBirthdays().then((rows) => { if (active) setBirthdays(rows); }, () => { if (active) setBirthdays([]); });
    return () => { active = false; };
  }, [loadBirthdays, query, birthdaysRevision]);
  const [error, setError] = useState("");
  const mounted = useRef(false);
  const list = useRef<HTMLUListElement>(null);
  const directory = !query && indexMode ? actions.directory : undefined;
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    let current = true;
    setLoading(true);
    setError("");
    const timer = setTimeout(() => {
      const load: Promise<ContactPage & { initials?: string[] }> = directory ? directory(initial, offset) : actions.load(query, offset);
      void load.then((result) => {
        if (!current) return;
        if (result.initials) setInitials(result.initials);
        setPage((previous) => {
          if (!offset) return result;
          const rows = new Map(previous?.contacts.map((contact) => [contact.id, contact]));
          for (const contact of result.contacts) rows.set(contact.id, contact);
          return { contacts: [...rows.values()], next: result.next };
        });
      }, () => { if (current) setError("Could not load contacts."); }).finally(() => {
        if (current) setLoading(false);
      });
    }, query ? 250 : 0);
    return () => { current = false; clearTimeout(timer); };
  }, [actions, query, directory, initial, offset, revision]);

  function changeDirectory(nextMode: boolean, nextInitial?: string) {
    setIndexMode(nextMode);
    setInitial(nextInitial);
    setOffset(undefined);
    setPage(undefined);
    if (!nextMode) setInitials([]);
    if (list.current) list.current.scrollTop = 0;
  }

  async function open(id: string) {
    if (opening) return;
    setOpening(true);
    setError("");
    try {
      const chat = await actions.open(id);
      if (mounted.current) select(chat);
    } catch {
      if (mounted.current) setError("Could not open this contact.");
    } finally {
      if (mounted.current) setOpening(false);
    }
  }

  return <ul ref={list} className="mtg-rows" aria-label={tr("Telegram contacts")}>
    {!query && birthdays.length > 0 && <BirthdayContacts contacts={birthdays} disabled={opening} open={open} />}
    {!query && actions.directory && <li className="mtg-contact-index">
      <button type="button" className="mtg-action" aria-pressed={indexMode} onClick={() => changeDirectory(!indexMode)}>{tr("Browse by letter")}</button>
      {indexMode && initials.length > 0 && <label>{tr("Contact initial ")}<select value={initial ?? ""}
        onChange={(event) => changeDirectory(true, event.currentTarget.value || undefined)}>
        <option value="">{tr("All initials")}</option>
        {initials.map((letter) => <option key={letter} value={letter}>{letter === "#" ? tr("Other names") : letter}</option>)}
      </select></label>}
    </li>}
    {loading && !page && <li className="mtg-empty" role="status">{tr("Loading contacts…")}</li>}
    {error && <li className="mtg-empty" role="alert">{tr(error)} <button type="button" className="mtg-action"
      onClick={() => setRevision((value) => value + 1)}>{tr("Refresh contacts")}</button></li>}
    {page && page.contacts.length === 0 && page.next === null && <li className="mtg-empty">{tr("No matching contacts.")}</li>}
    {page?.contacts.map(({ id, name }) => <li key={id}><button type="button" className="mtg-row"
      disabled={opening} onClick={() => void open(id)}><span className="mtg-row-body"><bdi>{name}</bdi></span></button></li>)}
    {page?.next != null && !error && <li className="mtg-history-more"><button type="button" className="mtg-action"
      disabled={loading || opening} onClick={() => setOffset(page.next!)}>{tr("Load more contacts")}</button></li>}
  </ul>;
}

function BirthdayContacts({ contacts, disabled, open }: {
  contacts: ContactBirthday[];
  disabled: boolean;
  open: (id: string) => Promise<void>;
}) {
  const { t: tr } = useTelegramLocale();
  const today = useBirthdayCalendar();
  const rows = contacts.map((contact) => ({ ...contact, today: isBirthdate(contact.birthdate, today) }))
    .sort((left, right) => Number(right.today) - Number(left.today));
  return <li className="mtg-contact-birthdays">
    <section aria-label={tr("Contact birthdays")}>
      <h3><Cake size={16} aria-hidden="true" />{tr(" Contact birthdays")}</h3>
      <ul>{rows.map(({ id, name, birthdate, today }) => <li key={id}>
        <button type="button" className="mtg-row" disabled={disabled} onClick={() => void open(id)}>
          <span className="mtg-row-body"><bdi>{name}</bdi><span>{today ? tr("Birthday today") : formatBirthdate(birthdate)}</span></span>
        </button>
      </li>)}</ul>
    </section>
  </li>;
}
