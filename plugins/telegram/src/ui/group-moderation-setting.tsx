import { useTelegramLocale } from "./i18n/index.tsx";
import { useEffect, useState } from "react";

type Setting = { enabled: boolean; editable: boolean };
export type GroupModerationActions = {
  load: (id: string) => Promise<Setting | null>;
  save: (id: string, enabled: boolean, expected: boolean) => Promise<"saved" | "changed" | "unavailable">;
};

const settings = {
  forum: {
    title: "Forum topics", name: "forum topics",
    on: "The group uses forum topics.", off: "The group uses a single conversation.",
    enable: "Enable topics", disable: "Disable topics",
    enabled: "Forum topics enabled.", disabled: "Forum topics disabled.",
  },
  approval: {
    title: "Approve new members", name: "join approval",
    on: "Administrators approve direct join requests.", off: "Direct joins do not require approval.",
    enable: "Require approval to join", disable: "Allow direct joins",
    enabled: "Join approval enabled.", disabled: "Join approval disabled.",
  },
  joinToSend: {
    title: "Join to send messages", name: "join-to-send",
    on: "People must join the discussion group before posting.", off: "Joining is not required to post in discussions.",
    enable: "Require joining to post", disable: "Allow posting without joining",
    enabled: "Joining is required to post.", disabled: "Joining is no longer required to post.",
  },
  members: {
    title: "Member visibility", name: "member visibility",
    on: "Only administrators and bots are visible to non-admins.", off: "The member list is visible.",
    enable: "Hide member list", disable: "Show member list", enabled: "Member list hidden.", disabled: "Member list shown.",
  },
  spam: {
    title: "Aggressive anti-spam", name: "aggressive anti-spam",
    on: "Aggressive anti-spam is on.", off: "Aggressive anti-spam is off.",
    enable: "Enable aggressive anti-spam", disable: "Disable aggressive anti-spam",
    enabled: "Aggressive anti-spam enabled.", disabled: "Aggressive anti-spam disabled.",
  },
  history: {
    title: "History for new members", name: "history visibility",
    on: "New members can see older messages.", off: "Older messages are hidden from new members.",
    enable: "Show history to new members", disable: "Hide history from new members",
    enabled: "History shown to new members.", disabled: "History hidden from new members.",
  },
  content: {
    title: "Content protection", name: "content protection",
    on: "Telegram restricts saving, forwarding, and copying materials from this chat.",
    off: "Content protection is off.",
    enable: "Enable content protection", disable: "Disable content protection",
    enabled: "Content protection enabled.", disabled: "Content protection disabled.",
  },
};

export function GroupModerationSetting({ chatId, actions, kind, onSaved }: {
  chatId: string;
  actions: GroupModerationActions;
  kind: keyof typeof settings;
  onSaved?: (enabled: boolean) => void;
}) {
  const { t: tr } = useTelegramLocale();
  const labels = settings[kind];
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<Setting | null>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    if (!open) return;
    let active = true;
    setView(undefined);
    setError("");
    setNotice("");
    void actions.load(chatId).then((result) => {
      if (active) setView(result);
    }, () => { if (active) setError(tr("Could not load {0}.", [labels.name])); });
    return () => { active = false; };
  }, [actions, chatId, labels, open, revision]);

  async function toggle() {
    if (!view?.editable || busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await actions.save(chatId, !view.enabled, view.enabled);
      if (result === "saved") {
        setView({ ...view, enabled: !view.enabled });
        setNotice(view.enabled ? labels.disabled : labels.enabled);
        onSaved?.(!view.enabled);
      } else {
        setView(undefined);
        setError(result === "changed" ? tr("{0} changed in Telegram.", [labels.title]) : tr("Telegram did not save {0}.", [labels.name]));
      }
    } catch {
      setView(undefined);
      setError(tr("Could not confirm the change to {0}.", [labels.name]));
    } finally {
      setBusy(false);
    }
  }

  return <details onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary>{labels.title}</summary>
    {open && <>
      {view === undefined && !error && <p role="status">{tr("Loading ")}{labels.name}…</p>}
      {view === null && <p>{tr("This chat does not expose ")}{labels.name}{tr(" settings.")}</p>}
      {view && <p>{view.enabled ? labels.on : labels.off}</p>}
      {view?.editable && <button type="button" className="mtg-action" disabled={busy} onClick={() => void toggle()}>
        {view.enabled ? labels.disable : labels.enable}
      </button>}
      {error && <p role="alert">{tr(error)} <button type="button" className="mtg-action" disabled={busy}
        onClick={() => setRevision((value) => value + 1)}>{tr("Reload ")}{labels.name}</button></p>}
      {notice && <p role="status">{tr(notice)}</p>}
    </>}
  </details>;
}
