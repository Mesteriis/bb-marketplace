import { useTelegramLocale } from "./i18n/index.tsx";
import { ProfileEmojiStatusView } from "./profile-emoji-status.tsx";
import { formatBirthdate, isBirthdate, useBirthdayCalendar } from "./contact-birthday.ts";
import { Cake } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { PeerProfile } from "../core/contract.ts";
import { CopyTelegramPublicLink } from "./copy-message-reference.tsx";
import { useMiniAppLauncher, type LaunchMiniApp } from "./mini-app.tsx";
import { MessageText } from "./message-text.tsx";

export type PeerProfileLoader = (id: string) => Promise<PeerProfile | null>;

function ContactBirthday({ birthdate }: { birthdate: NonNullable<PeerProfile["birthdate"]> }) {
  const { t: tr } = useTelegramLocale();
  const today = useBirthdayCalendar();
  const celebrating = isBirthdate(birthdate, today);
  return <><dt>{tr("Birthday")}</dt><dd>
    {formatBirthdate(birthdate)}
    {celebrating && <span className="mtg-profile-birthday"><Cake size={16} aria-hidden="true" />{tr("Birthday today")}</span>}
  </dd></>;
}

export function ContactProfile({ id, name, load, startExpanded, launchMainApp, revokeEmojiAccess, revokeLocationAccess, openPersonalChannel }: {
  id: string; name?: string; load: PeerProfileLoader; launchMainApp?: LaunchMiniApp;
  startExpanded?: boolean;
  revokeEmojiAccess?: (id: string) => Promise<boolean>;
  revokeLocationAccess?: (id: string) => Promise<boolean>;
  openPersonalChannel?: (id: string) => Promise<boolean>;
}) {
  const { t: tr } = useTelegramLocale();
  const miniApp = useMiniAppLauncher();
  const profileOwner = useRef<string | undefined>(undefined);
  useEffect(() => {
    profileOwner.current = id;
    return () => { profileOwner.current = undefined; };
  }, [id]);
  const [profile, setProfile] = useState<PeerProfile | null>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const [revokeStatus, setRevokeStatus] = useState<{ label: string; saved: boolean }>();
  const [channelStatus, setChannelStatus] = useState<"loading" | "unavailable">();

  async function revoke(kind: "emoji" | "location") {
    const action = kind === "emoji" ? revokeEmojiAccess : revokeLocationAccess;
    if (!action || revoking) return;
    const label = kind === "emoji" ? "Emoji status access" : "Location access";
    setRevoking(true);
    setRevokeStatus(undefined);
    try {
      const saved = await action(id);
      if (saved) {
        const field = kind === "emoji" ? "botCanManageEmojiStatus" : "botCanAccessLocation";
        setProfile((current) => current && { ...current, [field]: undefined });
      }
      setRevokeStatus({ label, saved });
    } catch { setRevokeStatus({ label, saved: false }); }
    finally { setRevoking(false); }
  }

  async function open() {
    if (busy || revoking) return;
    setRevokeStatus(undefined);
    if (profile !== undefined) {
      setProfile(undefined);
      return;
    }
    await refresh();
  }

  const refresh = useCallback(async () => {
    setBusy(true);
    setError(false);
    try { setProfile(await load(id)); }
    catch { setError(true); }
    finally { setBusy(false); }
  }, [id, load]);
  useEffect(() => {
    if (startExpanded) void refresh();
  }, [refresh, startExpanded]);

  const visible = profile && (profile.usernames.length > 0 || profile.phone || profile.bio || profile.note
    || profile.birthdate || profile.emojiStatus || profile.personalChannel);
  const hasApp = profile?.hasMainMiniApp && launchMainApp;
  return <section aria-label={tr("Contact profile")}>
    <button type="button" className="mtg-action" aria-expanded={profile !== undefined} disabled={busy || revoking}
      onClick={() => void open()}>{tr("Contact profile")}</button>
    {busy && <p role="status">{tr("Loading contact profile…")}</p>}
    {error && <p role="alert">{tr("Could not load contact profile.")}</p>}
    {profile !== undefined && !visible && !hasApp && !profile?.botCanManageEmojiStatus && !profile?.botCanAccessLocation && <p>{tr("No contact details available.")}</p>}
    {(profile?.botCanManageEmojiStatus || profile?.botCanAccessLocation) && <section aria-label={tr("Bot permissions")}>
      {profile.botCanManageEmojiStatus && <>
        <p>{tr("This bot can change your Telegram emoji status.")}</p>
        {revokeEmojiAccess && <button type="button" className="mtg-action" disabled={revoking}
          onClick={() => void revoke("emoji")}>{tr("Revoke emoji status access")}</button>}
      </>}
      {profile.botCanAccessLocation && <>
        <p>{tr("This bot’s Mini Apps can request your location.")}</p>
        {revokeLocationAccess && <button type="button" className="mtg-action" disabled={revoking}
          onClick={() => void revoke("location")}>{tr("Revoke location access")}</button>}
      </>}
    </section>}
    {revokeStatus?.saved && <p role="status">{revokeStatus.label}{tr(" revoked.")}</p>}
    {revokeStatus && !revokeStatus.saved && <p role="alert">{tr("Could not revoke ")}{revokeStatus.label.toLowerCase()}.</p>}
    {hasApp && <button type="button" className="mtg-action" aria-haspopup="dialog"
      onClick={() => miniApp.open({ target: { label: profile?.usernames[0] ? `@${profile.usernames[0]}` : name || "Telegram bot" },
        entryPoint: ["bot-profile", id], launch: () => hasApp(id),
        handoffUrl: profile?.usernames[0] && `https://t.me/${encodeURIComponent(profile.usernames[0])}?startapp`,
        onClosed: () => { if (profileOwner.current === id) void refresh(); } })}>{tr("Open bot app")}</button>}
    {miniApp.dialog}
    {profile && visible && <dl>
      {profile.emojiStatus && <ProfileEmojiStatusView key={`${profile.emojiStatus.emoji}:${profile.emojiStatus.expiresAt}`} status={profile.emojiStatus} />}
      {!!profile.usernames.length && <>
        <dt>{tr("Username")}</dt>
        {profile.usernames.map((name) => <dd key={name}><bdi>@{name}</bdi> <CopyTelegramPublicLink name={name} /></dd>)}
      </>}
      {profile.phone && <><dt>{tr("Phone")}</dt><dd><bdi>{profile.phone}</bdi></dd></>}
      {profile.bio && <><dt>{tr("Bio")}</dt><dd><MessageText {...profile.bio} /></dd></>}
      {profile.personalChannel && <><dt>{tr("Personal channel")}</dt><dd>
        <bdi>{profile.personalChannel.title}</bdi>
        {profile.personalChannel.preview && <p>{profile.personalChannel.preview}</p>}
        {openPersonalChannel && <button type="button" className="mtg-action" disabled={channelStatus === "loading"}
          onClick={async () => {
            if (!profile.personalChannel) return;
            setChannelStatus("loading");
            const opened = await openPersonalChannel(profile.personalChannel.id).catch(() => false);
            if (profileOwner.current === id) setChannelStatus(opened ? undefined : "unavailable");
          }}>{tr("Open personal channel")}</button>}
        {channelStatus === "unavailable" && <p role="alert">{tr("Could not open the personal channel.")}</p>}
      </dd></>}
      {profile.note && <><dt>{tr("Private contact note")}</dt><dd><MessageText {...profile.note} /></dd></>}
      {profile.birthdate && <ContactBirthday birthdate={profile.birthdate} />}
    </dl>}
  </section>;
}
