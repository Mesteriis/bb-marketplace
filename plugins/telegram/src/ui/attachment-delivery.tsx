import { useTelegramLocale } from "./i18n/index.tsx";
import type { AttachmentSendDelivery } from "../core/contract.ts";
import { useEffect, useState, type ReactNode } from "react";

export type AttachmentDeliveryDraft = { date: string; silent: boolean; whenOnline?: true };

export function attachmentDelivery(draft?: AttachmentDeliveryDraft): AttachmentSendDelivery | null | undefined {
  if (!draft) return;
  const at = draft.date ? Math.floor(new Date(draft.date).getTime() / 1000) : undefined;
  if (draft.whenOnline && at !== undefined) return null;
  if (at !== undefined && (!Number.isSafeInteger(at) || at <= Math.floor(Date.now() / 1000) + 10 || at > 2147483647)) return null;
  if (draft.silent || at !== undefined || draft.whenOnline) return {
    ...(draft.silent && { silent: true }), ...(at === undefined ? {} : { at }),
    ...(draft.whenOnline && { whenOnline: true }),
  };
}

export function useCanScheduleAttachmentWhenOnline(chatId?: string, check?: (id: string) => Promise<boolean>) {
  const [eligible, setEligible] = useState<string>();
  useEffect(() => {
    setEligible(undefined);
    if (!chatId || !check) return;
    let active = true;
    void check(chatId).then((allowed) => { if (active && allowed) setEligible(chatId); }, () => {});
    return () => { active = false; };
  }, [chatId, check]);
  return !!check && !!chatId && chatId === eligible;
}

export function repeatLabel(seconds: number): string {
  if (seconds === 86400) return "Every day";
  if (seconds === 604800) return "Every week";
  if (seconds % 86400 === 0) return `Every ${seconds / 86400} days`;
  if (seconds % 60 === 0) return `Every ${seconds / 60} min`;
  return `Every ${seconds} sec`;
}

export function AttachmentDeliveryControls({ draft, disabled, change, subject = "attachment", dateDisabled, onlineAllowed, children }: {
  draft?: AttachmentDeliveryDraft;
  subject?: "attachment" | "forward";
  dateDisabled?: boolean;
  onlineAllowed?: boolean;
  children?: ReactNode;
  disabled: boolean;
  change: (draft: AttachmentDeliveryDraft) => void;
}) {
  const { t: tr } = useTelegramLocale();
  const value = draft ?? { date: "", silent: false };
  return <details>
    <summary>{subject === "forward" ? tr("Forward delivery options") : tr("Attachment delivery options")}</summary>
    <label className="mtg-link-preview-option">
      <input type="checkbox" checked={value.silent} disabled={disabled}
        onChange={(event) => change({ ...value, silent: event.currentTarget.checked })} /> {subject === "forward"
        ? tr("Send forward without sound") : tr("Send attachment without sound")}</label>
    <label>{subject === "forward" ? tr("Schedule forward") : tr("Schedule attachment")} <input type="datetime-local" value={value.date} disabled={disabled || dateDisabled || value.whenOnline}
      onInput={(event) => change({ ...value, date: event.currentTarget.value })} /></label>
    {(onlineAllowed || value.whenOnline) && <label className="mtg-link-preview-option">
      <input type="checkbox" checked={value.whenOnline === true} disabled={disabled}
        onChange={(event) => change(event.currentTarget.checked && onlineAllowed
          ? { ...value, date: "", whenOnline: true } : { ...value, whenOnline: undefined })} />{tr(" Send when online")}</label>}
    {value.whenOnline && !onlineAllowed && <p role="status">{tr("Sending when online is unavailable here. Clear the option to continue.")}</p>}
    {children}
    {attachmentDelivery(draft) === null && <p role="alert">{subject === "forward" ? tr("Choose a future date and time for the forward.")
      : tr("Choose a future date and time for the attachment.")}</p>}
  </details>;
}
