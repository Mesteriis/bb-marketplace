// Sender check (slice 3i, #39): what the account's own provider said about a
// message's sender in its topmost trusted Authentication-Results header,
// reduced to a state Mail can act on. Pure: Mail verifies nothing itself (no
// DNS, no DKIM library); it reads the provider's words with 3e's
// trusted-results rule (`trustedAuthResults`) and never claims more than
// they say. `ok` drives nothing visible; only a failure warns.
//
// Every header value here is the sender's or a relay's and is untrusted:
// domains are kept in ASCII form only, results as one of a fixed set.
import { splitAddressList, toAsciiDomain } from "./compose-address.ts";
import type { AccountPreset, MailAddress, SpecialUse } from "./model.ts";
import { TRUSTED_AUTHSERV, trustedAuthResults, type AuthEntry, type HeaderLine } from "./unsubscribe.ts";

export const AUTH_RESULT_VALUES = ["pass", "fail", "softfail", "neutral", "none", "temperror", "permerror", "policy"] as const;
export type AuthResult = (typeof AUTH_RESULT_VALUES)[number];

export const SENDER_CHECK_STATES = ["ok", "failed", "unchecked", "unknown"] as const;
/** `unknown`: not judged yet (a row synced before 3i, or one whose basis changed). */
export type SenderCheckState = (typeof SENDER_CHECK_STATES)[number];

/**
 * Why the state is what it is: `results` the provider's header was read;
 * `no_results` the preset trusts an id but none was found in the top block;
 * `provider` the preset trusts no id (other servers, iCloud until pinned);
 * `own` a Sent or Drafts copy or an outbox copy.
 */
export const SENDER_CHECK_BASES = ["results", "no_results", "provider", "own"] as const;
export type SenderCheckBasis = (typeof SENDER_CHECK_BASES)[number];

export type SenderCheck = {
  state: SenderCheckState;
  /** Null for `unknown`. */
  basis: SenderCheckBasis | null;
  /** The trusted authserv-id that was read; null when none was. */
  authserv: string | null;
  /** What decided `ok` or `failed`; null otherwise. */
  decidedBy: "dmarc" | "spf" | "dkim" | null;
  spf: { result: AuthResult; domain: string | null } | null;
  /** In header order, at most DKIM_KEPT. */
  dkim: { result: AuthResult; domain: string | null; aligned: boolean }[];
  /** The worst DMARC result for the From domain; null when there is none. */
  dmarc: { result: AuthResult; domain: string | null } | null;
  /** DMARC entries for another domain: kept for Details, never decide (resolution 4.3). At most 3. */
  otherDmarc: { result: AuthResult; domain: string | null }[];
  /** More than one From line or mailbox: never `ok` (resolution 4.5). */
  multipleFrom: boolean;
  /** The provider's header was cut or could not be read in full: never `ok`. */
  malformed: boolean;
  /** Further trusted-id headers in the top block that were not used (resolution 4.1). */
  alsoPresent: number;
};

const DKIM_KEPT = 5;
const OTHER_DMARC_KEPT = 3;

/** Second-level labels under which a registrable name takes three labels (`example.co.uk`). */
const COUNTRY_SECOND_LEVEL = new Set(["co", "com", "net", "org", "ac", "gov", "edu", "ne", "or", "go"]);

/** The domain in ASCII lower case without a trailing dot; null when it is not a usable name. */
export function asciiDomainOf(domain: string | null | undefined): string | null {
  if (domain === null || domain === undefined) return null;
  const trimmed = domain.trim().replace(/\.$/, "");
  if (trimmed === "" || trimmed.length > 253) return null;
  try {
    return toAsciiDomain(trimmed);
  } catch {
    return null;
  }
}

/** The domain part of an address, ASCII lower case; null without one. */
export function addressDomain(address: string): string | null {
  const at = address.lastIndexOf("@");
  return at === -1 ? null : asciiDomainOf(address.slice(at + 1));
}

/**
 * The registrable ("organizational") domain by a heuristic without the
 * public suffix list (no dependency): the last two labels, or the last three
 * when the second-to-last is a common country second level and the last is
 * two letters (`a.b.example.co.uk` gives `example.co.uk`). ASCII (punycode) form.
 * It can be wrong; a wrong answer shows or hides a warning, never blocks mail.
 */
