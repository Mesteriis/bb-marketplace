// Calendar invitations (slice 3l): reads the iCalendar part of a message
// (RFC 5545) into what the reading pane shows - what, when, where, who - and
// builds the reply an attendee sends to the organizer (RFC 5546, REPLY).
//
// The text comes from mail, so it is untrusted: every size is capped, text is
// stripped of control and invisible characters, and nothing in it is acted
// on. Only the first event is read; a repeating event shows its first
// occurrence and says that it repeats.
import { parseAddress } from "./compose-address.ts";
import { removeControls, removeInvisible } from "./html-entities.ts";

/** Calendar text beyond this is not read. */
export const INVITE_MAX_CHARS = 512 * 1024;
export const INVITE_MAX_LINES = 20_000;
export const INVITE_MAX_ATTENDEES = 50;
const SUMMARY_MAX = 300;
const DESCRIPTION_MAX = 2000;

export type InviteMethod = "request" | "cancel" | "reply" | "publish" | "other";
export type InviteAnswer = "accepted" | "tentative" | "declined";
export type InviteStatus = InviteAnswer | "needs_action" | "delegated" | "unknown";

/**
 * A start or an end. `utc` is the instant when the zone could be resolved
 * (a Z time, a zone the runtime knows, or one the file defines); `wall` is
 * the time as written ("2026-11-20T09:00", or "2026-11-20" for a whole day).
 */
export type InviteMoment = { utc: string | null; wall: string; zone: string | null; allDay: boolean };
export type InvitePerson = { name: string | null; address: string };
export type InviteAttendee = InvitePerson & { status: InviteStatus; optional: boolean };

export type InviteView = {
  method: InviteMethod;
  uid: string | null;
  sequence: number;
  summary: string;
  location: string | null;
  description: string | null;
  start: InviteMoment | null;
  /** For a whole-day event the day after the last one, as the file has it. */
  end: InviteMoment | null;
  organizer: InvitePerson | null;
  /** At most INVITE_MAX_ATTENDEES; `attendeesTotal` counts all of them. */
  attendees: InviteAttendee[];
  attendeesTotal: number;
  recurring: boolean;
  cancelled: boolean;
  /** The owner's own line among the attendees, when one of the owner's addresses is invited. */
  self: { address: string; status: InviteStatus } | null;
};

type Line = { name: string; params: Map<string, string>; value: string };
type Component = { name: string; lines: Line[]; children: Component[] };

/** Whether a stored attachment is a calendar part. */
export function isCalendarPart(part: { mimeType: string; filename: string | null }): boolean {
  const type = part.mimeType.trim().toLowerCase();
  if (type === "text/calendar" || type === "application/ics") return true;
  return type === "application/octet-stream" && /\.ics$/i.test(part.filename ?? "");
}

/** The invitation in calendar text, or null when there is no event to show. */
export function parseInvite(text: string, own: ReadonlySet<string> = new Set()): InviteView | null {
  const root = readComponents(text);
  const calendar = root.children.find((c) => c.name === "VCALENDAR");
  if (calendar === undefined) return null;
  const events = calendar.children.filter((c) => c.name === "VEVENT");
  // The master event of a series; an edited occurrence alone is shown as it is.
  const event = events.find((e) => first(e, "RECURRENCE-ID") === undefined) ?? events[0];
  if (event === undefined) return null;
  const zones = readZones(calendar);

  const methodText = (first(calendar, "METHOD")?.value ?? "").trim().toUpperCase();
  const method: InviteMethod =
    methodText === "REQUEST" ? "request" : methodText === "CANCEL" ? "cancel" : methodText === "REPLY" ? "reply" : methodText === "PUBLISH" ? "publish" : "other";
  const all = event.lines.filter((l) => l.name === "ATTENDEE").flatMap((l) => {
    const person = personOf(l);
    return person === null
      ? []
      : [{ ...person, status: statusOf(l.params.get("PARTSTAT")), optional: (l.params.get("ROLE") ?? "").toUpperCase() === "OPT-PARTICIPANT" }];
  });
  const organizerLine = first(event, "ORGANIZER");
  const selfLine = all.find((a) => own.has(a.address));
  const sequence = Number.parseInt(first(event, "SEQUENCE")?.value ?? "0", 10);
  return {
    method,
    uid: oneLine(first(event, "UID")?.value ?? "", 500) || null,
    sequence: Number.isSafeInteger(sequence) && sequence >= 0 ? sequence : 0,
    summary: oneLine(unescapeText(first(event, "SUMMARY")?.value ?? ""), SUMMARY_MAX),
    location: oneLine(unescapeText(first(event, "LOCATION")?.value ?? ""), SUMMARY_MAX) || null,
    description: manyLines(unescapeText(first(event, "DESCRIPTION")?.value ?? ""), DESCRIPTION_MAX) || null,
    start: momentOf(first(event, "DTSTART"), zones),
    end: momentOf(first(event, "DTEND"), zones),
    organizer: organizerLine === undefined ? null : personOf(organizerLine),
    attendees: all.slice(0, INVITE_MAX_ATTENDEES),
    attendeesTotal: all.length,
    recurring: first(event, "RRULE") !== undefined || first(event, "RDATE") !== undefined,
    cancelled: method === "cancel" || (first(event, "STATUS")?.value ?? "").trim().toUpperCase() === "CANCELLED",
    self: selfLine === undefined ? null : { address: selfLine.address, status: selfLine.status },
  };
}

