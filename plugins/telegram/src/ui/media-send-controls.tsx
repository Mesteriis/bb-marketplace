import type { MediaSendOptions } from "../core/contract.ts";

export function MediaSendControls({ kind, options, hasCaption, disabled, change }: {
  kind: "photo" | "photos" | "video" | "GIF";
  options?: MediaSendOptions;
  hasCaption: boolean;
  disabled: boolean;
  change: (options: MediaSendOptions) => void;
}) {
  return <>
    <label className="mtg-link-preview-option">
      <input type="checkbox" checked={options?.spoiler === true} disabled={disabled}
        onChange={(event) => change({ ...options, spoiler: event.currentTarget.checked })} /> Hide {kind} under a spoiler
    </label>
    <label className="mtg-link-preview-option">
      <input type="checkbox" checked={hasCaption && options?.captionAbove === true} disabled={disabled || !hasCaption}
        onChange={(event) => change({ ...options, captionAbove: event.currentTarget.checked })} /> Show caption above media
    </label>
  </>;
}
