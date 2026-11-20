import { useTelegramLocale } from "./i18n/index.tsx";
import { ChatBoostHistory, type LoadChatBoostHistory } from "./chat-boost-history.tsx";
import { canonicalTelegramBoostLink } from "../core/public-chat-reference.ts";
import { useEffect, useRef, useState } from "react";
import { ProfileEmojiEditor, ProfileEmojiStatusView, type ProfileEmojiActions } from "./profile-emoji-status.tsx";
import { AvatarEditor } from "./avatar-editor.tsx";
import type { DiscussionGroupActions } from "./discussion-group-settings.tsx";
import type { GroupPackActions } from "./group-packs.tsx";
import type { AvatarVideoTrim, ChannelBoostSettingChange, ChannelBoostSettings, ChatBoostInfo, ChatBoostResult, ChatBoostSlot, ChatBoostSlotSnapshot, ChatInfo, ChatInfoChange, GroupUpgradeResult, SaveAvatarResult } from "../core/contract.ts";

type ChatBoostActions = {
  history?: LoadChatBoostHistory;
  saveSetting?: (id: string, change: ChannelBoostSettingChange) => Promise<"saved" | "changed" | "unavailable">;
  list: (id: string) => Promise<ChatBoostSlot[] | null>;
  apply: (id: string, title: string, slots: ChatBoostSlotSnapshot[]) => Promise<ChatBoostResult>;
};

export type ChatInfoActions = {
  groupPacks?: GroupPackActions;
  upgradeGroup?: (id: string, title: string) => Promise<GroupUpgradeResult>;
  discussion?: DiscussionGroupActions;
  boosts?: ChatBoostActions;
  emojiStatuses?: {
    list: (id: string) => ReturnType<ProfileEmojiActions["list"]>;
    save: (id: string, change: Parameters<ProfileEmojiActions["save"]>[0]) => ReturnType<ProfileEmojiActions["save"]>;
  };
  load: (id: string) => Promise<ChatInfo | null>;
  removePhoto?: (id: string, expected: string) => Promise<SaveAvatarResult>;
  savePhoto?: (id: string, base64: string, expected: string | null) => Promise<SaveAvatarResult>;
  saveVideo?: (id: string, base64: string, expected: string | null, coverSeconds: number, trim?: AvatarVideoTrim) => Promise<SaveAvatarResult>;
  save: (id: string, change: ChatInfoChange) => Promise<"saved" | "changed" | "unavailable">;
};

const boostFeatureLabels = {
  emojiStatus: "Emoji status", customBackground: "Custom background", customStickerSet: "Custom emoji sticker set",
  translation: "Automatic translation", transcription: "Voice transcription", noSponsoredMessages: "Disable sponsored messages",
} satisfies Record<ChatBoostInfo["features"][number], string>;

function ChatBoostSummary({ boost, focus }: { boost: ChatBoostInfo; focus: boolean }) {
  const { t: tr } = useTelegramLocale();
  const region = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!focus) return;
    region.current?.focus({ preventScroll: true });
    region.current?.scrollIntoView?.({ block: "start" });
  }, [focus]);
  const link = boost.link && canonicalTelegramBoostLink(boost.link);
  return <section ref={region} aria-label={tr("Chat boosts")} tabIndex={-1}>
    <h3>{tr("Boosts")}</h3>
    <dl>
      <dt>{tr("Level")}</dt><dd>{boost.level}</dd>
      <dt>{tr("Total boosts")}</dt><dd>{boost.count}</dd>
      {boost.applied > 0 && <><dt>{tr("Your boosts")}</dt><dd>{boost.applied}</dd></>}
      {!!boost.next && <><dt>{tr("Boosts to the next level")}</dt><dd>{boost.next - boost.count}</dd></>}
      {!!boost.storiesPerDay && <><dt>{tr("Stories per day")}</dt><dd>{boost.storiesPerDay}</dd></>}
      {!!boost.customReactions && <><dt>{tr("Custom emoji reactions")}</dt><dd>{boost.customReactions}</dd></>}
    </dl>
    {boost.next === 0 && <p>{tr("Maximum level reached.")}</p>}
    {!!boost.features.length && <ul aria-label={tr("Unlocked boost features")}>
      {boost.features.map((feature) => <li key={feature}>{tr(boostFeatureLabels[feature])}</li>)}
    </ul>}
    {link && <a href={link} target="_blank" rel="noopener noreferrer">{tr("Open Telegram boost link")}</a>}
  </section>;
}

