import { useTelegramLocale } from "./i18n/index.tsx";
import { useEffect, useMemo, useState } from "react";
import { SuggestProfilePhoto, type SuggestContactPhoto } from "./contact-photo-suggestion.tsx";
import { SecondaryAvatarEditor } from "./secondary-avatar-editor.tsx";
import { ContactBirthdaySuggestion, type SuggestBirthday } from "./contact-birthday-suggestion.tsx";
import { MessageText } from "./message-text.tsx";
import { maxContactNoteLength, type ContactDetails, type ContactNote, type SecondaryAvatarPhoto, type SaveAvatarResult } from "../core/contract.ts";

export type ContactEditorActions = {
  load: (id: string) => Promise<ContactDetails | null>;
  save: (id: string, expected: ContactDetails, names: Pick<ContactDetails, "first" | "last">) => Promise<boolean>;
  remove: (id: string, expected: ContactDetails) => Promise<boolean>;
  personalPhoto?: {
    load: (id: string, userId: string) => Promise<SecondaryAvatarPhoto | null>;
    save: (id: string, userId: string, base64: string, expected: string | null) => Promise<SaveAvatarResult>;
    remove: (id: string, userId: string, expected: string) => Promise<SaveAvatarResult>;
  };
  suggestPhoto?: SuggestContactPhoto;
  suggestBirthday?: SuggestBirthday;
  note?: (id: string) => Promise<ContactNote | null>;
  saveNote?: (id: string, revision: string, text: string) => Promise<"saved" | "changed" | "unavailable">;
};

export function ContactEditor({ chatId, actions }: { chatId: string; actions: ContactEditorActions }) {
  const { t: tr } = useTelegramLocale();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState<ContactDetails | null>();
  const [first, setFirst] = useState("");
  const [last, setLast] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!open) return;
    let active = true;
    setValue(undefined);
    setError("");
    void actions.load(chatId).then((result) => {
      if (!active) return;
      setValue(result);
      setFirst(result?.first ?? "");
      setLast(result?.last ?? "");
    }, () => { if (active) setError("Could not load the contact."); });
    return () => { active = false; };
  }, [actions, chatId, open, revision]);

  async function change(remove: boolean) {
    if (!value || busy) return;
    setBusy(true);
    setError("");
    setStatus("");
    try {
      const applied = remove ? await actions.remove(chatId, value) : await actions.save(chatId, value, { first, last });
      if (!applied) {
        setError("The contact changed or is unavailable. Reload before retrying.");
        return;
      }
      setRevision((current) => current + 1);
      setStatus(remove ? "Contact removed." : "Contact saved.");
    } catch { setError("Telegram could not update this contact."); }
    finally { setBusy(false); setConfirm(false); }
  }

  const canSave = !!(first.trim() || last.trim()) && (!value?.saved || first.trim() !== value.first || last.trim() !== value.last);
  return <details onToggle={(event) => { setOpen(event.currentTarget.open); setConfirm(false); }}>
    <summary>{tr("Contact")}</summary>
    {open && <>
      {value === undefined && !error && <p role="status">{tr("Loading contact…")}</p>}
      {value === null && <p>{tr("Contact editing is unavailable for this chat.")}</p>}
      {value && <form onSubmit={(event) => { event.preventDefault(); if (canSave) void change(false); }}>
        <label>{tr("First name ")}<input maxLength={64} value={first} disabled={busy} onChange={(event) => setFirst(event.target.value)} /></label>
        <label>{tr("Last name ")}<input maxLength={64} value={last} disabled={busy} onChange={(event) => setLast(event.target.value)} /></label>
        <button type="submit" className="mtg-action" disabled={busy || !canSave}>{value.saved ? tr("Save contact name") : tr("Add contact")}</button>
        {value.saved && !confirm && <button type="button" className="mtg-action" disabled={busy}
          onClick={() => setConfirm(true)}>{tr("Remove contact")}</button>}
        {confirm && <>
          <p>{tr("Remove this person from your Telegram contacts?")}</p>
          <button type="button" className="mtg-action" disabled={busy} onClick={() => void change(true)}>{tr("Confirm removal")}</button>
          <button type="button" className="mtg-action" disabled={busy} onClick={() => setConfirm(false)}>{tr("Keep contact")}</button>
        </>}
      </form>}
      {value?.saved && actions.personalPhoto && <ContactPersonalPhoto key={`contact-photo:${chatId}:${value.id}`} chatId={chatId}
        userId={value.id} actions={actions.personalPhoto} disabled={busy} />}
      {value?.saved && actions.suggestPhoto && <SuggestProfilePhoto key={`suggest-photo:${chatId}:${value.id}`}
        id={chatId} userId={value.id} name={[value.first, value.last].filter(Boolean).join(" ") || "this contact"} send={actions.suggestPhoto} />}
      {value?.saved && actions.suggestBirthday && <ContactBirthdaySuggestion key={`contact-birthday:${chatId}:${value.id}`}
        id={chatId} userId={value.id} name={[value.first, value.last].filter(Boolean).join(" ") || "this contact"} send={actions.suggestBirthday} />}
      {value?.saved && actions.note && actions.saveNote && <ContactNoteEditor chatId={chatId} load={actions.note} save={actions.saveNote} />}
      {status && <p role="status">{tr(status)}</p>}
      {error && <p role="alert">{tr(error)} <button type="button" className="mtg-action" onClick={() => setRevision((current) => current + 1)}>{tr("Reload contact")}</button></p>}
    </>}
  </details>;
}

