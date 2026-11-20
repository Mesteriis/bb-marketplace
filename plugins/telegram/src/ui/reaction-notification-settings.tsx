import { useTelegramLocale } from "./i18n/index.tsx";
import { NotificationSoundSelect } from "./notification-sound-select.tsx";
import { useEffect, useState } from "react";
import { reactionNotificationAudience, type ReactionNotifications, type ReactionNotificationOptions } from "../core/contract.ts";

export type ReactionNotificationActions = {
  load: () => Promise<ReactionNotificationOptions | null>;
  save: (values: ReactionNotifications, expected: ReactionNotifications) => Promise<"saved" | "changed" | "unavailable">;
};

const controls = { messages: "Message reactions", stories: "Story reactions", votes: "Poll votes" } as const;
const fields = Object.keys(controls) as (keyof typeof controls)[];
const labels = { none: "Nobody", contacts: "Contacts", all: "Everyone" } as const;

export function ReactionNotificationSettings({ actions }: { actions: ReactionNotificationActions }) {
  const { t: tr } = useTelegramLocale();
  const [open, setOpen] = useState(false);
  const [original, setOriginal] = useState<ReactionNotificationOptions | null>();
  const [draft, setDraft] = useState<ReactionNotificationOptions>();
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    if (!open) return;
    let active = true;
    setOriginal(undefined);
    setDraft(undefined);
    setError("");
    setNotice("");
    void actions.load().then((value) => {
      if (active) { setOriginal(value); setDraft(value ?? undefined); }
    }, () => { if (active) setError("Could not load reaction notifications."); });
    return () => { active = false; };
  }, [actions, open, revision]);

  const changed = !!draft && !!original && (draft.preview !== original.preview || draft.sound !== original.sound || fields.some((field) => draft[field] !== original[field]));

  async function save() {
    if (!draft || !original || !changed || busy) return;
    setBusy(true);
    setNotice("");
    try {
      const { savedSounds: _draftSounds, ...values } = draft;
      const { savedSounds: _originalSounds, ...expected } = original;
      const result = await actions.save(values, expected);
      if (result === "saved") { setOriginal(draft); setNotice("Reaction notifications saved."); }
      else {
        setOriginal(undefined);
        setError(result === "changed" ? "Reaction notifications changed in Telegram." : "Telegram did not accept the change.");
      }
    } catch {
      setOriginal(undefined);
      setError("Telegram did not confirm the change.");
    } finally { setBusy(false); }
  }

  return <details onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary>{tr("Reaction and poll notifications")}</summary>
    {open && <form onSubmit={(event) => { event.preventDefault(); void save(); }}>
      {original === undefined && !error && <p role="status">{tr("Loading reaction notifications…")}</p>}
      {original === null && <p>{tr("Telegram has not supplied reaction notification settings.")}</p>}
      {original && draft && <fieldset disabled={busy}>
        <legend>{tr("Who can trigger a notification")}</legend>
        {fields.map((field) => draft[field] === undefined ? null : <label key={field}>{controls[field]} <select
          value={draft[field]} onChange={(event) => {
            const next = reactionNotificationAudience.safeParse(event.currentTarget.value);
            if (next.success) setDraft({ ...draft, [field]: next.data });
          }}>
          {reactionNotificationAudience.options.map((value) => <option key={value} value={value}>{tr(labels[value])}</option>)}
        </select></label>)}
        <label><input type="checkbox" checked={draft.preview}
          onChange={(event) => setDraft({ ...draft, preview: event.currentTarget.checked })} />{tr(" Show reaction preview")}</label>
        {draft.sound !== undefined && <NotificationSoundSelect value={draft.sound} current={original.sound}
          sounds={draft.savedSounds} change={(sound) => setDraft({ ...draft, sound })} />}
        <button type="submit" className="mtg-action" disabled={!changed}>{tr("Save reaction notifications")}</button>
      </fieldset>}
      {notice && <p role="status">{tr(notice)}</p>}
      {error && <p role="alert">{tr(error)}</p>}
      {(error || original === null) && <button type="button" className="mtg-action"
        onClick={() => setRevision((value) => value + 1)}>{tr("Reload reaction notifications")}</button>}
    </form>}
  </details>;
}