// ---- Reading the text ----

function readComponents(text: string): Component {
  const root: Component = { name: "", lines: [], children: [] };
  const stack: Component[] = [root];
  const unfolded = text.slice(0, INVITE_MAX_CHARS).replace(/\r?\n[ \t]/g, "");
  let count = 0;
  for (const raw of unfolded.split(/\r?\n/)) {
    if (++count > INVITE_MAX_LINES) break;
    const line = readLine(raw);
    if (line === null) continue;
    const top = stack[stack.length - 1]!;
    if (line.name === "BEGIN") {
      const child: Component = { name: line.value.trim().toUpperCase(), lines: [], children: [] };
      top.children.push(child);
      stack.push(child);
    } else if (line.name === "END") {
      if (stack.length > 1 && top.name === line.value.trim().toUpperCase()) stack.pop();
    } else {
      top.lines.push(line);
    }
  }
  return root;
}

/** `NAME;PARAM=value;PARAM="quoted: value":value`, or null for a line that is not one. */
function readLine(raw: string): Line | null {
  let i = 0;
  while (i < raw.length && raw[i] !== ";" && raw[i] !== ":") i++;
  if (i === 0 || i >= raw.length) return null;
  const name = raw.slice(0, i).trim().toUpperCase();
  const params = new Map<string, string>();
  while (raw[i] === ";") {
    const eq = raw.indexOf("=", i);
    if (eq === -1) return null;
    const key = raw.slice(i + 1, eq).trim().toUpperCase();
    let value: string;
    let next = eq + 1;
    if (raw[next] === '"') {
      const close = raw.indexOf('"', next + 1);
      if (close === -1) return null;
      value = raw.slice(next + 1, close);
      next = close + 1;
    } else {
      while (next < raw.length && raw[next] !== ";" && raw[next] !== ":") next++;
      value = raw.slice(eq + 1, next);
    }
    if (!params.has(key)) params.set(key, value);
    i = next;
  }
  if (raw[i] !== ":") return null;
  return { name, params, value: raw.slice(i + 1) };
}

function first(component: Component, name: string): Line | undefined {
  return component.lines.find((l) => l.name === name);
}

/** RFC 5545 TEXT: `\n` is a line break; `\,` `\;` `\\` are the character. */
function unescapeText(value: string): string {
  return value.replace(/\\([nN,;\\])/g, (_, c: string) => (c === "n" || c === "N" ? "\n" : c));
}

function oneLine(text: string, max: number): string {
  return removeInvisible(removeControls(text.replace(/[\t\r\n]/g, " ")))
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function manyLines(text: string, max: number): string {
  return text
    .split(/\r?\n/)
    .map((line) => oneLine(line, max))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, max);
}

function personOf(line: Line): InvitePerson | null {
  const match = /^mailto:(.*)$/i.exec(line.value.trim());
  if (match === null) return null;
  const parsed = parseAddress(match[1]!);
  if (!parsed.ok) return null;
  const name = oneLine(line.params.get("CN") ?? "", 200);
  return { name: name === "" ? null : name, address: parsed.value.address.toLowerCase() };
}

function statusOf(partstat: string | undefined): InviteStatus {
  switch ((partstat ?? "").toUpperCase()) {
    case "ACCEPTED":
      return "accepted";
    case "DECLINED":
      return "declined";
    case "TENTATIVE":
      return "tentative";
    case "NEEDS-ACTION":
    case "":
      return "needs_action";
    case "DELEGATED":
      return "delegated";
    default:
      return "unknown";
  }
}

// ---- Times ----

type Wall = { y: number; mo: number; d: number; h: number; mi: number; s: number };
/** One STANDARD or DAYLIGHT block of a VTIMEZONE. */
type Observance = {
  offsetTo: number;
  onset: Wall;
  /** Yearly on the nth weekday of a month (nth -1 = the last), or null: the onset happens once. */
  rule: { month: number; nth: number; weekday: number } | null;
};

