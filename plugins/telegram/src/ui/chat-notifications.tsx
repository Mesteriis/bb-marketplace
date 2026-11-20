import { useTelegramLocale } from "./i18n/index.tsx";
import { NotificationSoundSelect } from "./notification-sound-select.tsx";
import { Bell } from "lucide-react";
import { useId, useState } from "react";
import { chatMutePeriod, chatMutePeriods, maxChatMuteSeconds, chatNotificationField, chatNotificationOverride, type ChatNotificationField, type ChatNotificationOverride, type ChatNotificationMode, type ChatMutePeriod, type ChatNotificationState } from "../core/contract.ts";

export type ChatNotificationActions = {
  setChatNotificationOverride?: (id: string, field: ChatNotificationField, value: ChatNotificationOverride, expected: ChatNotificationOverride, topicId?: number) => Promise<"updated" | "refused" | "unknown">;
  setChatNotificationSound?: (id: string, value: string, expected: string, topicId?: number, story?: boolean) => Promise<"updated" | "refused" | "unknown">;
  chatNotificationState: (id: string, topicId?: number) => Promise<ChatNotificationState | null>;
  setChatNotificationMode: (id: string, mode: ChatNotificationMode, muteFor?: ChatMutePeriod, topicId?: number) => Promise<"updated" | "refused" | "unknown">;
};

const labels: Record<ChatNotificationMode, string> = {
  default: "Use Telegram defaults",
  muted: "Mute indefinitely",
  unmuted: "Unmute",
};
const durationUnits = { Minutes: 60, Hours: 3600, Days: 86400 } as const;
const periodLabels: Record<(typeof chatMutePeriods)[number], string> = { 3600: "1 hour", 28800: "8 hours", 86400: "1 day", 604800: "7 days" };
const overrideLabels = {
  preview: { title: "Message preview in notifications", show: "Show message text", hide: "Hide message text", save: "Save notification preview" },
  pinned: { title: "Pinned-message notifications", show: "Notify about pins", hide: "Notify as for ordinary messages", save: "Save pin notifications" },
  mentions: { title: "Mention notifications", show: "Notify about mentions", hide: "Notify as for ordinary messages", save: "Save mention notifications" },
  stories: { title: "Story notifications", show: "Notify about stories", hide: "Mute story notifications", save: "Save story notifications" },
  storyPoster: { title: "Author in story notifications", show: "Show story author", hide: "Hide story author", save: "Save story author setting" },
};
const currentLabels: Record<ChatNotificationMode, string> = {
  default: "Using Telegram defaults.",
  muted: "Notifications are muted indefinitely.",
  unmuted: "Notifications are unmuted.",
};

