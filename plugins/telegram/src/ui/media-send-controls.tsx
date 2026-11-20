import { useTelegramLocale } from "./i18n/index.tsx";
import type { MediaSendOptions } from "../core/contract.ts";

export function MediaSendControls({ kind, options, hasCaption, allowOriginalVideo, originalVideoLabel = "Original video quality", disabled, change }: {
  kind: "photo" | "photos" | "video" | "GIF" | "album media";
  options?: MediaSendOptions;
  hasCaption: boolean;
  allowOriginalVideo?: boolean;
  originalVideoLabel?: string;
  disabled: boolean;
  change: (options: MediaSendOptions) => void;
}) {
  const { t: tr } = useTelegramLocale();
  return <>
    {allowOriginalVideo && <label className="mtg-link-preview-option">
      <input type="checkbox" checked={options?.originalVideo === true} disabled={disabled}
        onChange={(event) => change({ ...options, originalVideo: event.currentTarget.checked })} /> {originalVideoLabel}
    </label>}
    <label className="mtg-link-preview-option">
      <input type="checkbox" checked={options?.spoiler === true} disabled={disabled}
        onChange={(event) => change({ ...options, spoiler: event.currentTarget.checked })} />{tr(" Hide ")}{kind}{tr(" under a spoiler")}</label>
    <label className="mtg-link-preview-option">
      <input type="checkbox" checked={hasCaption && options?.captionAbove === true} disabled={disabled || !hasCaption}
        onChange={(event) => change({ ...options, captionAbove: event.currentTarget.checked })} />{tr(" Show caption above media")}</label>
  </>;
}
