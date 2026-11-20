import { useTelegramLocale } from "./i18n/index.tsx";
import { ProfileEmojiEditor, ProfileEmojiStatusView, type ProfileEmojiActions } from "./profile-emoji-status.tsx";
import { CopyReference, CopyTelegramPublicLink, TelegramLinkQr } from "./copy-message-reference.tsx";
import { useEffect, useState } from "react";
import { ProfilePhotos, type ProfilePhotoActions } from "./profile-photos.tsx";
import { AvatarEditor } from "./avatar-editor.tsx";
import { telegramBirthdate, type GiftReceivingSettings, type AvatarVideoTrim, type SaveAvatarResult, type ProfileChange, type TelegramProfile as Profile, type UsernameCheck } from "../core/contract.ts";
import { ProfileAudio, type ProfileAudioActions } from "./profile-audio.tsx";
import { PersonalChannel, type PersonalChannelActions } from "./personal-channel.tsx";

export type ProfileActions = {
  load: () => Promise<Profile>;
  createTemporaryLink?: () => Promise<{ url: string; expiresIn: number } | null>;
  photos?: ProfilePhotoActions;
  personalChannel?: PersonalChannelActions;
  emojiStatuses?: ProfileEmojiActions;
  removePhoto?: (expected: string) => Promise<SaveAvatarResult>;
  savePhoto?: (base64: string, expected: string | null) => Promise<SaveAvatarResult>;
  saveVideo?: (base64: string, expected: string | null, coverSeconds: number, trim?: AvatarVideoTrim) => Promise<SaveAvatarResult>;
  check: (username: string) => Promise<UsernameCheck>;
  save: (change: ProfileChange) => Promise<"saved" | "changed" | "unsupported">;
};

function TemporaryProfileLink({ create }: { create: NonNullable<ProfileActions["createTemporaryLink"]> }) {
  const { locale: uiLocale, t: tr } = useTelegramLocale();
  const [link, setLink] = useState<{ url: string; expiresAt: number }>();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");

  useEffect(() => {
    if (!link) return;
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      const remaining = link.expiresAt - Date.now();
      if (remaining <= 0) {
        setLink(undefined);
        setNotice("This profile link has expired.");
      } else timer = setTimeout(schedule, Math.min(remaining, 2147483647));
    };
    schedule();
    return () => clearTimeout(timer);
  }, [link]);

  async function generate() {
    if (busy) return;
    const requestedAt = Date.now();
    setBusy(true);
    setLink(undefined);
    setNotice("");
    try {
      const result = await create();
      if (result) setLink({ url: result.url, expiresAt: requestedAt + result.expiresIn * 1000 });
      else setNotice("Telegram did not provide a temporary profile link.");
    } catch { setNotice("Could not generate a temporary profile link."); }
    finally { setBusy(false); }
  }

  return <section aria-label={tr("Temporary Telegram profile link")}>
    <button type="button" className="mtg-action" disabled={busy} onClick={() => void generate()}>
      {busy ? tr("Generating link…") : link ? tr("Generate new temporary link") : tr("Generate temporary profile link")}
    </button>
    {notice && <p role="status">{tr(notice)}</p>}
    {link && <div key={link.url}>
      <p>{tr("Expires ")}<time dateTime={new Date(link.expiresAt).toISOString()}>{new Date(link.expiresAt).toLocaleString(uiLocale)}</time></p>
      <CopyReference label={tr("Temporary profile link")} value={link.url} buttonClass="mtg-action">{tr("Copy link")}</CopyReference>
      <TelegramLinkQr url={link.url} label={tr("QR code for temporary profile link")} imageLabel={tr("Temporary Telegram profile link QR code")} />
    </div>}
  </section>;
}

const acceptedGiftLabels = {
  unlimited_gifts: "Unlimited gifts",
  limited_gifts: "Limited gifts",
  upgraded_gifts: "Collectible gifts",
  gifts_from_channels: "Gifts from channels",
  premium_subscription: "Telegram Premium gifts",
} satisfies Record<keyof GiftReceivingSettings["accepted"], string>;

