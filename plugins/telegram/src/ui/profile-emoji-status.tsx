import { useTelegramLocale } from "./i18n/index.tsx";
import { useContext, useEffect, useState } from "react";
import type { ProfileEmojiChange, ProfileEmojiChoice, ProfileEmojiStatus } from "../core/contract.ts";
import { CustomEmojiLoader, InlineCustomEmoji } from "./custom-emoji.tsx";

export function ProfileEmojiStatusView({ status }: { status: ProfileEmojiStatus }) {
  const { locale: uiLocale, t: tr } = useTelegramLocale();
  const load = useContext(CustomEmojiLoader);
  const [expired, setExpired] = useState(false);
  const expiry = status.expiresAt * 1000;
  useEffect(() => {
    if (!expiry) return;
    let timer: ReturnType<typeof setTimeout>;
    function check() {
      const remaining = expiry - Date.now();
      if (remaining <= 0) setExpired(true);
      else timer = setTimeout(check, Math.min(remaining, 2147483647));
    }
    check();
    return () => clearTimeout(timer);
  }, [expiry]);

  if (expired || (expiry && expiry <= Date.now())) return null;
  const date = expiry ? new Date(expiry) : undefined;
  return <>
    <dt>{tr("Emoji status")}</dt>
    <dd>
      {load && <InlineCustomEmoji id={status.emoji} label={status.giftTitle ? "" : tr("Custom emoji")} load={load} />}
      {status.giftTitle ? <bdi>{status.giftTitle}</bdi> : !load && tr("Custom emoji")}
      {date && <> · <time dateTime={date.toISOString()}>{date.toLocaleString(uiLocale)}</time></>}
    </dd>
  </>;
}

export type ProfileEmojiActions = {
  list: () => Promise<ProfileEmojiChoice[]>;
  save: (change: ProfileEmojiChange) => Promise<"saved" | "changed" | "unsupported">;
};

const emojiSections = { themed: "Featured", recent: "Recent", default: "Default", gifts: "Collectible gifts" } as const;
export const emojiStatusDurations = [[0, "Until changed"], [3600, "1 hour"], [14400, "4 hours"], [86400, "1 day"], [604800, "1 week"]] as const;

export function ProfileEmojiEditor({ status, actions, reload }: {
  status: ProfileEmojiStatus | null;
  actions: ProfileEmojiActions;
  reload: () => Promise<void>;
}) {
  const { t: tr } = useTelegramLocale();
  const load = useContext(CustomEmojiLoader);
  const [choices, setChoices] = useState<ProfileEmojiChoice[]>();
  const [selected, setSelected] = useState<ProfileEmojiChoice>();
  const [duration, setDuration] = useState(0);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  async function open() {
    if (busy) return;
    if (choices) { setChoices(undefined); setSelected(undefined); return; }
    setBusy(true);
    setMessage("");
    try { setChoices(await actions.list()); }
    catch { setMessage("Could not load emoji statuses."); }
    finally { setBusy(false); }
  }

  async function save(key: string | null) {
    if (busy) return;
    setBusy(true);
    setMessage("");
    try {
      const result = await actions.save({ key, expected: status, duration: key ? duration : 0 });
      if (result === "saved") {
        setSelected(undefined);
        setChoices(undefined);
        setDuration(0);
        setMessage(key ? "Emoji status updated." : "Emoji status removed.");
        await reload();
      } else if (result === "changed") {
        setMessage("The emoji status changed in Telegram. Review the current status before saving.");
        await reload();
      } else setMessage("Telegram could not apply this emoji status.");
    } catch { setMessage("Could not update or reload your emoji status."); }
    finally { setBusy(false); }
  }

  return <section aria-label={tr("Edit emoji status")}>
    <button type="button" className="mtg-action" aria-expanded={choices !== undefined} disabled={busy}
      onClick={() => void open()}>{tr("Choose emoji status")}</button>
    {status && <button type="button" className="mtg-action" disabled={busy} onClick={() => void save(null)}>{tr("Remove emoji status")}</button>}
    {choices && <div className="mtg-profile-emoji-choices">
      {!choices.length && <p>{tr("No emoji statuses available.")}</p>}
      {Object.entries(emojiSections).map(([section, title]) => {
        const entries = choices.filter((choice) => choice.section === section);
        if (!entries.length) return null;
        return <fieldset key={section}>
          <legend>{title}</legend>
          {entries.map((choice, index) => {
            const label = choice.giftTitle ?? tr("{0} emoji {1}", [title, index + 1]);
            return <button type="button" key={choice.key} className="mtg-action" disabled={busy}
              aria-pressed={selected?.key === choice.key} aria-label={label} onClick={() => setSelected(choice)}>
              {load && choice.emoji ? <InlineCustomEmoji id={choice.emoji} label={label} load={load} /> : label}
            </button>;
          })}
        </fieldset>;
      })}
      {selected && <>
        <label>{tr("Duration ")}<select value={duration} disabled={busy} onChange={(event) => setDuration(Number(event.target.value))}>
          {emojiStatusDurations.map(([seconds, title]) => <option key={seconds} value={seconds}>{title}</option>)}
        </select></label>
        <button type="button" className="mtg-action" disabled={busy} onClick={() => void save(selected.key)}>{tr("Save emoji status")}</button>
      </>}
    </div>}
    {message && <p role="status">{message}</p>}
  </section>;
}