export function orgDomain(domain: string): string {
  const ascii = asciiDomainOf(domain) ?? domain.trim().toLowerCase().replace(/\.$/, "");
  const labels = ascii.split(".");
  if (labels.length <= 2) return ascii;
  const last = labels[labels.length - 1] ?? "";
  const second = labels[labels.length - 2] ?? "";
  const take = /^[a-z]{2}$/.test(last) && COUNTRY_SECOND_LEVEL.has(second) ? 3 : 2;
  return labels.slice(-take).join(".");
}

const SEVERITY: Record<AuthResult, number> = {
  pass: 0,
  none: 1,
  neutral: 2,
  policy: 3,
  temperror: 4,
  permerror: 5,
  softfail: 6,
  fail: 7,
};

/** A result as one of the fixed set; anything else (`bestguesspass`, `hardfail`) reads as `neutral`. */
function resultOf(text: string): AuthResult {
  return (AUTH_RESULT_VALUES as readonly string[]).includes(text) ? (text as AuthResult) : "neutral";
}

function worst(results: readonly AuthResult[]): AuthResult | null {
  let out: AuthResult | null = null;
  for (const result of results) if (out === null || SEVERITY[result] > SEVERITY[out]) out = result;
  return out;
}

function mailfromDomain(value: string | null): string | null {
  if (value === null) return null;
  const at = value.lastIndexOf("@");
  return asciiDomainOf(at === -1 ? value : value.slice(at + 1));
}

function dkimDomain(entry: AuthEntry): string | null {
  const i = entry.headerI;
  const iDomain = i !== null && i.includes("@") ? i.slice(i.lastIndexOf("@") + 1) : null;
  return asciiDomainOf(entry.headerD ?? iDomain);
}

function fromCount(headers: HeaderLine[]): { lines: number; mailboxes: number } {
  const lines = headers.filter((line) => line.key.toLowerCase() === "from");
  const first = lines[0];
  const mailboxes = first === undefined ? 1 : splitAddressList(first.value.slice(0, 2_048)).filter((part) => part.trim() !== "").length;
  return { lines: lines.length, mailboxes };
}

function blank(state: SenderCheckState, basis: SenderCheckBasis | null): SenderCheck {
  return {
    state,
    basis,
    authserv: null,
    decidedBy: null,
    spf: null,
    dkim: [],
    dmarc: null,
    otherDmarc: [],
    multipleFrom: false,
    malformed: false,
    alsoPresent: 0,
  };
}

/** The check of a message not judged yet (a NULL `sender_check_json`). */
export const UNKNOWN_SENDER_CHECK: SenderCheck = Object.freeze(blank("unknown", null)) as SenderCheck;

/**
 * The sender check of one message from its kept header lines (part A
 * "Sender check" with resolutions 3, 4): the topmost trusted A-R only, the
 * worst result per method, DMARC only for the From domain, relaxed
 * alignment by `orgDomain`. Sent and Drafts copies and outbox copies are not
 * judged; every other folder is, whoever From claims.
 */
