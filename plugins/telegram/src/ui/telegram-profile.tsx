import { useEffect, useState } from "react";
import { AvatarEditor } from "./avatar-editor.tsx";
import { telegramBirthdate, type SaveAvatarResult, type ProfileChange, type TelegramProfile as Profile, type UsernameCheck } from "../core/contract.ts";

export type ProfileActions = {
  load: () => Promise<Profile>;
  removePhoto?: (expected: string) => Promise<SaveAvatarResult>;
  savePhoto?: (base64: string, expected: string | null) => Promise<SaveAvatarResult>;
  check: (username: string) => Promise<UsernameCheck>;
  save: (change: ProfileChange) => Promise<"saved" | "changed" | "unsupported">;
};

export function TelegramProfile({ actions }: { actions: ProfileActions }) {
  const [open, setOpen] = useState(false);
  const [profile, setProfile] = useState<Profile>();
  const [first, setFirst] = useState("");
  const [last, setLast] = useState("");
  const [bio, setBio] = useState("");
  const [username, setUsername] = useState("");
  const [day, setDay] = useState("");
  const [month, setMonth] = useState("");
  const [year, setYear] = useState("");
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
          : change.kind === "username" ? { ...previous, username: change.username } : { ...previous, birthdate: change.birthdate }));
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
    <summary>Profile</summary>
    {open && <>
      {!profile && !error && <p role="status">Loading profile…</p>}
      {profile && <>
        {profile.photoVersion !== undefined && actions.savePhoto &&
          <AvatarEditor label="profile photo" version={profile.photoVersion} disabled={busy}
            save={actions.savePhoto} remove={actions.removePhoto} canRemove={profile.canRemovePhoto === true}
            reload={async () => {
              const fresh = await actions.load();
              return { version: fresh.photoVersion, canRemove: fresh.canRemovePhoto === true };
            }} />}
        <form onSubmit={(event) => {
          event.preventDefault();
          if (nameChanged) void save({ kind: "name", first: first.trim(), last: last.trim(), expectedFirst: profile.first, expectedLast: profile.last });
        }}>
          <label>First name <input value={first} maxLength={64} disabled={busy} onChange={(event) => setFirst(event.target.value)} /></label>
          <label>Last name <input value={last} maxLength={64} disabled={busy} onChange={(event) => setLast(event.target.value)} /></label>
          <button type="submit" className="mtg-action" disabled={busy || !nameChanged}>Save profile name</button>
        </form>
        <form onSubmit={(event) => {
          event.preventDefault();
          if (profile.bioEditable && bio !== profile.bio && bioLength <= profile.bioLimit) void save({ kind: "bio", bio, expectedBio: profile.bio });
        }}>
          <label>Bio <input value={bio} disabled={busy || !profile.bioEditable}
            onChange={(event) => setBio(event.target.value)} /></label>
          <p>{bioLength} / {profile.bioLimit}</p>
          {!profile.bioEditable && <p>Formatted bio editing is unavailable in BB.</p>}
          <button type="submit" className="mtg-action" disabled={busy || !profile.bioEditable || bio === profile.bio || bioLength > profile.bioLimit}>Save bio</button>
        </form>
        <form onSubmit={(event) => {
          event.preventDefault();
          if (usernameValid && usernameChanged) void save({ kind: "username", username: editable, expectedUsername: profile.username });
        }}>
          <label>Username <input value={username} maxLength={33} disabled={busy} onChange={(event) => {
            setUsername(event.target.value);
            setAvailability("");
          }} /></label>
          {!usernameValid && <p>Use 5–32 letters, digits, or underscores. Start with a letter and end with a letter or digit.</p>}
          {availability && <p role="status">{availability}</p>}
          <button type="button" className="mtg-action" disabled={busy || !editable || !usernameValid || !usernameChanged}
            onClick={() => void check()}>Check username</button>
          <button type="submit" className="mtg-action" disabled={busy || !usernameValid || !usernameChanged}>
            {editable ? "Save username" : "Remove username"}
          </button>
        </form>
        <form onSubmit={(event) => {
          event.preventDefault();
          if (birthdate.success && birthdateChanged) void save({
            kind: "birthdate", birthdate: birthdate.data, expectedBirthdate: profile.birthdate,
          });
        }}>
          <fieldset disabled={busy}>
            <legend>Birthday</legend>
            <label>Day <input type="number" min={1} max={31} value={day} onChange={(event) => setDay(event.target.value)} /></label>
            <label>Month <input type="number" min={1} max={12} value={month} onChange={(event) => setMonth(event.target.value)} /></label>
            <label>Year (optional) <input type="number" min={1} max={9999} value={year} onChange={(event) => setYear(event.target.value)} /></label>
            {(day || month) && !birthdate.success && <p>Enter a valid day and month.</p>}
            <button type="submit" className="mtg-action" disabled={!birthdateChanged}>Save birthday</button>
            {profile.birthdate && <button type="button" className="mtg-action" onClick={() => void save({
              kind: "birthdate", birthdate: null, expectedBirthdate: profile.birthdate,
            })}>Remove birthday</button>}
          </fieldset>
        </form>
      </>}
      {notice && <p role="status">{notice}</p>}
      {error && <p role="alert">{error} <button type="button" className="mtg-action" disabled={busy}
        onClick={() => setRevision((value) => value + 1)}>Reload profile</button></p>}
    </>}
  </details>;
}
