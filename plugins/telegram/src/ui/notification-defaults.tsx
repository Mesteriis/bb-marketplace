import { ChevronDown } from "lucide-react";
import { useTelegramLocale } from "./i18n/index.tsx";
import { NotificationSoundSelect } from "./notification-sound-select.tsx";
import { useEffect, useState, type ReactNode } from "react";
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

export function NotificationDefaults({ actions, inline = false, exceptions }: {
  actions: NotificationDefaultActions;
  inline?: boolean;
  exceptions?: ReactNode;
}) {
  const { t: tr } = useTelegramLocale();
  const [open, setOpen] = useState(inline);
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

  const storyOptions = stories && <fieldset>
          <legend>{tr("Story notifications")}</legend>
          <label>{tr("Notify about stories from ")}<select value={stories.audience} onChange={(event) => {
            const result = storyNotificationAudience.safeParse(event.currentTarget.value);
            if (result.success) setDraft({ ...draft, stories: { ...stories, audience: result.data } });
          }}>
            <option value="frequent">{tr("Frequent contacts")}</option>
            <option value="all">{tr("All contacts")}</option>
            <option value="none">{tr("Nobody")}</option>
          </select></label>
          <label><input type="checkbox" checked={stories.showAuthor}
            onChange={(event) => setDraft({ ...draft, stories: { ...stories, showAuthor: event.currentTarget.checked } })} />{tr("Show story author")}</label>
          {stories.sound !== undefined && <NotificationSoundSelect label={tr("Story notification sound")} value={stories.sound}
            current={original?.stories?.sound} sounds={draft.savedSounds}
            change={(sound) => setDraft({ ...draft, stories: { ...stories, sound } })} />}
        </fieldset>;

  function additionalOptions() {
    if (!draft) return null;
    return keys.filter((key) => !inline || key !== "preview").map((key) => <label key={key}>
      <input type="checkbox" checked={draft[key]} onChange={(event) => setDraft({ ...draft, [key]: event.currentTarget.checked })} />
      {" "}{tr(labels[key])}
    </label>);
  }

  function chooseScope(next: NotificationScope) {
    if (next === scope) return;
    setOriginal(undefined);
    setDraft(undefined);
    setScope(next);
  }

  const form = <form onSubmit={(event) => { event.preventDefault(); void save(); }}>
      {inline ? <div className="mtg-settings-segments" role="group" aria-label={tr("Chat type")}>
        {notificationScope.options.map((value) =>
          <button type="button" key={value} aria-pressed={scope === value} disabled={busy} onClick={() => chooseScope(value)}>
            {tr(value === "private" ? "Personal" : scopes[value])}
          </button>)}
      </div> : <label>{tr("Chat type ")}<select value={scope} disabled={busy} onChange={(event) => {
        const next = notificationScope.safeParse(event.currentTarget.value);
        if (next.success) chooseScope(next.data);
      }}>
        {notificationScope.options.map((value) => <option key={value} value={value}>{tr(scopes[value])}</option>)}
      </select></label>}
      {!original && !error && <p role="status">{tr("Loading notification defaults…")}</p>}
      {original && draft && <fieldset disabled={busy}>
        <legend className={inline ? "mtg-settings-visually-hidden" : undefined}>{tr("Defaults for ")}{tr(scopes[scope]).toLowerCase()}</legend>
        {inline && <label className="mtg-settings-row">
          <span>{tr(labels.preview)}</span>
          <input type="checkbox" role="switch" checked={draft.preview}
            onChange={(event) => setDraft({ ...draft, preview: event.currentTarget.checked })} />
        </label>}
        {inline && draft.sound !== undefined && <NotificationSoundSelect row label={tr("Sound")} value={draft.sound} current={original.sound}
          sounds={draft.savedSounds} change={(sound) => setDraft({ ...draft, sound })} />}
        {inline && <details className="mtg-settings-notification-extra">
          <summary>{tr("More notification options")}<ChevronDown size={16} aria-hidden="true" /></summary>
          {additionalOptions()}
          {storyOptions}
        </details>}
        {!inline && <>
          {additionalOptions()}
          {storyOptions}
          {draft.sound !== undefined && <NotificationSoundSelect value={draft.sound} current={original.sound}
            sounds={draft.savedSounds} change={(sound) => setDraft({ ...draft, sound })} />}
        </>}
        {(!inline || changed) && <button type="submit" className="mtg-action" data-variant={inline ? "primary" : undefined}
          disabled={!changed}>{tr("Save notification defaults")}</button>}
      </fieldset>}
      {status && <p role="status">{tr(status)}</p>}
      {error && <p role="alert">{tr(error)} <button type="button" className="mtg-action"
        onClick={() => setRevision((value) => value + 1)}>{tr("Reload defaults")}</button></p>}
    </form>;
  if (inline) return <div className="mtg-settings-card mtg-settings-notification-defaults">
    <h3>{tr("Telegram notifications")}</h3>
    {form}
    {exceptions}
  </div>;
  return <details onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary>{tr("Notification defaults")}</summary>
    {open && form}
  </details>;
}
