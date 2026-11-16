import { NotificationSoundSelect } from "./notification-sound-select.tsx";
import { useEffect, useState } from "react";
import { notificationScope, storyNotificationAudience, type NotificationScope, type ScopeNotificationOptions, type ScopeNotifications } from "../core/contract.ts";

export type NotificationDefaultActions = {
  load: (scope: NotificationScope) => Promise<ScopeNotificationOptions>;
  save: (scope: NotificationScope, values: ScopeNotifications, expected: ScopeNotifications) => Promise<"saved" | "changed" | "unavailable">;
};

const scopes: Record<NotificationScope, string> = { private: "Private chats", groups: "Groups", channels: "Channels" };
const labels = {
  muted: "Mute notifications", preview: "Show message previews", pinned: "Notify about pinned messages", mentions: "Notify about mentions",
};
const keys = Object.keys(labels) as (keyof typeof labels)[];

export function NotificationDefaults({ actions }: { actions: NotificationDefaultActions }) {
  const [open, setOpen] = useState(false);
  const [scope, setScope] = useState<NotificationScope>("private");
  const [original, setOriginal] = useState<ScopeNotificationOptions>();
  const [draft, setDraft] = useState<ScopeNotificationOptions>();
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");

  useEffect(() => {
    if (!open) return;
    let active = true;
    setOriginal(undefined);
    setDraft(undefined);
    setError("");
    setStatus("");
    void actions.load(scope).then((value) => {
      if (active) { setOriginal(value); setDraft(value); }
    }, () => { if (active) setError("Could not load notification defaults."); });
    return () => { active = false; };
  }, [actions, open, revision, scope]);

  const stories = draft?.stories;
  const changed = draft && original && (draft.sound !== original.sound || keys.some((key) => draft[key] !== original[key])
    || stories?.audience !== original.stories?.audience || stories?.showAuthor !== original.stories?.showAuthor
    || stories?.sound !== original.stories?.sound);

  async function save() {
    if (!draft || !original || !changed || busy) return;
    setBusy(true);
    setStatus("");
    try {
      const { savedSounds: _draftSounds, ...values } = draft;
      const { savedSounds: _originalSounds, ...expected } = original;
      const result = await actions.save(scope, values, expected);
      if (result === "saved") { setOriginal(draft); setStatus("Notification defaults saved."); }
      else {
        setOriginal(undefined);
        setError(result === "changed" ? "The defaults changed in Telegram." : "Telegram did not accept these defaults.");
      }
    } catch {
      setOriginal(undefined);
      setError("Telegram did not confirm the update.");
    } finally { setBusy(false); }
  }

  return <details onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary>Notification defaults</summary>
    {open && <form onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <label>Chat type <select value={scope} disabled={busy} onChange={(event) => {
        const next = notificationScope.safeParse(event.currentTarget.value);
        if (next.success && next.data !== scope) { setOriginal(undefined); setDraft(undefined); setScope(next.data); }
      }}>
        {notificationScope.options.map((value) => <option key={value} value={value}>{scopes[value]}</option>)}
      </select></label>
      {!original && !error && <p role="status">Loading notification defaults…</p>}
      {original && draft && <fieldset disabled={busy}>
        <legend>Defaults for {scopes[scope].toLowerCase()}</legend>
        {keys.map((key) => <label key={key}><input type="checkbox" checked={draft[key]}
          onChange={(event) => setDraft({ ...draft, [key]: event.currentTarget.checked })} /> {labels[key]}</label>)}
        {draft.sound !== undefined && <NotificationSoundSelect value={draft.sound} current={original.sound}
          sounds={draft.savedSounds} change={(sound) => setDraft({ ...draft, sound })} />}
        {stories && <fieldset>
          <legend>Story notifications</legend>
          <label>Notify about stories from <select value={stories.audience} onChange={(event) => {
            const result = storyNotificationAudience.safeParse(event.currentTarget.value);
            if (result.success) setDraft({ ...draft, stories: { ...stories, audience: result.data } });
          }}>
            <option value="frequent">Frequent contacts</option>
            <option value="all">All contacts</option>
            <option value="none">Nobody</option>
          </select></label>
          <label><input type="checkbox" checked={stories.showAuthor}
            onChange={(event) => setDraft({ ...draft, stories: { ...stories, showAuthor: event.currentTarget.checked } })} />
            Show story author</label>
          {stories.sound !== undefined && <NotificationSoundSelect label="Story notification sound" value={stories.sound}
            current={original.stories?.sound} sounds={draft.savedSounds}
            change={(sound) => setDraft({ ...draft, stories: { ...stories, sound } })} />}
        </fieldset>}
        <button type="submit" className="mtg-action" disabled={!changed}>Save notification defaults</button>
      </fieldset>}
      {status && <p role="status">{status}</p>}
      {error && <p role="alert">{error} <button type="button" className="mtg-action"
        onClick={() => setRevision((value) => value + 1)}>Reload defaults</button></p>}
    </form>}
  </details>;
}
