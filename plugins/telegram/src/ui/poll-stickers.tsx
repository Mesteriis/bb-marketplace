import { createContext, useCallback, useContext } from "react";
import type { CustomEmojiMedia, PollAttachmentReference, PollMediaAttachment } from "../core/contract.ts";
import { StickerArtwork } from "./custom-emoji.tsx";
import type { StickerPacks, StickerPage } from "./installed-sticker-picker.tsx";

export const PollStickerActions = createContext<{
  list: StickerPacks;
  page: StickerPage;
  artwork: (chatId: string, messageId: string, reference: PollAttachmentReference) => Promise<CustomEmojiMedia | null>;
} | undefined>(undefined);

export function PollSticker({ chatId, messageId, slot, media }: {
  chatId: string;
  messageId: string;
  slot: number;
  media: Extract<PollMediaAttachment, { kind: "sticker" }>;
}) {
  const actions = useContext(PollStickerActions);
  const { fileId, label } = media;
  const load = useCallback(() => actions?.artwork(chatId, messageId, { slot, fileId }) ?? Promise.resolve(null),
    [actions, chatId, messageId, slot, fileId]);
  return actions ? <StickerArtwork id={String(fileId)} label={label} load={load} /> : <bdi>{label}</bdi>;
}