function ContactPersonalPhoto({ chatId, userId, actions, disabled }: {
  chatId: string; userId: string; disabled: boolean; actions: NonNullable<ContactEditorActions["personalPhoto"]>;
}) {
  const { t: tr } = useTelegramLocale();
  const photo = useMemo(() => ({
    load: () => actions.load(chatId, userId),
    save: (base64: string, expected: string | null) => actions.save(chatId, userId, base64, expected),
    remove: (expected: string) => actions.remove(chatId, userId, expected),
  }), [actions, chatId, userId]);
  return <SecondaryAvatarEditor label="personal contact photo" description={tr("Only you see this photo in Telegram.")}
    actions={photo} disabled={disabled} />;
}

function ContactNoteEditor({ chatId, load, save }: {
  chatId: string;
  load: NonNullable<ContactEditorActions["note"]>;
  save: NonNullable<ContactEditorActions["saveNote"]>;
}) {
  const { t: tr } = useTelegramLocale();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState<ContactNote | null>();
  const [text, setText] = useState("");
  const [editing, setEditing] = useState(false);
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState<"saved" | "changed" | "failed" | "loadFailed">();
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!open) return;
    let active = true;
    setNote(undefined);
    void load(chatId).then((value) => {
      if (!active) return;
      setNote(value);
      setText(value?.content?.text ?? "");
    }, () => { if (active) setStatus("loadFailed"); });
    return () => { active = false; };
  }, [chatId, load, open, revision]);

  const length = Array.from(text).length;
  const canSave = note && text !== (note.content?.text ?? "") && length <= note.limit && text.length <= maxContactNoteLength && status !== "changed";
  async function saveDraft() {
    if (!canSave || pending) return;
    setPending(true);
    const result = await save(chatId, note.revision, text).catch(() => "unavailable" as const);
    setPending(false);
    setStatus(result === "unavailable" ? "failed" : result);
    if (result !== "saved") return;
    setEditing(false);
    setRevision((value) => value + 1);
  }

  return <details onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary>{tr("Private contact note")}</summary>
    {open && <>
      {note === undefined && status !== "loadFailed" && <p role="status">{tr("Loading contact note…")}</p>}
      {note === null && <p>{tr("Telegram contact notes are unavailable.")}</p>}
      {note && !editing && <>
        {note.content ? <MessageText {...note.content} /> : <p>{tr("No note for this contact.")}</p>}
        <button type="button" className="mtg-action" onClick={() => { setStatus(undefined); setEditing(true); }}>{tr("Edit contact note")}</button>
      </>}
      {note && editing && <form onSubmit={(event) => { event.preventDefault(); void saveDraft(); }}>
        <label>{tr("Contact note ")}<textarea rows={3} maxLength={maxContactNoteLength} value={text} disabled={pending}
          onChange={(event) => setText(event.currentTarget.value)} /></label>
        <p>{length} / {note.limit}</p>
        <button type="submit" className="mtg-action" disabled={!canSave || pending}>{tr("Save note")}</button>
        <button type="button" className="mtg-action" disabled={pending} onClick={() => {
          setText(note.content?.text ?? ""); setEditing(false); setStatus(undefined);
        }}>{tr("Cancel edit")}</button>
      </form>}
      {status === "saved" && <p role="status">{tr("Contact note saved.")}</p>}
      {status === "failed" && <p role="alert">{tr("Could not save the contact note.")}</p>}
      {(status === "changed" || status === "loadFailed") && <p role="alert">
        {status === "changed" ? tr("The contact note changed in Telegram.") : tr("Could not load the contact note.")}
        <button type="button" className="mtg-action" onClick={() => {
          setStatus(undefined); setEditing(false); setRevision((value) => value + 1);
        }}>{tr("Reload contact note")}</button>
      </p>}
    </>}
  </details>;
}
