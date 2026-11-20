import { useCallback } from "react";
import type { PhotoMotion } from "../core/contract.ts";
import { MediaPlayer } from "./media-player.tsx";

export function PhotoMotionPlayer({ chatId, messageId, motion, play }: {
  chatId: string;
  messageId: string;
  motion: PhotoMotion;
  play: (fileId: number) => Promise<string>;
}) {
  const { fileId, mime } = motion;
  const stream = useCallback(() => play(fileId), [play, fileId]);
  return <MediaPlayer chatId={chatId} messageId={`${messageId}:live-photo:${fileId}`} mime={mime}
    stream={stream} loadLabel="Load live photo video" />;
}
