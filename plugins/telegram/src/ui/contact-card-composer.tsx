import { useTelegramLocale } from "./i18n/index.tsx";
import { useState } from "react";
import { contactDraft, type ContactDraft } from "../core/contract.ts";

export function ContactCardFields({ draft, update, disabled, required }: {
  draft: ContactDraft; update: (draft: ContactDraft) => void; disabled?: boolean; required?: boolean;
}) {
  const { t: tr } = useTelegramLocale();
  return <>
    <label>{tr("First name ")}<input required={required} maxLength={64} value={draft.firstName} disabled={disabled}
      onChange={(event) => update({ ...draft, firstName: event.currentTarget.value })} /></label>
    <label>{tr("Last name ")}<input maxLength={64} value={draft.lastName} disabled={disabled}
      onChange={(event) => update({ ...draft, lastName: event.currentTarget.value })} /></label>
    <label>{tr("Phone number ")}<input type="tel" required={required} maxLength={64} value={draft.phone} disabled={disabled}
      onChange={(event) => update({ ...draft, phone: event.currentTarget.value })} /></label>
  </>;
}

export function ContactCardComposer({ disabled, scheduled, send }: {
  disabled: boolean;
  scheduled: boolean;
  send: (contact: ContactDraft) => void;
}) {
  const { t: tr } = useTelegramLocale();
  const [draft, setDraft] = useState({ firstName: "", lastName: "", phone: "" });
  const contact = contactDraft.safeParse(draft).data;
  return <form className="mtg-media-attachment-form" onSubmit={(event) => {
    event.preventDefault();
    if (contact && !disabled) send(contact);
  }}>
    <ContactCardFields draft={draft} update={setDraft} disabled={disabled} required />
    {contact && <div role="group" aria-label={tr("Contact card preview")}>
      <bdi>{[contact.firstName, contact.lastName].filter(Boolean).join(" ")}</bdi>{" · "}<bdi dir="ltr">{contact.phone}</bdi>
    </div>}
    <button type="submit" className="mtg-action" disabled={disabled || !contact}>
      {scheduled ? tr("Schedule contact card") : tr("Send contact card")}
    </button>
  </form>;
}
