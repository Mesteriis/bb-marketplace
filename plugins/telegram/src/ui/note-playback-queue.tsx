import { createContext, useMemo, useRef, type ReactNode } from "react";
import type { Message } from "../core/demo.ts";

type PlaybackQueue = {
  kind: "audioAlbum" | "rich" | "notes" | "music";
  register?: (id: string, start: () => void) => () => void;
  hasNeighbor: (id: string, offset: -1 | 1) => boolean;
  move: (id: string, offset: -1 | 1) => boolean;
};

export const PlaybackQueue = createContext<PlaybackQueue | undefined>(undefined);

export function OrderedPlaybackQueueProvider({ ids, enabled, kind, children }: {
  ids: readonly string[];
  enabled: boolean;
  kind: PlaybackQueue["kind"];
  children: ReactNode;
}) {
  const players = useRef(new Map<string, () => void>());
  const queue = useMemo<PlaybackQueue>(() => {
    function neighbor(id: string, offset: -1 | 1) {
      const index = ids.indexOf(id);
      return index < 0 ? undefined : ids[index + offset];
    }
    return {
      kind,
      register(id, start) {
        players.current.set(id, start);
        return () => { if (players.current.get(id) === start) players.current.delete(id); };
      },
      hasNeighbor: (id, offset) => neighbor(id, offset) !== undefined,
      move(id, offset) {
        const next = neighbor(id, offset);
        const start = next === undefined ? undefined : players.current.get(next);
        start?.();
        return !!start;
      },
    };
  }, [ids, kind]);
  return <PlaybackQueue.Provider value={enabled ? queue : undefined}>{children}</PlaybackQueue.Provider>;
}

export function isPlayableAlbumTrack({ id, document, voiceNote, videoNote, oneView, retained, pendingDelivery, videoSpoiler }: Message) {
  return !voiceNote && !videoNote && !oneView && !retained && !pendingDelivery && !videoSpoiler
    && /^[1-9]\d{0,15}$/.test(id) && !!document?.downloadable && document.playbackMime?.startsWith("audio/") === true;
}

export function NotePlaybackQueueProvider({ messages, enabled, children }: {
  messages: readonly Message[];
  enabled: boolean;
  children: ReactNode;
}) {
  const ids = useMemo(() => messages.filter((message) =>
    (message.voiceNote || message.videoNote) && !message.oneView && !message.retained && !message.videoSpoiler
    && !message.pendingDelivery && message.document?.downloadable && message.document.playbackMime)
    .map(({ id }) => id), [messages]);
  return <OrderedPlaybackQueueProvider ids={ids} enabled={enabled} kind="notes">{children}</OrderedPlaybackQueueProvider>;
}