export function senderCheckOf(
  headers: HeaderLine[],
  preset: AccountPreset,
  from: MailAddress,
  options: { folderRole: SpecialUse | null; outbox?: boolean },
): SenderCheck {
  if (options.outbox === true || options.folderRole === "sent" || options.folderRole === "drafts") return blank("unchecked", "own");
  const found = trustedAuthResults(headers, preset);
  if (found === null) return blank("unchecked", "provider");
  const top = found.counted[0];
  if (top === undefined) return blank("unchecked", "no_results");

  const fromDomain = addressDomain(from.address);
  const fromOrg = fromDomain === null ? null : orgDomain(fromDomain);
  const counts = fromCount(headers);
  const multipleFrom = counts.lines > 1 || counts.mailboxes > 1;

  const spfEntries = top.entries.filter((entry) => entry.method === "spf");
  const spfWorst = worst(spfEntries.map((entry) => resultOf(entry.result)));
  const spfShown = spfEntries.find((entry) => resultOf(entry.result) === spfWorst) ?? null;

  const dkimAll = top.entries
    .filter((entry) => entry.method === "dkim")
    .map((entry) => {
      const domain = dkimDomain(entry);
      return { result: resultOf(entry.result), domain, aligned: domain !== null && fromOrg !== null && orgDomain(domain) === fromOrg };
    });
  const aligned = dkimAll.filter((entry) => entry.aligned);
  const alignedPass = aligned.length > 0 && worst(aligned.map((entry) => entry.result)) === "pass";

  const dmarcAll = top.entries
    .filter((entry) => entry.method === "dmarc")
    .map((entry) => ({ result: resultOf(entry.result), domain: asciiDomainOf(entry.headerFrom) }));
  const dmarcOwn = dmarcAll.filter((entry) => fromDomain !== null && entry.domain === fromDomain);
  const dmarcWorst = worst(dmarcOwn.map((entry) => entry.result));

  let state: SenderCheckState = "unchecked";
  let decidedBy: SenderCheck["decidedBy"] = null;
  if (dmarcWorst === "fail") {
    state = "failed";
    decidedBy = "dmarc";
  } else if (dmarcWorst === "pass") {
    state = "ok";
    decidedBy = "dmarc";
  } else if (spfWorst === "fail" && !alignedPass) {
    // Only pass and fail are DMARC answers; none, neutral and errors fall through.
    state = "failed";
    decidedBy = "spf";
  } else if (alignedPass) {
    state = "ok";
    decidedBy = "dkim";
  }
  if (state === "ok" && (multipleFrom || top.malformed)) {
    state = "unchecked";
    decidedBy = null;
  }

  return {
    state,
    basis: "results",
    authserv: top.authservId,
    decidedBy,
    spf: spfWorst === null ? null : { result: spfWorst, domain: mailfromDomain(spfShown?.smtpMailfrom ?? null) },
    dkim: dkimAll.slice(0, DKIM_KEPT),
    dmarc: dmarcWorst === null ? null : { result: dmarcWorst, domain: fromDomain },
    otherDmarc: dmarcAll.filter((entry) => !dmarcOwn.includes(entry)).slice(0, OTHER_DMARC_KEPT),
    multipleFrom,
    malformed: top.malformed,
    alsoPresent: found.counted.length - 1,
  };
}

/**
 * Whether an always-show sender's images may load by themselves (part A
 * resolution 5): only for `ok` or `unchecked` and no lookalike or
 * name-shows-address warning. `unknown` waits for the refresh.
 */
export function autoImagesAllowed(
  check: { state: SenderCheckState } | null,
  warnings: readonly { kind: string }[],
): boolean {
  if (check === null || (check.state !== "ok" && check.state !== "unchecked")) return false;
  return !warnings.some((warning) => warning.kind === "lookalike" || warning.kind === "name_shows_address");
}

const NOT_READ = "Not checked: Mail does not read this server's results";

/** Fixed words for the header view; null for `ok` (a pass is never a badge, decision 6). */
export function senderCheckSummary(check: SenderCheck): string | null {
  switch (check.state) {
    case "ok":
      return null;
    case "unknown":
      return "Not checked yet";
    case "failed":
      return check.decidedBy === "spf" ? "SPF failed and no aligned DKIM signature passed" : "DMARC failed";
    case "unchecked":
      if (check.basis === "own") return "Not checked: your own mail";
      if (check.basis === "provider") return NOT_READ;
      if (check.basis === "no_results") return "Not checked: no results from your mail provider";
      if (check.multipleFrom) return "Not checked: more than one sender in From";
      if (check.malformed) return "Not checked: the provider's results could not be read in full";
      return "Not checked: the provider's results do not confirm the sender";
  }
}

const where = (domain: string | null) => (domain === null ? "" : ` (${domain})`);

/** The Details "Authenticity" lines: the provider's results in a fixed format, values as ASCII data. */
export function authenticityLines(check: SenderCheck): string[] {
  if (check.state === "unknown") return ["Not checked yet"];
  if (check.basis !== "results") {
    const summary = senderCheckSummary(check);
    return summary === null ? [] : [summary];
  }
  const lines: string[] = [];
  if (check.spf !== null) lines.push(`SPF ${check.spf.result}${where(check.spf.domain)}`);
  for (const entry of check.dkim) {
    const domain = entry.domain ?? "no domain";
    lines.push(`DKIM ${entry.result} (${domain}, ${entry.aligned ? "aligned" : "not aligned"})`);
  }
  if (check.dmarc !== null) lines.push(`DMARC ${check.dmarc.result}${where(check.dmarc.domain)}`);
  for (const entry of check.otherDmarc) lines.push(`DMARC ${entry.result} (${entry.domain ?? "no domain"}, not the From domain)`);
  if (lines.length === 0) lines.push("No SPF, DKIM or DMARC results");
  if (check.multipleFrom) lines.push("More than one sender in From");
  if (check.malformed) lines.push("The results were cut or could not be read in full");
  if (check.alsoPresent > 0) lines.push(`Also present: ${check.alsoPresent} more result header${check.alsoPresent === 1 ? "" : "s"} from this server (not used)`);
  return lines;
}