function ChatBoostControls({ id, title, actions, reload }: {
  id: string; title: string; actions: ChatBoostActions; reload: () => Promise<void>;
}) {
  const { locale: uiLocale, t: tr } = useTelegramLocale();
  const [slots, setSlots] = useState<ChatBoostSlot[]>();
  const [selected, setSelected] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const now = Date.now() / 1000;
  const isAvailable = (slot: ChatBoostSlot) => slot.source !== id && slot.expiresAt > now && slot.cooldownUntil <= now;
  const selection = slots?.filter((slot) => selected.includes(slot.slot) && isAvailable(slot)) ?? [];
  const transfers = selection.filter((slot) => slot.source).length;
  const formatDate = (seconds: number) => new Date(seconds * 1000).toLocaleString(uiLocale);

  async function open() {
    if (busy) return;
    setSelected([]);
    setMessage("");
    if (slots) { setSlots(undefined); return; }
    setBusy(true);
    try {
      const result = await actions.list(id);
      if (result) setSlots(result);
      else setMessage("Telegram boost slots are unavailable for this chat.");
    } catch { setMessage("Could not load your Telegram boost slots."); }
    finally { setBusy(false); }
  }

  async function apply() {
    if (busy || !selection.length) return;
    setBusy(true);
    setMessage("");
    try {
      const snapshots = selection.map(({ slot, source, expiresAt, cooldownUntil }) => ({ slot, source, expiresAt, cooldownUntil }));
      const result = await actions.apply(id, title, snapshots);
      setSlots(undefined);
      setSelected([]);
      const messages = {
        applied: "Boosts applied.", changed: "The chat or boost slots changed. Review your slots again.",
        unavailable: "Telegram could not apply the selected boosts.", unknown: "Telegram did not confirm the change. Check your boosts before trying again.",
      } satisfies Record<ChatBoostResult, string>;
      setMessage(messages[result]);
      if (result === "applied" || result === "unknown") await reload().catch(() => {});
    } catch {
      setSlots(undefined);
      setSelected([]);
      setMessage("Could not confirm the change. Check your boosts before trying again.");
    } finally { setBusy(false); }
  }

  return <section aria-label={tr("Manage your boosts")}>
    <button type="button" className="mtg-action" aria-expanded={slots !== undefined} disabled={busy}
      onClick={() => void open()}>{tr("Manage boost slots")}</button>
    {slots && <fieldset disabled={busy}>
      <legend>{tr("Boost slots")}</legend>
      {!slots.length && <p>{tr("No boost slots available on this account.")}</p>}
      {slots.map((slot) => <div key={slot.slot}>
        <label>
          <input type="checkbox" disabled={!isAvailable(slot)} checked={selected.includes(slot.slot)}
            onChange={(event) => {
              const checked = event.target.checked;
              setSelected((previous) => checked ? [...previous, slot.slot] : previous.filter((value) => value !== slot.slot));
            }} />
          {slot.source === id ? tr("Applied here") : slot.source ? <>{tr("Transfer from ")}<bdi>{slot.sourceName || tr("chat {0}", [slot.source])}</bdi></> : tr("Unused boost")}
          {tr(" · Expires ")}<time dateTime={new Date(slot.expiresAt * 1000).toISOString()}>{formatDate(slot.expiresAt)}</time>
        </label>
        {slot.source !== id && slot.cooldownUntil > now && <small>{tr(" · Available after ")}{formatDate(slot.cooldownUntil)}</small>}
      </div>)}
      {!!selection.length && <p>{tr("Apply ")}{selection.length} {selection.length === 1 ? tr("boost") : tr("boosts")}{tr(" to ")}<bdi>{title}</bdi>?
        {transfers > 0 && tr(" {0} will be removed from the chats they currently boost.", [transfers])}</p>}
      <button type="button" className="mtg-action" disabled={busy || !selection.length} onClick={() => void apply()}>{tr("Apply selected boosts")}</button>
    </fieldset>}
    {busy && <p role="status">{tr("Checking with Telegram…")}</p>}
    {message && <p role="status">{message}</p>}
  </section>;
}

