import { isVideoAttachmentName } from "../core/contract.ts";
import { isPhotoMimeType, maxOriginalPhotoBytes } from "./prepare-photo.ts";

export function droppedAttachment(file: File, allowed: { photo: boolean; video: boolean; document: boolean }) {
  if (allowed.photo && isPhotoMimeType(file.type) && (file.size <= maxOriginalPhotoBytes || !allowed.document)) return "photo";
  if (allowed.video && isVideoAttachmentName(file.name)) return "video";
  return allowed.document ? "document" : undefined;
}
