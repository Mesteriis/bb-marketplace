// Turns what a person pastes (a Zoom link or a meeting number) into the
// number and passcode the Meeting SDK joins with. Only https links on Zoom's
// own hosts are accepted, so a look-alike domain is never opened.
import { DomainError } from "./errors.ts";

export interface MeetingTarget {
  readonly meetingNumber: string;
  readonly passcode: string | null;
}

const ZOOM_HOST = /(^|\.)zoom\.us$/i;
const MEETING_NUMBER = /^\d{9,11}$/;
/** /j/<n> (join), /s/<n> (start), /wc/<n>/join and /wc/join/<n> (web client). */
const PATH_NUMBER = /^\/(?:j|s|wc|wc\/join)\/(\d+)(?:\/|$)/;

function invalid(): never {
  throw new DomainError("invalid_link", "Нужна ссылка Zoom или номер встречи из 9–11 цифр");
}

export function parseMeetingLink(input: string): MeetingTarget {
  const text = input.trim();
  const bare = text.replace(/[\s-]/g, "");
  if (MEETING_NUMBER.test(bare)) return { meetingNumber: bare, passcode: null };

  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return invalid();
  }
  if (url.protocol !== "https:" || !ZOOM_HOST.test(url.hostname)) return invalid();
  const meetingNumber = PATH_NUMBER.exec(url.pathname)?.[1];
  if (meetingNumber === undefined || !MEETING_NUMBER.test(meetingNumber)) return invalid();
  const passcode = url.searchParams.get("pwd");
  return { meetingNumber, passcode: passcode === null || passcode === "" ? null : passcode };
}

/** The public join link, for opening the meeting in the Zoom app instead. */
export function joinUrl(meetingNumber: string, passcode: string | null): string {
  const url = new URL(`https://zoom.us/j/${meetingNumber}`);
  if (passcode !== null) url.searchParams.set("pwd", passcode);
  return url.toString();
}