export function ChatNotifications({ id, topicId, community, chatNotificationState, setChatNotificationMode, setChatNotificationOverride, setChatNotificationSound }: ChatNotificationActions & { id: string; topicId?: number; community?: boolean }) {
  const { locale: uiLocale, t: tr } = useTelegramLocale();
  const controls = useId();
  const isTopic = topicId !== undefined;
  const scope = isTopic ? "Topic" : community ? "Community" : "Chat";
  const defaults = isTopic ? "Use group defaults" : labels.default;
  const read = () => isTopic ? chatNotificationState(id, topicId) : chatNotificationState(id);
  const [draft, setDraft] = useState<Partial<Record<ChatNotificationField, ChatNotificationOverride>>>({});
  const [soundDraft, setSoundDraft] = useState<Partial<Record<"sound" | "storySound", string>>>({});
  const [period, setPeriod] = useState<(typeof chatMutePeriods)[number] | "custom">(3600);
  const [duration, setDuration] = useState("");
  const [unit, setUnit] = useState<keyof typeof durationUnits>("Minutes");
  const amount = Number(duration);
  const customSeconds = Number.isInteger(amount) ? chatMutePeriod.safeParse(durationUnits[unit] * amount).data : undefined;
  const muteFor = period === "custom" ? customSeconds : period;
  const [panel, setPanel] = useState<{ current?: ChatNotificationState; busy: boolean; notice?: string }>();
  const until = panel?.current?.muteUntil;
  const deadline = until ? new Date(until * 1000) : undefined;

  async function toggle() {
    if (panel?.busy) return;
    if (panel) { setPanel(undefined); return; }
    setPanel({ busy: true, notice: "Checking notification settings…" });
    const current = await read().catch(() => null);
    setDraft({});
    setSoundDraft({});
    setPanel(current ? { current, busy: false } : { busy: false, notice: "Telegram notification settings are unavailable." });
  }

  async function update(change: () => Promise<"updated" | "refused" | "unknown">) {
    if (!panel?.current || panel.busy) return;
    setPanel({ current: panel.current, busy: true, notice: "Updating notifications…" });
    const result = await change().catch(() => "unknown");
    const current = await read().catch(() => null);
    setDraft({});
    setSoundDraft({});
    setPanel({
      current: current ?? (result === "refused" ? panel.current : undefined),
      busy: false,
      notice: result === "refused" ? "Telegram refused the notification change."
        : result === "unknown" ? "Telegram did not confirm the notification change."
        : current ? undefined : "Notification settings updated. Reopen this section to check the current state.",
    });
  }

  const savedSounds = panel?.current?.savedSounds ?? [];

  return <div className="mtg-chat-notifications">
    <button type="button" className="mtg-chat-archive" aria-label={tr("{0} notification settings", [scope])} title={tr("{0} notification settings", [scope])}
      aria-expanded={!!panel} aria-controls={panel ? controls : undefined} disabled={panel?.busy}
      onClick={() => void toggle()}><Bell size={17} aria-hidden="true" />{tr(" Notifications")}</button>
    {panel && <div id={controls} className="mtg-chat-notification-options" role="group" aria-label={tr("{0} notifications", [scope])}>
      <p role="status">{panel.notice ?? (deadline ? <>{tr("Notifications muted until")}{" "}
        <time dateTime={deadline.toISOString()}>{deadline.toLocaleString(uiLocale)}</time>.</>
        : panel.current?.mode === "default" && isTopic ? tr("Using group defaults.")
        : panel.current && tr(currentLabels[panel.current.mode]))}</p>
      {panel.current && (Object.entries(labels) as Array<[ChatNotificationMode, string]>).map(([mode, label]) =>
        <button key={mode} type="button" className="mtg-action" disabled={panel.busy} onClick={() => void update(() => isTopic ? setChatNotificationMode(id, mode, undefined, topicId) : setChatNotificationMode(id, mode))}>{mode === "default" ? defaults : label}</button>)}
      {panel.current && <div>
        <label>{tr("Mute duration ")}<select value={period} disabled={panel.busy} onChange={(event) => {
          const selected = event.currentTarget.value;
          const value = selected === "custom" ? selected : chatMutePeriods.find((seconds) => seconds === Number(selected));
          if (value !== undefined) setPeriod(value);
        }}>
          {chatMutePeriods.map((seconds) => <option key={seconds} value={seconds}>{tr(periodLabels[seconds])}</option>)}
          <option value="custom">{tr("Custom duration")}</option>
        </select></label>
        {period === "custom" && <>
          <label>{tr("Duration ")}<input type="number" min={1} max={Math.floor(maxChatMuteSeconds / durationUnits[unit])}
            step={1} value={duration} disabled={panel.busy} onChange={(event) => setDuration(event.currentTarget.value)} /></label>
          <label>{tr("Duration unit ")}<select value={unit} disabled={panel.busy} onChange={(event) => {
            const selected = event.currentTarget.value;
            const next = (Object.keys(durationUnits) as Array<keyof typeof durationUnits>).find((key) => key === selected);
            if (next) setUnit(next);
          }}>
            {Object.keys(durationUnits).map((key) => <option key={key}>{key}</option>)}
          </select></label>
        </>}
        <button type="button" className="mtg-action" disabled={panel.busy || muteFor === undefined}
          onClick={() => {
            if (muteFor !== undefined) void update(() => isTopic ? setChatNotificationMode(id, "muted", muteFor, topicId) : setChatNotificationMode(id, "muted", muteFor));
          }}>{tr("Mute for selected duration")}</button>
      </div>}
      {setChatNotificationSound && (["sound", "storySound"] as const).map((field) => {
        const story = field === "storySound";
        const current = panel.current?.[field];
        if (current === undefined || (story && isTopic)) return null;
        const value = soundDraft[field] ?? current;
        const label = story ? tr("Story notification sound") : tr("Notification sound");
        return <div key={field}>
          <NotificationSoundSelect label={label} value={value} current={current} sounds={savedSounds}
            inheritLabel={defaults} disabled={panel.busy} change={(next) => setSoundDraft((draft) => ({ ...draft, [field]: next }))} />
          <button type="button" className="mtg-action" disabled={panel.busy || value === current}
            onClick={() => void update(() => setChatNotificationSound(id, value, current, topicId, story))}>
            {story ? tr("Save story notification sound") : tr("Save notification sound")}
          </button>
        </div>;
      })}
      {setChatNotificationOverride && chatNotificationField.options.map((field) => {
        const current = panel.current?.[field];
        if (!current) return null;
        const value = draft[field] ?? current;
        const fieldLabels = overrideLabels[field];
        return <div key={field}>
          <label>{tr(fieldLabels.title)} <select value={value} disabled={panel.busy} onChange={(event) => {
            const next = chatNotificationOverride.safeParse(event.currentTarget.value);
            if (next.success) setDraft((previous) => ({ ...previous, [field]: next.data }));
          }}>
            <option value="default">{defaults}</option>
            <option value="show">{fieldLabels.show}</option>
            <option value="hide">{fieldLabels.hide}</option>
          </select></label>
          <button type="button" className="mtg-action" disabled={panel.busy || value === current}
            onClick={() => void update(() => isTopic ? setChatNotificationOverride(id, field, value, current, topicId) : setChatNotificationOverride(id, field, value, current))}>{fieldLabels.save}</button>
        </div>;
      })}
    </div>}
  </div>;
}
