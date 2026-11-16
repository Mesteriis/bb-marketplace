// Sender check (slice 3i, #39): what the account's own provider said about a
// message's sender in its topmost trusted Authentication-Results header,
// reduced to a state Mail can act on. Pure: Mail verifies nothing itself (no
// DNS, no DKIM library); it reads the provider's words with 3e's
// trusted-results rule (`trustedAuthResults`) and never claims more than
// they say. `ok` drives nothing visible; only a failure warns.
//
// Every header value here is the sender's or a relay's and is untrusted:
// domains are kept in ASCII form only, results as one of a fixed set.
import { splitAddressList } from "./compose-address.ts";
import type { AccountPreset, MailAddress, SpecialUse } from "./model.ts";
import { addressDomain, asciiDomainOf, orgDomain } from "./sender-basics.ts";
import { TRUSTED_AUTHSERV, trustedAuthResults, type AuthEntry, type HeaderLine } from "./unsubscribe.ts";

export const AUTH_RESULT_VALUES = ["pass", "fail", "softfail", "neutral", "none", "temperror", "permerror", "policy"] as const;
export type AuthResult = (typeof AUTH_RESULT_VALUES)[number];

export { SENDER_CHECK_STATES, type SenderCheckState } from "./sender-basics.ts";
// The zod-free helpers the page bundles live in sender-basics.ts (no import
// chain to zod); they stay exported from here for the core's callers.
export { addressDomain, asciiDomainOf, autoImagesAllowed, orgDomain } from "./sender-basics.ts";
import type { SenderCheckState } from "./sender-basics.ts";

/**
 * Why the state is what it is: `results` the provider's header was read;
 * `no_results` the preset trusts an id but none was found in the top block;
 * `provider` the preset trusts no id (other servers, iCloud until pinned);
 * `own` a Sent or Drafts copy (the plugin's outbox copies reach the store
 * only through the Sent folder's sync, so the folder role covers them).
 */
export const SENDER_CHECK_BASES = ["results", "no_results", "provider", "own"] as const;
export type SenderCheckBasis = (typeof SENDER_CHECK_BASES)[number];

export type SenderCheck = {
  state: SenderCheckState;
  /** Null for `unknown`. */
  basis: SenderCheckBasis | null;
  /** The trusted authserv-id that was read; null when none was. */
  authserv: string | null;
  /**
   * What decided `ok` or `failed`; null otherwise. A `failed` with null is an
   * anomaly (slice 3i review): `multipleFrom`, `malformed`, or DMARC only for
   * another domain.
   */
  decidedBy: "dmarc" | "spf" | "dkim" | null;
  spf: { result: AuthResult; domain: string | null } | null;
  /** In header order, at most DKIM_KEPT. */
  dkim: { result: AuthResult; domain: string | null; aligned: boolean }[];
  /** The worst DMARC result for the From domain; null when there is none. */
  dmarc: { result: AuthResult; domain: string | null } | null;
  /** DMARC entries for another domain: kept for Details, never decide (resolution 4.3). At most 3. */
  otherDmarc: { result: AuthResult; domain: string | null }[];
  /** More than one From line or mailbox: `failed` (resolution 4.5 as changed by the slice 3i review). */
  multipleFrom: boolean;
  /** The provider's header was cut or could not be read in full: `failed` (slice 3i review). */
  malformed: boolean;
  /** Further trusted-id headers in the top block that were not used (resolution 4.1). */
  alsoPresent: number;
};

const DKIM_KEPT = 5;
const OTHER_DMARC_KEPT = 3;

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
 * Whether the provider's results cannot be tied to the From Mail shows
 * (slice 3i review, findings 1 and 9): more than one sender in From, a
 * header that could not be read in full, or DMARC results that all name
 * another domain (an entry naming none says nothing either way). Such a
 * check is `failed`, so it drives nothing: no dev class, no rule, no alert,
 * no automatic images, and the strip says why.
 */
function anomalyOf(check: Pick<SenderCheck, "multipleFrom" | "malformed" | "dmarc" | "otherDmarc">): string | null {
  if (check.multipleFrom) return "more than one sender in From";
  if (check.malformed) return "the provider's results could not be read in full";
  if (check.dmarc === null && check.otherDmarc.some((entry) => entry.domain !== null)) {
    return "the provider's DMARC result names another domain";
  }
  return null;
}

/** The check with an anomaly made `failed` (decided by nothing); a failure the results decided stays as it is. */
function withAnomaly(check: SenderCheck): SenderCheck {
  if (check.basis !== "results" || check.state === "failed" || anomalyOf(check) === null) return check;
  return { ...check, state: "failed", decidedBy: null };
}

/**
 * The check cut to fit `maxBytes` serialized (slice 3i review, finding 3):
 * Details' extras go first (DMARC for other domains, then DKIM entries not
 * aligned, then the rest from the end), then every domain; the state, its
 * basis and what decided it always stay, so a failure is never lost.
 */
export function fitSenderCheck(check: SenderCheck, maxBytes: number): SenderCheck {
  const size = (value: SenderCheck) => new TextEncoder().encode(JSON.stringify(value)).length;
  let out = check;
  while (size(out) > maxBytes && out.otherDmarc.length > 0) out = { ...out, otherDmarc: out.otherDmarc.slice(0, -1) };
  while (size(out) > maxBytes && out.dkim.length > 0) {
    let drop = out.dkim.length - 1;
    for (let index = out.dkim.length - 1; index >= 0; index -= 1) {
      if (!out.dkim[index]!.aligned) {
        drop = index;
        break;
      }
    }
    out = { ...out, dkim: out.dkim.filter((_, index) => index !== drop) };
  }
  if (size(out) > maxBytes) {
    out = {
      ...out,
      spf: out.spf === null ? null : { ...out.spf, domain: null },
      dmarc: out.dmarc === null ? null : { ...out.dmarc, domain: null },
    };
  }
  if (size(out) > maxBytes) out = { ...out, authserv: null };
  return out;
}

/**
 * The sender check of one message from its kept header lines (part A
 * "Sender check" with resolutions 3, 4): the topmost trusted A-R only, the
 * worst result per method, DMARC only for the From domain, relaxed
 * alignment by `orgDomain`. Sent and Drafts copies are not judged; every
 * other folder is, whoever From claims. An anomaly (`anomalyOf`) is `failed`.
 */
export function senderCheckOf(
  headers: HeaderLine[],
  preset: AccountPreset,
  from: MailAddress,
  options: { folderRole: SpecialUse | null },
): SenderCheck {
  if (options.folderRole === "sent" || options.folderRole === "drafts") return blank("unchecked", "own");
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

  return withAnomaly({
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
    alsoPresent: found.counted.length - 1 + found.more,
  });
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
      if (check.decidedBy === "spf") return "SPF failed and no aligned DKIM signature passed";
      if (check.decidedBy === "dmarc") return "DMARC failed";
      return anomalyOf(check) ?? "DMARC failed";
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
  // A check stored before the slice 3i review kept an anomaly `unchecked`.
  return withAnomaly({
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
  });
}
