import { useTelegramLocale } from "./i18n/index.tsx";
import { createContext, useContext, useState } from "react";
import { telegramBirthdate, type TelegramBirthdate } from "../core/contract.ts";
import { formatBirthdate } from "./contact-birthday.ts";

export type SuggestBirthday = (id: string, userId: string, birthdate: TelegramBirthdate) => Promise<"sent" | "unavailable" | "unknown">;
export type AcceptBirthday = (id: string, messageId: string, birthdate: TelegramBirthdate) => Promise<"saved" | "changed" | "unavailable">;
export const AcceptContactBirthday = createContext<AcceptBirthday | undefined>(undefined);

export function ContactBirthdaySuggestion({ id, userId, name, send }: { id: string; userId: string; name: string; send: SuggestBirthday }) {
  const { t: tr } = useTelegramLocale();
  const [day, setDay] = useState("");
  const [month, setMonth] = useState("");
  const [year, setYear] = useState("");
  const [review, setReview] = useState<TelegramBirthdate>();
  const [status, setStatus] = useState<"sending" | "sent" | "unavailable" | "unknown">();
  const birthdate = telegramBirthdate.safeParse({ day: Number(day), month: Number(month), year: Number(year) });
  async function sendReviewed() {
    if (!review || status === "sending") return;
    setStatus("sending");
    const result = await send(id, userId, review).catch(() => "unknown" as const);
    setStatus(result);
    setReview(undefined);
  }
  return <details>
    <summary>{tr("Suggest a birthday")}</summary>
    {review ? <div>
      <p>{tr("Send ")}<strong>{formatBirthdate(review)}</strong>{tr(" as a birthday suggestion to ")}<bdi>{name}</bdi>?</p>
      <button type="button" className="mtg-action" disabled={status === "sending"} onClick={() => void sendReviewed()}>{tr("Send birthday suggestion")}</button>
      <button type="button" className="mtg-action" disabled={status === "sending"} onClick={() => setReview(undefined)}>{tr("Cancel suggestion")}</button>
    </div> : status !== "sent" && status !== "unknown" && <form onSubmit={(event) => {
      event.preventDefault();
      if (birthdate.success) { setStatus(undefined); setReview(birthdate.data); }
    }}>
      <label>{tr("Day ")}<input type="number" min={1} max={31} value={day} onChange={(event) => setDay(event.target.value)} /></label>
      <label>{tr("Month ")}<input type="number" min={1} max={12} value={month} onChange={(event) => setMonth(event.target.value)} /></label>
      <label>{tr("Year (optional) ")}<input type="number" min={1} max={9999} value={year} onChange={(event) => setYear(event.target.value)} /></label>
      {(day || month) && !birthdate.success && <p>{tr("Enter a valid date.")}</p>}
      <button type="submit" className="mtg-action" disabled={!birthdate.success}>{tr("Review birthday suggestion")}</button>
    </form>}
    {status === "sent" && <p role="status">{tr("Birthday suggestion sent.")}</p>}
    {status === "unavailable" && <p role="alert">{tr("Telegram could not send this birthday suggestion.")}</p>}
    {status === "unknown" && <p role="alert">{tr("Telegram did not confirm delivery. Check the conversation before sending it again.")}</p>}
  </details>;
}

export function BirthdaySuggestionMessage({ chatId, messageId, birthdate, actionable }: {
  chatId: string; messageId: string; birthdate: TelegramBirthdate; actionable: boolean;
}) {
  const { t: tr } = useTelegramLocale();
  const accept = useContext(AcceptContactBirthday);
  const [review, setReview] = useState(false);
  const [status, setStatus] = useState<"saving" | "saved" | "changed" | "unavailable">();
  async function confirm() {
    if (!accept || !actionable || !review || status === "saving") return;
    setStatus("saving");
    setStatus(await accept(chatId, messageId, birthdate).catch(() => "unavailable" as const));
    setReview(false);
  }
  return <section aria-label={tr("Birthday suggestion")}>
    <p>{tr("Suggested birthday · ")}<strong>{formatBirthdate(birthdate)}</strong></p>
    {actionable && accept && (review ? <>
      <p>{tr("Save this birthday to your Telegram profile?")}</p>
      <button type="button" className="mtg-action" disabled={status === "saving"} onClick={() => void confirm()}>{tr("Save suggested birthday")}</button>
      <button type="button" className="mtg-action" disabled={status === "saving"} onClick={() => setReview(false)}>{tr("Cancel")}</button>
    </> : status !== "saved" && status !== "changed" && <button type="button" className="mtg-action"
      onClick={() => { setStatus(undefined); setReview(true); }}>{tr("Use this birthday")}</button>)}
    {status === "saved" && <p role="status">{tr("Birthday saved to your profile.")}</p>}
    {status === "changed" && <p role="alert">{tr("The suggestion or your profile birthday has changed. Review your profile settings.")}</p>}
    {status === "unavailable" && <p role="alert">{tr("This birthday suggestion is unavailable.")}</p>}
  </section>;
}
