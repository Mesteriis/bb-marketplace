import { useTelegramLocale } from "./i18n/index.tsx";
import type { DraftPreview, SyncedDraft, TextDelivery } from "../core/contract.ts";
import { textWebLinks } from "../core/message-links.ts";

export type LinkPreviewChoice = { placement: "above" | "below"; url?: string };

export function linkPreviewDelivery(choice: LinkPreviewChoice | undefined, text: string): Pick<TextDelivery,
  "linkPreview" | "linkPreviewAbove" | "linkPreviewUrl"> {
  if (!choice) return {};
  const url = choice.url;
  return {
    linkPreview: true,
    ...(choice.placement === "above" ? { linkPreviewAbove: true } : {}),
    ...(url && textWebLinks(text).some(({ href }) => href === url) ? { linkPreviewUrl: url } : {}),
  };
}

export function savedDraftPreview(choice: LinkPreviewChoice | undefined, text: string, hasFormattedLinks: boolean): DraftPreview | undefined {
  const links = textWebLinks(text);
  if (!choice || !links.length) return links.length || hasFormattedLinks ? { mode: "disabled" } : undefined;
  const url = links.some(({ href }) => href === choice.url) ? choice.url : undefined;
  if (choice.placement === "above" || url) {
    return { mode: "enabled", ...(choice.placement === "above" ? { above: true } : {}), ...(url ? { url } : {}) };
  }
}

export function restoreDraftPreview(draft: SyncedDraft): LinkPreviewChoice | undefined {
  if (draft.preview?.mode === "disabled" || !textWebLinks(draft.text).length) return;
  return { placement: draft.preview?.above ? "above" : "below", url: draft.preview?.url };
}

export function LinkPreviewControls({ choice, text, disabled, change }: {
  choice?: LinkPreviewChoice;
  text: string;
  disabled: boolean;
  change: (choice?: LinkPreviewChoice) => void;
}) {
  const { t: tr } = useTelegramLocale();
  const links = choice ? [...new Set(textWebLinks(text).map(({ href }) => href))] : [];
  return <div>
    <label className="mtg-link-preview-option">
      <input type="checkbox" checked={choice !== undefined} disabled={disabled}
        onChange={(event) => change(event.currentTarget.checked ? { placement: "below" } : undefined)} />{tr(" Include Telegram link preview")}</label>
    {choice && <label className="mtg-link-preview-option">{tr("Preview position")}<select value={choice.placement} disabled={disabled}
        onChange={(event) => change({ ...choice, placement: event.currentTarget.value === "above" ? "above" : "below" })}>
        <option value="below">{tr("Below text")}</option>
        <option value="above">{tr("Above text")}</option>
      </select>
    </label>}
    {choice && links.length > 1 && <label className="mtg-link-preview-option">{tr("Preview link")}<select value={choice.url && links.includes(choice.url) ? choice.url : ""} disabled={disabled}
        onChange={(event) => change({ ...choice, url: event.currentTarget.value || undefined })}>
        <option value="">{tr("First link")}</option>
        {links.map((link) => <option key={link} value={link}>{link}</option>)}
      </select>
    </label>}
  </div>;
}