const pad = (n: number, width = 2) => String(n).padStart(width, "0");
const wallMs = (w: Wall) => Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s);

function readWall(value: string): { wall: Wall; utc: boolean } | null {
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z)?$/i.exec(value.trim());
  if (match === null) return null;
  const [y, mo, d, h, mi, s] = [1, 2, 3, 4, 5, 6].map((i) => Number(match[i] ?? "0")) as [number, number, number, number, number, number];
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 60) return null;
  return { wall: { y, mo, d, h, mi, s }, utc: match[7] !== undefined };
}

function momentOf(line: Line | undefined, zones: Map<string, Observance[]>): InviteMoment | null {
  if (line === undefined) return null;
  const value = line.value.trim();
  const day = /^(\d{4})(\d{2})(\d{2})$/.exec(value);
  if (day !== null) return { utc: null, wall: `${day[1]}-${day[2]}-${day[3]}`, zone: null, allDay: true };
  const read = readWall(value);
  if (read === null) return null;
  const w = read.wall;
  const wall = `${pad(w.y, 4)}-${pad(w.mo)}-${pad(w.d)}T${pad(w.h)}:${pad(w.mi)}`;
  if (read.utc) return { utc: new Date(wallMs(w)).toISOString(), wall, zone: "UTC", allDay: false };
  const zone = oneLine(line.params.get("TZID") ?? "", 100);
  if (zone === "") return { utc: null, wall, zone: null, allDay: false };
  const ms = knownZoneUtc(zone, w) ?? definedZoneUtc(zones.get(zone), w);
  return { utc: ms === null ? null : new Date(ms).toISOString(), wall, zone, allDay: false };
}

/** The instant of a wall time in a zone the runtime knows (an IANA name), or null. */
function knownZoneUtc(zone: string, w: Wall): number | null {
  let format: Intl.DateTimeFormat;
  try {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
  } catch {
    return null;
  }
  const offsetAt = (ms: number): number => {
    const parts = new Map(format.formatToParts(new Date(ms)).map((p) => [p.type, Number(p.value)]));
    const local = Date.UTC(parts.get("year")!, parts.get("month")! - 1, parts.get("day")!, parts.get("hour")!, parts.get("minute")!, parts.get("second")!);
    return local - ms;
  };
  const asUtc = wallMs(w);
  if (Number.isNaN(asUtc)) return null;
  // Two passes: the first guess may fall on the other side of a clock change.
  const guess = asUtc - offsetAt(asUtc);
  return asUtc - offsetAt(guess);
}

/** The instant of a wall time in a zone the file itself defines (Outlook's zone names), or null. */
function definedZoneUtc(observances: Observance[] | undefined, w: Wall): number | null {
  if (observances === undefined || observances.length === 0) return null;
  const at = wallMs(w);
  let best: { onset: number; offsetTo: number } | null = null;
  for (const o of observances) {
    const onsets =
      o.rule === null
        ? [wallMs(o.onset)]
        : [w.y, w.y - 1].filter((year) => year >= o.onset.y).map((year) => nthWeekday(year, o.rule!, o.onset));
    for (const onset of onsets) {
      if (onset <= at && (best === null || onset > best.onset)) best = { onset, offsetTo: o.offsetTo };
    }
  }
  // Before every onset the file gives: the earliest block is the best there is.
  const chosen = best ?? { offsetTo: [...observances].sort((a, b) => wallMs(a.onset) - wallMs(b.onset))[0]!.offsetTo };
  return at - chosen.offsetTo * 60_000;
}

/** The nth `weekday` of a month in `year`, at the onset's time of day. */
function nthWeekday(year: number, rule: { month: number; nth: number; weekday: number }, onset: Wall): number {
  let day: number;
  if (rule.nth > 0) {
    const firstDay = new Date(Date.UTC(year, rule.month - 1, 1)).getUTCDay();
    day = 1 + ((rule.weekday - firstDay + 7) % 7) + (rule.nth - 1) * 7;
  } else {
    const lastDate = new Date(Date.UTC(year, rule.month, 0));
    day = lastDate.getUTCDate() - ((lastDate.getUTCDay() - rule.weekday + 7) % 7) + (rule.nth + 1) * 7;
  }
  return Date.UTC(year, rule.month - 1, day, onset.h, onset.mi, onset.s);
}

const WEEKDAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