function ChannelBoostControls({ settings, save, refresh }: {
  settings: ChannelBoostSettings;
  save: (change: ChannelBoostSettingChange) => Promise<"saved" | "changed" | "unavailable">;
  refresh: (change?: ChannelBoostSettingChange) => Promise<void>;
}) {
  const { t: tr } = useTelegramLocale();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const { automaticTranslation, sponsoredMessages } = settings;

  async function update(change: ChannelBoostSettingChange) {
    if (busy) return;
    setBusy(true);
    setNotice("");
    try {
      const result = await save(change);
      if (result === "saved") {
        await refresh(change);
        setNotice("Channel setting saved.");
      } else {
        if (result === "changed") await refresh();
        setNotice(result === "changed" ? "The channel setting changed in Telegram. Review it and try again."
          : "Telegram could not change this setting.");
      }
    } catch { setNotice("Could not update this channel setting."); }
    finally { setBusy(false); }
  }

  return <section aria-label={tr("Boosted channel settings")}>
    {automaticTranslation && <div>
      <label><input type="checkbox" checked={automaticTranslation.enabled}
        disabled={busy || (!automaticTranslation.enabled && !automaticTranslation.canEnable)}
        onChange={(event) => void update({ setting: "automaticTranslation", enabled: event.target.checked,
          expected: automaticTranslation.enabled })} />{tr(" Automatic translation")}</label>
      {!automaticTranslation.enabled && !automaticTranslation.canEnable && <p>{tr("More boosts are needed to enable automatic translation.")}</p>}
    </div>}
    {sponsoredMessages && <div>
      <label><input type="checkbox" checked={sponsoredMessages.enabled}
        disabled={busy || (sponsoredMessages.enabled && !sponsoredMessages.canDisable)}
        onChange={(event) => void update({ setting: "sponsoredMessages", enabled: event.target.checked,
          expected: sponsoredMessages.enabled })} />{tr(" Allow sponsored messages")}</label>
      {sponsoredMessages.enabled && !sponsoredMessages.canDisable && <p>{tr("More boosts are needed to hide sponsored messages.")}</p>}
    </div>}
    {notice && <p role="status">{tr(notice)}</p>}
  </section>;
}

