import { useTelegramLocale } from "./i18n/index.tsx";
import { useEffect, useState, type RefObject } from "react";

export function VideoPictureInPicture({ player }: { player: RefObject<HTMLMediaElement | null> }) {
  const { t: tr } = useTelegramLocale();
  const [ready, setReady] = useState(false);
  const [active, setActive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    const video = player.current;
    if (!(video instanceof HTMLVideoElement) || typeof video.requestPictureInPicture !== "function") return;
    const owner = video.ownerDocument;
    function sync() {
      setReady(owner.pictureInPictureEnabled && video instanceof HTMLVideoElement && video.readyState >= video.HAVE_METADATA);
      setActive(owner.pictureInPictureElement === video);
    }
    const events = ["loadedmetadata", "emptied", "enterpictureinpicture", "leavepictureinpicture"];
    for (const event of events) video.addEventListener(event, sync);
    sync();
    return () => {
      for (const event of events) video.removeEventListener(event, sync);
      if (owner.pictureInPictureElement === video) void owner.exitPictureInPicture().catch(() => {});
    };
  }, [player]);

  async function toggle() {
    const video = player.current;
    if (busy || !(video instanceof HTMLVideoElement)) return;
    const owner = video.ownerDocument;
    setBusy(true);
    setError(false);
    try {
      if (owner.pictureInPictureElement === video) await owner.exitPictureInPicture();
      else await video.requestPictureInPicture();
      if (!video.isConnected && owner.pictureInPictureElement === video) await owner.exitPictureInPicture();
      setActive(owner.pictureInPictureElement === video);
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }

  return <>
    <button type="button" className="mtg-action" aria-pressed={active} disabled={busy || (!ready && !active)}
      onClick={() => void toggle()}>{active ? tr("Exit picture-in-picture") : tr("Picture-in-picture")}</button>
    {error && <p role="alert">{tr("Could not change picture-in-picture mode.")}</p>}
  </>;
}
