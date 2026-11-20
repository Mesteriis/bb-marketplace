import { useTelegramLocale } from "./i18n/index.tsx";
import type { DocumentSendOptions } from "../core/contract.ts";
import { EditDraftAnimation } from "./edit-draft-animation.tsx";
import { EditDraftVideo } from "./edit-draft-video.tsx";

export function videoAttachmentOptions(options: DocumentSendOptions | undefined) {
  if (!options) return undefined;
  if (options.mediaKind === "animation") {
    const { videoEdit: _video, originalVideo: _original, ...animation } = options;
    return animation;
  }
  const { animationTrim: _animation, ...video } = options;
  return video.videoEdit ? { ...video, originalVideo: undefined } : video;
}

export function VideoAttachmentEdits({ file, options, disabled, allowGif, change }: {
  file: File; options?: DocumentSendOptions; disabled?: boolean; allowGif: boolean;
  change: (options: DocumentSendOptions) => void;
}) {
  const { t: tr } = useTelegramLocale();
  const asGif = options?.mediaKind === "animation";
  const transferredRange = options?.videoEdit && options.videoEdit.quality !== "original"
    ? { startMs: options.videoEdit.startMs, endMs: options.videoEdit.endMs } : undefined;
  return <>
    {(allowGif || asGif) && <label className="mtg-link-preview-option">
      <input type="checkbox" checked={asGif} disabled={disabled} onChange={(event) => {
        const enabled = event.currentTarget.checked;
        if (enabled && !allowGif) return;
        change({ ...options, mediaKind: enabled ? "animation" : undefined,
          animationTrim: options?.animationTrim ?? (enabled ? transferredRange : undefined) });
      }} />{tr(" Send as GIF")}</label>}
    {asGif ? <EditDraftAnimation file={file} value={options?.animationTrim} disabled={disabled}
      apply={(animationTrim) => change({ ...options, animationTrim })} />
      : <EditDraftVideo file={file} value={options?.videoEdit} disabled={disabled}
        apply={(videoEdit) => change({ ...options, videoEdit })} />}
  </>;
}