function GroupUpgrade({ id, title, upgrade, migration, openGroup, reload }: {
  id: string; title: string; upgrade?: ChatInfoActions["upgradeGroup"]; migration?: ChatInfo["migration"];
  openGroup?: (id: string, signal: AbortSignal) => Promise<boolean>; reload: () => void;
}) {
  const { t: tr } = useTelegramLocale();
  const [review, setReview] = useState(false);
  const [result, setResult] = useState<GroupUpgradeResult>();
  const [busy, setBusy] = useState(false);
  const [openFailed, setOpenFailed] = useState(false);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  async function confirm() {
    if (!upgrade || request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    const outcome = await upgrade(id, title).catch(() => "unknown" as const);
    if (controller.signal.aborted) return;
    request.current = null;
    setBusy(false);
    setReview(false);
    setResult(outcome);
  }
  async function navigate(group: string) {
    if (!openGroup || request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setOpenFailed(false);
    const opened = await openGroup(group, controller.signal).catch(() => false);
    if (controller.signal.aborted) return;
    request.current = null;
    setBusy(false);
    setOpenFailed(!opened);
  }
  const group = typeof result === "object" ? result.group : migration?.group;
  return <section aria-label={tr("Upgrade group")}>
    {upgrade && !migration && !review && !group && result !== "changed" && result !== "unknown" &&
      <button type="button" className="mtg-action" onClick={() => { setResult(undefined); setReview(true); }}>{tr("Upgrade to supergroup")}</button>}
    {review && <div role="group" aria-label={tr("Confirm group upgrade")}>
      <p>{tr("Upgrade ")}<bdi>{title}</bdi>{tr(" to a supergroup? Telegram permanently deactivates the original group.")}</p>
      <button type="button" className="mtg-action" disabled={busy} onClick={() => setReview(false)}>{tr("Cancel")}</button>
      <button type="button" className="mtg-action" disabled={busy} onClick={() => void confirm()}>{tr("Confirm upgrade")}</button>
    </div>}
    {group && <>
      <p role="status">{migration ? tr("Group moved to") : tr("Supergroup ready")} · <bdi>{group.title}</bdi></p>
      {openGroup && <button type="button" className="mtg-action" disabled={busy} onClick={() => void navigate(group.id)}>{tr("Open supergroup")}</button>}
    </>}
    {migration && !group && <p role="status">{tr("The group was upgraded. Telegram could not load the new chat.")}{" "}
      <button type="button" className="mtg-action" onClick={reload}>{tr("Reload group information")}</button>
    </p>}
    {openFailed && <p role="alert">{tr("Could not open the supergroup.")}</p>}
    {result === "unavailable" && <p role="alert">{tr("Telegram did not allow the upgrade.")}</p>}
    {(result === "changed" || result === "unknown") && <p role="alert">
      {result === "changed" ? tr("Group information changed. Reload it before confirming an upgrade.")
        : tr("Telegram did not confirm the upgrade. Reload group information to check the current state.")}{" "}
      <button type="button" className="mtg-action" onClick={reload}>{tr("Reload group information")}</button>
    </p>}
  </section>;
}

export function ChatInfoPanel({ chatId, actions, startExpanded = false, focusBoosts = false, openUpgradedGroup }: {
  chatId: string; actions: ChatInfoActions; startExpanded?: boolean; focusBoosts?: boolean;
  openUpgradedGroup?: (id: string, signal: AbortSignal) => Promise<boolean>;
}) {
  const { t: tr } = useTelegramLocale();
  const [open, setOpen] = useState(startExpanded);
  const [info, setInfo] = useState<ChatInfo | null>();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    if (!open) return;
    let active = true;
    setInfo(undefined);
    setError("");
    setNotice("");
    void actions.load(chatId).then((value) => {
      if (!active) return;
      setInfo(value);
      setTitle(value?.title ?? "");
      setDescription(value?.description ?? "");
    }, () => { if (active) setError("Could not load chat information."); });
    return () => { active = false; };
  }, [chatId, open, revision, actions]);

  const nextTitle = title.trim();
  const nextDescription = description.trim();
  const titleValid = !!nextTitle && [...nextTitle].length <= 128;
  const descriptionValid = [...nextDescription].length <= 255;
  async function save(field: ChatInfoChange["field"], value: string) {
    if (!info?.editable || busy || info[field] === value) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await actions.save(chatId, { field, value, expected: info[field] });
      if (result === "saved") {
        setInfo({ ...info, [field]: value });
        setNotice(field === "title" ? "Chat name saved." : "Description saved.");
      } else {
        if (result === "changed") setInfo(undefined);
        setError(result === "changed" ? "Chat information changed in Telegram. Reload it before saving."
          : "Telegram did not save the change.");
      }
    } catch { setError("Could not save chat information."); }
    finally { setBusy(false); }
  }

  return <details className="mtg-chat-info" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary>{tr("Group or channel information")}</summary>
    {open && <>
      {info === undefined && !error && <p role="status">{tr("Loading chat information…")}</p>}
      {info === null && <p>{tr("Chat information is unavailable.")}</p>}
      {info && (info.migration ? <GroupUpgrade key={chatId} id={chatId} title={info.title} migration={info.migration}
        openGroup={openUpgradedGroup} reload={() => setRevision((value) => value + 1)} /> : <>
        {info.boosts && <ChatBoostSummary boost={info.boosts} focus={focusBoosts} />}
        {info.canViewBoosts && actions.boosts?.history && <ChatBoostHistory id={chatId} load={actions.boosts.history} />}
        {info.channelBoostSettings && actions.boosts?.saveSetting && <ChannelBoostControls settings={info.channelBoostSettings}
          save={(change) => actions.boosts!.saveSetting!(chatId, change)} refresh={async (change) => {
            if (change) {
              setInfo((previous) => {
                const setting = previous?.channelBoostSettings?.[change.setting];
                return previous && setting ? { ...previous, channelBoostSettings: { ...previous.channelBoostSettings,
                  [change.setting]: { ...setting, enabled: change.enabled } } } : previous;
              });
            } else {
              const fresh = await actions.load(chatId);
              if (fresh) setInfo((previous) => previous && { ...previous, channelBoostSettings: fresh.channelBoostSettings });
            }
          }} />}
        {info.boosts && actions.boosts && <ChatBoostControls id={chatId} title={info.title} actions={actions.boosts}
          reload={async () => {
            const fresh = await actions.load(chatId);
            if (fresh) setInfo((previous) => previous && { ...previous, boosts: fresh.boosts, channelBoostSettings: fresh.channelBoostSettings, canViewBoosts: fresh.canViewBoosts, canSetEmojiStatus: fresh.canSetEmojiStatus });
          }} />}
        {info.emojiStatus && <dl><ProfileEmojiStatusView key={`${info.emojiStatus.emoji}:${info.emojiStatus.expiresAt}`} status={info.emojiStatus} /></dl>}
        {info.canSetEmojiStatus && actions.emojiStatuses && <ProfileEmojiEditor status={info.emojiStatus ?? null}
          actions={{ list: () => actions.emojiStatuses!.list(chatId), save: (change) => actions.emojiStatuses!.save(chatId, change) }}
          reload={async () => {
            const fresh = await actions.load(chatId);
            setInfo((previous) => previous && { ...previous, emojiStatus: fresh?.emojiStatus, canSetEmojiStatus: fresh?.canSetEmojiStatus, boosts: fresh?.boosts });
          }} />}
        <form onSubmit={(event) => { event.preventDefault(); if (titleValid) void save("title", nextTitle); }}>
          <label>{tr("Chat name ")}<input value={title} maxLength={256} disabled={busy} readOnly={!info.editable}
            onChange={(event) => setTitle(event.target.value)} /></label>
          {info.editable && <button type="submit" className="mtg-action"
            disabled={busy || !titleValid || nextTitle === info.title}>{tr("Save chat name")}</button>}
        </form>
        <form onSubmit={(event) => { event.preventDefault(); if (descriptionValid) void save("description", nextDescription); }}>
          <label>{tr("Description ")}<textarea value={description} maxLength={510} disabled={busy} readOnly={!info.editable}
            onChange={(event) => setDescription(event.target.value)} /></label>
          {info.editable && <button type="submit" className="mtg-action"
            disabled={busy || !descriptionValid || nextDescription === info.description}>{tr("Save description")}</button>}
        </form>
        {info.editable && actions.savePhoto && info.photoVersion !== undefined &&
          <AvatarEditor label="chat photo" version={info.photoVersion} disabled={busy}
            save={(base64, expected) => actions.savePhoto!(chatId, base64, expected)}
            saveVideo={actions.saveVideo ? (base64, expected, coverSeconds, trim) => actions.saveVideo!(chatId, base64, expected, coverSeconds, trim) : undefined}
            remove={actions.removePhoto ? (expected) => actions.removePhoto!(chatId, expected) : undefined}
            canRemove={!!info.photoVersion}
            reload={async () => {
              const fresh = await actions.load(chatId);
              return { version: fresh?.photoVersion, canRemove: !!fresh?.editable && !!fresh.photoVersion };
            }} />}
        {info.canUpgrade && actions.upgradeGroup && <GroupUpgrade key={`${chatId}:${info.title}`} id={chatId} title={info.title}
          upgrade={actions.upgradeGroup} openGroup={openUpgradedGroup} reload={() => setRevision((value) => value + 1)} />}
      </>)}
      {error && <p role="alert">{tr(error)} <button type="button" className="mtg-action" disabled={busy}
        onClick={() => setRevision((value) => value + 1)}>{tr("Reload chat information")}</button></p>}
      {notice && <p role="status">{tr(notice)}</p>}
    </>}
  </details>;
}