export function TelegramProfile({ actions, music }: { actions: ProfileActions; music?: ProfileAudioActions }) {
  const { t: tr } = useTelegramLocale();
  const [open, setOpen] = useState(false);
  const [profile, setProfile] = useState<Profile>();
  const [first, setFirst] = useState("");
  const [last, setLast] = useState("");
  const [bio, setBio] = useState("");
  const [username, setUsername] = useState("");
  const [day, setDay] = useState("");
  const [month, setMonth] = useState("");
  const [year, setYear] = useState("");
  const [giftDraft, setGiftDraft] = useState<GiftReceivingSettings>();
  const [availability, setAvailability] = useState("");
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    if (!open) return;
    let active = true;
    setProfile(undefined);
    setError("");
    void actions.load().then((result) => {
      if (!active) return;
      setProfile(result);
      setFirst(result.first);
      setLast(result.last);
      setBio(result.bio);
      setUsername(result.username);
      setDay(result.birthdate ? String(result.birthdate.day) : "");
      setMonth(result.birthdate ? String(result.birthdate.month) : "");
      setYear(result.birthdate?.year ? String(result.birthdate.year) : "");
      setGiftDraft(result.giftSettings?.values);
      setAvailability("");
    }, () => { if (active) setError("Could not load your profile."); });
    return () => { active = false; };
  }, [actions, open, revision]);

  async function save(change: ProfileChange) {
    if (busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await actions.save(change);
      if (result === "saved") {
        setProfile((previous) => previous && (change.kind === "name"
          ? { ...previous, first: change.first, last: change.last }
          : change.kind === "bio" ? { ...previous, bio: change.bio }
          : change.kind === "username" ? { ...previous, username: change.username }
          : change.kind === "birthdate" ? { ...previous, birthdate: change.birthdate }
          : previous.giftSettings ? { ...previous, giftSettings: { ...previous.giftSettings, values: change.values } } : previous));
        if (change.kind === "birthdate" && !change.birthdate) {
          setDay("");
          setMonth("");
          setYear("");
        }
        setNotice("Profile updated.");
      } else setError(result === "changed" ? "The profile changed in Telegram. Reload before saving." : "Telegram could not apply this change.");
    } catch { setError("Could not update your profile."); }
    finally { setBusy(false); }
  }

  const editable = username.trim().replace(/^@/, "");
  const usernameChanged = editable !== profile?.username;
  const usernameValid = !editable || /^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(editable) && !editable.endsWith("_");
  async function check() {
    if (!editable || busy || !usernameValid) return;
    setBusy(true);
    setAvailability("");
    const labels = { available: "Available", taken: "Already taken", invalid: "Invalid username",
      collectible: "Collectible username", unavailable: "Availability could not be checked" };
    try { setAvailability(labels[await actions.check(editable)]); }
    catch { setAvailability(labels.unavailable); }
    finally { setBusy(false); }
  }

  const birthdate = telegramBirthdate.safeParse({ day: Number(day), month: Number(month), year: Number(year) });
  const birthdateChanged = birthdate.success && (birthdate.data.day !== profile?.birthdate?.day
    || birthdate.data.month !== profile?.birthdate?.month || birthdate.data.year !== profile?.birthdate?.year);
  const nameChanged = !!first.trim() && (first.trim() !== profile?.first || last.trim() !== profile?.last);
  const bioLength = Array.from(bio).length;
  return <details onToggle={(event) => { setOpen(event.currentTarget.open); setNotice(""); }}>
    <summary>{tr("Profile")}</summary>
    {open && <>
      {!profile && !error && <p role="status">{tr("Loading profile…")}</p>}
      {actions.personalChannel && <PersonalChannel actions={actions.personalChannel} />}
      {profile && <>
        {profile.emojiStatus && <dl><ProfileEmojiStatusView key={`${profile.emojiStatus.emoji}:${profile.emojiStatus.expiresAt}`} status={profile.emojiStatus} /></dl>}
        {profile.canSetEmojiStatus && actions.emojiStatuses && <ProfileEmojiEditor status={profile.emojiStatus ?? null}
          actions={actions.emojiStatuses} reload={async () => {
            const fresh = await actions.load();
            setProfile((previous) => previous && { ...previous, emojiStatus: fresh.emojiStatus, canSetEmojiStatus: fresh.canSetEmojiStatus });
          }} />}
        {profile.photoVersion !== undefined && actions.savePhoto &&
          <AvatarEditor key={profile.photoVersion ?? ""} label="profile photo" version={profile.photoVersion} disabled={busy}
            save={actions.savePhoto} remove={actions.removePhoto} canRemove={profile.canRemovePhoto === true}
            saveVideo={actions.saveVideo}
            reload={async () => {
              const fresh = await actions.load();
              return { version: fresh.photoVersion, canRemove: fresh.canRemovePhoto === true };
            }} />}
        {actions.photos && <ProfilePhotos id="self" actions={actions.photos} updated={async () => {
          const fresh = await actions.load();
          setProfile((previous) => previous && { ...previous, photoVersion: fresh.photoVersion, canRemovePhoto: fresh.canRemovePhoto });
        }} />}
        <form onSubmit={(event) => {
          event.preventDefault();
          if (nameChanged) void save({ kind: "name", first: first.trim(), last: last.trim(), expectedFirst: profile.first, expectedLast: profile.last });
        }}>
          <label>{tr("First name ")}<input value={first} maxLength={64} disabled={busy} onChange={(event) => setFirst(event.target.value)} /></label>
          <label>{tr("Last name ")}<input value={last} maxLength={64} disabled={busy} onChange={(event) => setLast(event.target.value)} /></label>
          <button type="submit" className="mtg-action" disabled={busy || !nameChanged}>{tr("Save profile name")}</button>
        </form>
        <form onSubmit={(event) => {
          event.preventDefault();
          if (profile.bioEditable && bio !== profile.bio && bioLength <= profile.bioLimit) void save({ kind: "bio", bio, expectedBio: profile.bio });
        }}>
          <label>{tr("Bio ")}<input value={bio} disabled={busy || !profile.bioEditable}
            onChange={(event) => setBio(event.target.value)} /></label>
          <p>{bioLength} / {profile.bioLimit}</p>
          {!profile.bioEditable && <p>{tr("Formatted bio editing is unavailable in BB.")}</p>}
          <button type="submit" className="mtg-action" disabled={busy || !profile.bioEditable || bio === profile.bio || bioLength > profile.bioLimit}>{tr("Save bio")}</button>
        </form>
        <form onSubmit={(event) => {
          event.preventDefault();
          if (usernameValid && usernameChanged) void save({ kind: "username", username: editable, expectedUsername: profile.username });
        }}>
          <label>{tr("Username ")}<input value={username} maxLength={33} disabled={busy} onChange={(event) => {
            setUsername(event.target.value);
            setAvailability("");
          }} /></label>
          {profile.username && <CopyTelegramPublicLink key={profile.username} name={profile.username} />}
          {!usernameValid && <p>{tr("Use 5–32 letters, digits, or underscores. Start with a letter and end with a letter or digit.")}</p>}
          {availability && <p role="status">{availability}</p>}
          <button type="button" className="mtg-action" disabled={busy || !editable || !usernameValid || !usernameChanged}
            onClick={() => void check()}>{tr("Check username")}</button>
          <button type="submit" className="mtg-action" disabled={busy || !usernameValid || !usernameChanged}>
            {editable ? tr("Save username") : tr("Remove username")}
          </button>
        </form>
        {actions.createTemporaryLink && <TemporaryProfileLink key={`profile-link:${profile.accountId}`} create={actions.createTemporaryLink} />}
        <form onSubmit={(event) => {
          event.preventDefault();
          if (birthdate.success && birthdateChanged) void save({
            kind: "birthdate", birthdate: birthdate.data, expectedBirthdate: profile.birthdate,
          });
        }}>
          <fieldset disabled={busy}>
            <legend>{tr("Birthday")}</legend>
            <label>{tr("Day ")}<input type="number" min={1} max={31} value={day} onChange={(event) => setDay(event.target.value)} /></label>
            <label>{tr("Month ")}<input type="number" min={1} max={12} value={month} onChange={(event) => setMonth(event.target.value)} /></label>
            <label>{tr("Year (optional) ")}<input type="number" min={1} max={9999} value={year} onChange={(event) => setYear(event.target.value)} /></label>
            {(day || month) && !birthdate.success && <p>{tr("Enter a valid day and month.")}</p>}
            <button type="submit" className="mtg-action" disabled={!birthdateChanged}>{tr("Save birthday")}</button>
            {profile.birthdate && <button type="button" className="mtg-action" onClick={() => void save({
              kind: "birthdate", birthdate: null, expectedBirthdate: profile.birthdate,
            })}>{tr("Remove birthday")}</button>}
          </fieldset>
        </form>
        {profile.accountId && music && <ProfileAudio key={`profile-audio:${profile.accountId}`} id={profile.accountId} own actions={music} />}
        {profile.giftSettings && giftDraft && <form onSubmit={(event) => {
          event.preventDefault();
          if (profile.giftSettings) void save({ kind: "gifts", values: giftDraft, expected: profile.giftSettings.values });
        }}>
          <fieldset disabled={busy}>
            <legend>{tr("Receiving gifts")}</legend>
            <label><input type="checkbox" checked={giftDraft.showButton}
              onChange={(event) => setGiftDraft({ ...giftDraft, showButton: event.currentTarget.checked })} />{tr(" Always show the gift button")}</label>
            {profile.giftSettings.canFilter && (Object.keys(acceptedGiftLabels) as (keyof GiftReceivingSettings["accepted"])[]).map((key) =>
              <label key={key}><input type="checkbox" checked={giftDraft.accepted[key]}
                onChange={(event) => setGiftDraft({ ...giftDraft, accepted: { ...giftDraft.accepted, [key]: event.currentTarget.checked } })} /> {tr(acceptedGiftLabels[key])}</label>)}
            <button type="submit" className="mtg-action" disabled={JSON.stringify(giftDraft) === JSON.stringify(profile.giftSettings.values)}>{tr("Save gift settings")}</button>
          </fieldset>
        </form>}
      </>}
      {notice && <p role="status">{tr(notice)}</p>}
      {error && <p role="alert">{tr(error)} <button type="button" className="mtg-action" disabled={busy}
        onClick={() => setRevision((value) => value + 1)}>{tr("Reload profile")}</button></p>}
    </>}
  </details>;
}