const isResult = (value: unknown): value is AuthResult => typeof value === "string" && (AUTH_RESULT_VALUES as readonly string[]).includes(value);
const isDomain = (value: unknown): value is string | null => value === null || (typeof value === "string" && value.length <= 253);
const isEntry = (value: unknown): value is { result: AuthResult; domain: string | null } =>
  typeof value === "object" && value !== null && isResult((value as { result?: unknown }).result) && isDomain((value as { domain?: unknown }).domain);

/**
 * The stored check (`messages.sender_check_json`) as the page and agents see
 * it. NULL or anything malformed is `unknown`. A check stored when the preset
 * trusted no id reads as `unknown` once the preset trusts one (pinning
 * iCloud's id rechecks old iCloud mail on open, resolution 7).
 */
export function readStoredCheck(json: string | null, preset: AccountPreset): SenderCheck {
  if (json === null) return UNKNOWN_SENDER_CHECK;
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return UNKNOWN_SENDER_CHECK;
  }
  if (typeof value !== "object" || value === null) return UNKNOWN_SENDER_CHECK;
  const v = value as Record<string, unknown>;
  const state = v.state;
  const basis = v.basis;
  if (state !== "ok" && state !== "failed" && state !== "unchecked") return UNKNOWN_SENDER_CHECK;
  if (typeof basis !== "string" || !(SENDER_CHECK_BASES as readonly string[]).includes(basis)) return UNKNOWN_SENDER_CHECK;
  if (v.authserv !== null && typeof v.authserv !== "string") return UNKNOWN_SENDER_CHECK;
  if (v.decidedBy !== null && v.decidedBy !== "dmarc" && v.decidedBy !== "spf" && v.decidedBy !== "dkim") return UNKNOWN_SENDER_CHECK;
  if (v.spf !== null && !isEntry(v.spf)) return UNKNOWN_SENDER_CHECK;
  if (v.dmarc !== null && !isEntry(v.dmarc)) return UNKNOWN_SENDER_CHECK;
  if (!Array.isArray(v.dkim) || v.dkim.length > DKIM_KEPT) return UNKNOWN_SENDER_CHECK;
  if (!v.dkim.every((entry) => isEntry(entry) && typeof (entry as { aligned?: unknown }).aligned === "boolean")) {
    return UNKNOWN_SENDER_CHECK;
  }
  if (!Array.isArray(v.otherDmarc) || v.otherDmarc.length > OTHER_DMARC_KEPT || !v.otherDmarc.every(isEntry)) return UNKNOWN_SENDER_CHECK;
  if (typeof v.multipleFrom !== "boolean" || typeof v.malformed !== "boolean") return UNKNOWN_SENDER_CHECK;
  if (typeof v.alsoPresent !== "number" || !Number.isInteger(v.alsoPresent) || v.alsoPresent < 0) return UNKNOWN_SENDER_CHECK;
  if (state === "unchecked" && basis === "provider" && v.authserv === null && TRUSTED_AUTHSERV[preset].length > 0) {
    return UNKNOWN_SENDER_CHECK;
  }
  return {
    state,
    basis: basis as SenderCheckBasis,
    authserv: v.authserv as string | null,
    decidedBy: v.decidedBy as SenderCheck["decidedBy"],
    spf: v.spf as SenderCheck["spf"],
    dkim: v.dkim as SenderCheck["dkim"],
    dmarc: v.dmarc as SenderCheck["dmarc"],
    otherDmarc: v.otherDmarc as SenderCheck["otherDmarc"],
    multipleFrom: v.multipleFrom,
    malformed: v.malformed,
    alsoPresent: v.alsoPresent,
  };
}