function readZones(calendar: Component): Map<string, Observance[]> {
  const zones = new Map<string, Observance[]>();
  for (const zone of calendar.children.filter((c) => c.name === "VTIMEZONE").slice(0, 20)) {
    const id = oneLine(first(zone, "TZID")?.value ?? "", 100);
    if (id === "" || zones.has(id)) continue;
    const observances: Observance[] = [];
    for (const block of zone.children.filter((c) => c.name === "STANDARD" || c.name === "DAYLIGHT").slice(0, 50)) {
      const offset = /^([+-])(\d{2})(\d{2})(\d{2})?$/.exec((first(block, "TZOFFSETTO")?.value ?? "").trim());
      const onset = readWall(first(block, "DTSTART")?.value ?? "");
      if (offset === null || onset === null) continue;
      const minutes = (Number(offset[2]) * 60 + Number(offset[3])) * (offset[1] === "-" ? -1 : 1);
      observances.push({ offsetTo: minutes, onset: onset.wall, rule: yearlyRule(first(block, "RRULE")?.value) });
    }
    zones.set(id, observances);
  }
  return zones;
}

/** `FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU`, the only shape zone definitions use; anything else is no rule. */
function yearlyRule(value: string | undefined): Observance["rule"] {
  if (value === undefined) return null;
  const parts = new Map(
    value.split(";").map((part) => {
      const eq = part.indexOf("=");
      return [part.slice(0, eq).trim().toUpperCase(), part.slice(eq + 1).trim().toUpperCase()] as const;
    }),
  );
  if (parts.get("FREQ") !== "YEARLY") return null;
  const month = Number(parts.get("BYMONTH"));
  const byDay = /^([+-]?\d)(SU|MO|TU|WE|TH|FR|SA)$/.exec(parts.get("BYDAY") ?? "");
  if (!Number.isInteger(month) || month < 1 || month > 12 || byDay === null) return null;
  const nth = Number(byDay[1]);
  if (nth === 0 || nth < -1 || nth > 5) return null;
  return { month, nth, weekday: WEEKDAYS.indexOf(byDay[2]!) };
}

// ---- The reply ----

export const INVITE_ANSWER_PARTSTAT: Record<InviteAnswer, string> = {
  accepted: "ACCEPTED",
  tentative: "TENTATIVE",
  declined: "DECLINED",
};

/** A value safe inside calendar TEXT: escaped, on one line. */
function escapeText(value: string): string {
  return oneLine(value, 500).replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,");
}

/** A CN parameter value: quoted, without the characters a quoted value cannot hold. */
function quoteParam(value: string): string {
  return `"${oneLine(value, 200).replace(/["\\]/g, "")}"`;
}

/** Folds a content line at 75 octets (RFC 5545 section 3.1). */
function fold(line: string): string {
  const bytes = new TextEncoder();
  const out: string[] = [];
  let current = "";
  let size = 0;
  for (const char of line) {
    const width = bytes.encode(char).length;
    if (size + width > (out.length === 0 ? 75 : 74)) {
      out.push(current);
      current = "";
      size = 0;
    }
    current += char;
    size += width;
  }
  out.push(current);
  return out.join("\r\n ");
}

/**
 * The calendar text of an attendee's answer (METHOD:REPLY): the event's UID
 * and SEQUENCE, the organizer, and the one attendee with the answer. Null
 * when the invitation cannot be answered (no UID, no organizer).
 */
export function buildInviteReply(
  invite: Pick<InviteView, "uid" | "sequence" | "summary" | "organizer">,
  attendee: InvitePerson,
  answer: InviteAnswer,
  now: Date,
): string | null {
  if (invite.uid === null || invite.organizer === null) return null;
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const organizerName = invite.organizer.name === null ? "" : `;CN=${quoteParam(invite.organizer.name)}`;
  const attendeeName = attendee.name === null ? "" : `;CN=${quoteParam(attendee.name)}`;
  const lines = [
    "BEGIN:VCALENDAR",
    "PRODID:-//Makosh//Mail//EN",
    "VERSION:2.0",
    "METHOD:REPLY",
    "BEGIN:VEVENT",
    // As read: the UID was never unescaped, and it is one line without control characters.
    `UID:${invite.uid}`,
    `SEQUENCE:${invite.sequence}`,
    `DTSTAMP:${stamp}`,
    `ORGANIZER${organizerName}:mailto:${invite.organizer.address}`,
    `ATTENDEE;PARTSTAT=${INVITE_ANSWER_PARTSTAT[answer]}${attendeeName}:mailto:${attendee.address}`,
    ...(invite.summary === "" ? [] : [`SUMMARY:${escapeText(invite.summary)}`]),
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return `${lines.map(fold).join("\r\n")}\r\n`;
}
