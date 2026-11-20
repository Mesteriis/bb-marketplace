import { useTelegramLocale } from "./i18n/index.tsx";
import { useContext, useEffect, useState } from "react";
import { chatReactionPolicy, customEmojiId, reactionKey, type ChatReactionPolicy, type ChatReactionSettings,
  type SelectableReaction } from "../core/contract.ts";
import { CustomEmojiLoader, InlineCustomEmoji } from "./custom-emoji.tsx";

export type ChatReactionActions = {
  load: (id: string) => Promise<ChatReactionSettings | null>;
  save: (id: string, policy: ChatReactionPolicy, expected: ChatReactionPolicy) => Promise<"saved" | "changed" | "unavailable">;
};

export function ChatReactionsSettings({ chatId, actions }: { chatId: string; actions: ChatReactionActions }) {
  const { t: tr } = useTelegramLocale();
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<ChatReactionSettings | null>();
  const [mode, setMode] = useState<"all" | "selected" | "off">("all");
  const [limit, setLimit] = useState(1);
  const [reactions, setReactions] = useState<SelectableReaction[]>([]);
  const [paid, setPaid] = useState(false);
  const [customId, setCustomId] = useState("");
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("");
  const [revision, setRevision] = useState(0);
  const loadEmoji = useContext(CustomEmojiLoader);

  useEffect(() => {
    if (!open) return;
    let active = true;
    setView(undefined);
    void actions.load(chatId).then((current) => {
      if (!active) return;
      setView(current);
      if (!current) return;
      setMode(current.policy.mode === "all" ? "all" : current.policy.reactions.length ? "selected" : "off");
      setLimit(current.policy.limit);
      setReactions(current.policy.mode === "selected" ? current.policy.reactions : []);
      setPaid(current.policy.mode === "selected" && current.policy.paid === true);
      setCustomId("");
    }).catch(() => { if (active) setView(null); });
    return () => { active = false; };
  }, [actions, chatId, open, revision]);

  const draft = chatReactionPolicy.safeParse(mode === "all" ? { mode, limit }
    : { mode: "selected", limit: mode === "off" ? view?.policy.limit ?? 1 : limit, reactions: mode === "off" ? [] : reactions,
      ...(view?.channel && paid && { paid: true }) });
  const emoji = [...new Set([...(view?.activeEmoji ?? []),
    ...reactions.flatMap((reaction) => reaction.kind === "emoji" ? [reaction.emoji] : [])])];
  const validatedId = customEmojiId.safeParse(customId.trim());

  function toggle(reaction: SelectableReaction) {
    const key = reactionKey(reaction);
    setReactions((previous) => previous.some((item) => reactionKey(item) === key)
      ? previous.filter((item) => reactionKey(item) !== key) : [...previous, reaction]);
  }

  async function save() {
    if (!view?.editable || !draft.success || saving || (mode === "selected" && reactions.length === 0)) return;
    setSaving(true);
    setNotice("");
    try {
      const result = await actions.save(chatId, draft.data, view.policy);
      if (result === "saved") {
        setView({ ...view, policy: draft.data });
        setNotice("Reaction settings saved.");
      } else if (result === "changed") {
        setNotice("Telegram settings changed elsewhere. Loaded the current setting.");
        setRevision((value) => value + 1);
      } else setNotice("Telegram did not apply these reaction settings.");
    } catch {
      setNotice("Telegram did not confirm the update.");
    } finally {
      setSaving(false);
    }
  }

  return <details onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary>{tr("Chat reactions")}</summary>
    {open && view === undefined && <p role="status">{tr("Loading reaction settings…")}</p>}
    {open && view === null && <p role="status">{tr("Reaction settings are unavailable for this chat.")}</p>}
    {open && view && <>
      <fieldset disabled={!view.editable || saving}>
        <legend>{tr("Available reactions")}</legend>
        <label>{tr("Reactions ")}<select value={mode} onChange={(event) => setMode(event.currentTarget.value as typeof mode)}>
          <option value="all">{view.channel ? tr("All standard reactions") : tr("All reactions")}</option>
          <option value="selected">{tr("Selected reactions")}</option>
          <option value="off">{view.channel ? tr("No emoji reactions") : tr("Off")}</option>
        </select></label>
        {mode !== "off" && <label>{tr("Maximum reactions per message")}<input type="number" min={1} max={11} step={1} value={Number.isNaN(limit) ? "" : limit}
            onChange={(event) => setLimit(event.currentTarget.valueAsNumber)} />
        </label>}
        {view.channel && mode !== "all" && <label>
          <input type="checkbox" checked={paid} onChange={(event) => setPaid(event.target.checked)} />{tr(" Allow Stars reactions")}</label>}
        {mode === "selected" && <>
          <div className="mtg-reaction-picker" role="group" aria-label={tr("Choose allowed emoji")}>
            {emoji.map((value) => {
              const chosen = reactions.some((reaction) => reaction.kind === "emoji" && reaction.emoji === value);
              return <button type="button" key={value} className="mtg-action" aria-pressed={chosen}
                disabled={!chosen && reactions.length >= 100}
                onClick={() => toggle({ kind: "emoji", emoji: value })}>{value}</button>;
            })}
            {reactions.map((reaction) => reaction.kind === "custom" && <button type="button" key={reaction.id}
              className="mtg-action" aria-pressed="true" aria-label={tr("Remove custom emoji {0}", [reaction.id])}
              onClick={() => toggle(reaction)}>{loadEmoji && <InlineCustomEmoji id={reaction.id} label="✦" load={loadEmoji} />}
              <bdi>{reaction.id}</bdi></button>)}
          </div>
          {view.channel && <div>
            <label>{tr("Custom emoji ID ")}<input value={customId} maxLength={20} onChange={(event) => setCustomId(event.currentTarget.value)} /></label>
            <button type="button" className="mtg-action"
              disabled={!validatedId.success || reactions.length >= 100
                || reactions.some((reaction) => reaction.kind === "custom" && reaction.id === validatedId.data)}
              onClick={() => {
                if (validatedId.success) toggle({ kind: "custom", id: validatedId.data });
                setCustomId("");
              }}>{tr("Add custom emoji")}</button>
          </div>}
        </>}
      </fieldset>
      {view.editable && <button type="button" className="mtg-action"
        disabled={!draft.success || saving || (mode === "selected" && reactions.length === 0)}
        onClick={() => void save()}>{tr("Save reaction settings")}</button>}
      {notice && <p role="status">{tr(notice)}</p>}
    </>}
  </details>;
}
