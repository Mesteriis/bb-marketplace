import { useTelegramLocale } from "./i18n/index.tsx";
import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import type { ProfileAudioChange, ProfileAudioPage } from "../core/contract.ts";
import { MediaPlayer } from "./media-player.tsx";

type AddTrack = (id: string, messageId: string, fileId: number) => Promise<"saved" | "already" | "changed" | "unavailable">;
export const AddProfileAudioAction = createContext<AddTrack | undefined>(undefined);

export function AddProfileAudioButton({ id, messageId, fileId, name }: {
  id: string; messageId: string; fileId: number; name: string;
}) {
  const { t: tr } = useTelegramLocale();
  const add = useContext(AddProfileAudioAction);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  if (!add) return null;
  return <>
    <button type="button" className="mtg-action" disabled={busy || confirm} onClick={() => { setStatus(""); setConfirm(true); }}>{tr("Add to profile music")}</button>
    {confirm && <div role="group" aria-label={tr("Confirm adding profile music")}>
      <p>{tr("Add ")}<bdi>{name}</bdi>{tr(" to your Telegram profile?")}</p>
      <button type="button" className="mtg-action" onClick={async () => {
        if (busy) return;
        setBusy(true);
        setConfirm(false);
        try {
          const result = await add(id, messageId, fileId);
          setStatus(result === "saved" ? "Track added to profile music."
            : result === "already" ? "This track is already in your profile music."
              : result === "changed" ? "The audio changed in Telegram. Reopen the message." : "Could not add the track.");
        } catch { setStatus("Telegram did not confirm the change. Check your profile music before trying again."); }
        finally { setBusy(false); }
      }}>{tr("Confirm add")}</button>
      <button type="button" className="mtg-action" onClick={() => setConfirm(false)}>{tr("Cancel")}</button>
    </div>}
    {status && <p role="status">{tr(status)}</p>}
  </>;
}

export type ProfileAudioActions = {
  list: (id: string, offset: number) => Promise<ProfileAudioPage | null>;
  playback: (id: string, index: number, fileId: number) => Promise<string>;
  change?: (id: string, change: ProfileAudioChange) => Promise<"saved" | "changed" | "unavailable">;
};

function ProfileTrack({ id, track, playback, children }: {
  id: string; track: ProfileAudioPage["tracks"][number]; playback: ProfileAudioActions["playback"];
  children?: ReactNode;
}) {
  const { index, fileId } = track;
  const stream = useCallback(() => playback(id, index, fileId), [id, index, fileId, playback]);
  return <li>
    <bdi>{track.title}</bdi>{track.performer && <> · <bdi>{track.performer}</bdi></>}
    {track.mime && <MediaPlayer chatId={id} messageId={`profile-audio:${track.index}:${track.fileId}`}
      mime={track.mime} stream={stream} />}
    {children}
  </li>;
}

export function ProfileAudio({ id, actions, own }: { id: string; actions: ProfileAudioActions; own?: boolean }) {
  const { t: tr } = useTelegramLocale();
  const [page, setPage] = useState<ProfileAudioPage | null>();
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [changing, setChanging] = useState(false);
  const [confirm, setConfirm] = useState<ProfileAudioChange>();
  const [status, setStatus] = useState("");

  async function load(offset: number) {
    if (loading) return;
    setLoading(true);
    setFailed(false);
    try {
      const incoming = await actions.list(id, offset);
      setPage((current) => incoming && offset && current
        ? { ...incoming, tracks: [...current.tracks, ...incoming.tracks] } : incoming);
    } catch { setFailed(true); }
    finally { setLoading(false); }
  }

  async function changeTrack(change: ProfileAudioChange) {
    if (!own || !actions.change || changing || loading) return;
    setChanging(true);
    setConfirm(undefined);
    setStatus("");
    try {
      const result = await actions.change(id, change);
      if (result === "unavailable") setStatus("Could not update profile music.");
      else {
        setStatus(result === "changed" ? "The track list changed. Reloaded profile music." : "Profile music updated.");
        setPage(undefined);
        await load(0);
      }
    } catch {
      setStatus("Telegram did not confirm the change. Reload profile music before trying again.");
      setPage(undefined);
    } finally { setChanging(false); }
  }

  return <section aria-label={tr("Profile music")}>
    {page === undefined && <button type="button" className="mtg-action" disabled={loading || changing} onClick={() => void load(0)}>
      {failed ? tr("Retry profile music") : tr("Show profile music")}
    </button>}
    {loading && <p role="status">{tr("Loading profile music…")}</p>}
    {failed && <p role="alert">{tr("Could not load profile music.")}</p>}
    {status && <p role="status">{tr(status)}</p>}
    {page === null && <p>{tr("Profile music is unavailable.")}</p>}
    {page && !page.tracks.length && page.next === null && <p>{tr("No profile music.")}</p>}
    {!!page?.tracks.length && <ul aria-label={tr("Profile tracks")}>{page.tracks.map((track, position) => {
      const { index, fileId, title } = track;
      const neighbors = [page.tracks[position - 1], page.tracks[position + 1]];
      return <ProfileTrack key={`${index}:${fileId}`} id={id} track={track} playback={actions.playback}>
        {own && actions.change && <div className="mtg-story-actions">
          {(["up", "down"] as const).map((action, i) => {
            const neighbor = neighbors[i];
            return neighbor && Math.abs(index - neighbor.index) === 1 && <button key={action} type="button" className="mtg-action"
              disabled={changing || loading || !!confirm} aria-label={tr("Move {0} {1}", [title, action])}
              onClick={() => void changeTrack({ index, fileId, action, neighbor: neighbor.fileId })}>{tr("Move ")}{action}</button>;
          })}
          {confirm?.index === index && confirm.fileId === fileId
            ? <><button type="button" className="mtg-action" onClick={() => void changeTrack(confirm)}>{tr("Confirm remove")}</button>
              <button type="button" className="mtg-action" onClick={() => setConfirm(undefined)}>{tr("Cancel")}</button></>
            : <button type="button" className="mtg-action" disabled={changing || loading || !!confirm}
              aria-label={tr("Remove {0}", [title])} onClick={() => setConfirm({ index, fileId, action: "remove" })}>{tr("Remove track")}</button>}
        </div>}
      </ProfileTrack>;
    })}</ul>}
    {page?.next != null && <button type="button" className="mtg-action" disabled={loading || changing || !!confirm} onClick={() => void load(page.next!)}>{tr("Load more tracks")}</button>}
  </section>;
}
