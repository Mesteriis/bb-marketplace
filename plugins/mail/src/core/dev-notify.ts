// Developer notifications (slice 3g, #37): GitHub, GitLab, other CI and
// monitoring mail recognised locally from a few headers, the sender and the
// subject. No model, no network. Pure.
//
// The sender address and these headers can be forged like any mail header;
// the class only groups mail and feeds the owner's own rules, which never
// start anything outside the caps and the managed worktree.

export const DEV_SOURCES = ["github", "gitlab", "ci", "monitoring"] as const;
export type DevSource = (typeof DEV_SOURCES)[number];
export const DEV_KINDS = ["ci", "pr", "mr", "issue", "review", "release", "security", "alert", "other"] as const;
export type DevKind = (typeof DEV_KINDS)[number];
export const DEV_STATES = ["failed", "passed", "cancelled", "firing", "resolved"] as const;
export type DevState = (typeof DEV_STATES)[number];

/**
 * A notification's class. `repo` is "host/owner/repo" in lower case for
 * GitHub and GitLab, "owner/repo" for other CI when the subject names one,
 * and the sending service ("grafana", "sentry", ...) for monitoring. `ref` is
 * a PR, issue or MR number or a run or incident number.
 */
export type DevClass = {
  source: DevSource;
  repo: string | null;
  kind: DevKind;
  state: DevState | null;
  ref: string | null;
};

/**
 * Header fields asked at sync beside the existing ones. GitHub's and
 * GitLab's are documented; monitoring mail is recognised by sender and
 * subject only (the live check confirms the names).
 */
export const DEV_HEADER_FIELDS = [
  "X-GitHub-Reason",
  "X-GitLab-Project-Path",
  "X-GitLab-Pipeline-Status",
  "X-GitLab-Pipeline-Id",
  "X-GitLab-MergeRequest-IID",
  "X-GitLab-Issue-IID",
] as const;

/** Header values keyed by lower-case field name. */
export type DevHeaders = ReadonlyMap<string, string>;

export type DevInput = {
  /** The From address. */
  from: string;
  subject: string;
  headers: DevHeaders | null;
  /** normalizeListId's value, or null. */
  listId: string | null;
  /**
   * Hosts of the BB projects' remotes (lower case). A self-hosted GitLab or
   * a Jenkins sender counts only from one of them, or with a List-Id of its
   * own domain.
   */
  knownHosts?: ReadonlySet<string>;
};

const LIST_ID_MAX = 200;
const LIST_ID = /^[a-z0-9][a-z0-9._+-]*$/;

/** The <id> part of a List-Id value, lower case, at most 200 characters; null when absent or odd. */
export function normalizeListId(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  const open = trimmed.lastIndexOf("<");
  const close = trimmed.lastIndexOf(">");
  const id = (open !== -1 && close > open ? trimmed.slice(open + 1, close) : trimmed).trim().toLowerCase();
  if (id === "" || id.length > LIST_ID_MAX || !LIST_ID.test(id)) return null;
  return id;
}

function header(headers: DevHeaders | null, name: string): string | null {
  const value = headers?.get(name.toLowerCase());
  return value === undefined || value.trim() === "" ? null : value.trim();
}

function addressParts(from: string): { local: string; domain: string } {
  const address = from.trim().toLowerCase();
  const at = address.lastIndexOf("@");
  return at === -1 ? { local: address, domain: "" } : { local: address.slice(0, at), domain: address.slice(at + 1) };
}

function domainIs(domain: string, base: string): boolean {
  return domain === base || domain.endsWith(`.${base}`);
}

/** The List-Id names the sender's own domain (a list run by that service). */
function listOfDomain(listId: string | null, domain: string): boolean {
  return listId !== null && domain !== "" && domainIs(listId, domain);
}

/** A sender outside the fixed service domains is taken only from a project remote's host or with its own List-Id. */
function vouched(input: DevInput, domain: string): boolean {
  return (domain !== "" && input.knownHosts?.has(domain) === true) || listOfDomain(input.listId, domain);
}

/** "failed", "passed" or "cancelled" from fixed words of a CI subject or status. */
function ciState(text: string): DevState | null {
  const lower = text.toLowerCase();
  if (/\b(cancell?ed|canceled|aborted)\b/.test(lower)) return "cancelled";
  if (/\b(fail(ed|ure|ing)?|broken|errored)\b/.test(lower)) return "failed";
  if (/\b(succeeded|success(ful)?|passed|fixed|back to normal)\b/.test(lower)) return "passed";
  return null;
}

const BRACKET_REPO = /\[([A-Za-z0-9_.-]{1,100})\/([A-Za-z0-9_.-]{1,100})\]/;
const SLASH_REPO = /\b([A-Za-z0-9_.-]{1,100})\/([A-Za-z0-9_.-]{1,100})\b/;

/** GitHub sends notifications from these two addresses only. */
const GITHUB_SENDERS = new Set(["notifications@github.com", "noreply@github.com"]);

function githubRepo(listId: string | null, subject: string): string | null {
  if (listId !== null && listId.endsWith(".github.com")) {
    const parts = listId.slice(0, -".github.com".length).split(".");
    if (parts.length === 2 && parts[0] !== "" && parts[1] !== "") return `github.com/${parts[1]}/${parts[0]}`;
  }
  const bracket = BRACKET_REPO.exec(subject);
  return bracket === null ? null : `github.com/${bracket[1]!.toLowerCase()}/${bracket[2]!.toLowerCase()}`;
}

function classifyGithub(input: DevInput): DevClass | null {
  if (!GITHUB_SENDERS.has(input.from.trim().toLowerCase())) return null;
  const reason = header(input.headers, "X-GitHub-Reason")?.toLowerCase() ?? null;
  const listed = input.listId !== null && input.listId.endsWith(".github.com");
  const bracket = BRACKET_REPO.test(input.subject);
  // Marketing and account mail from the same addresses has none of these.
  if (!listed && reason === null && !bracket) return null;
  const subject = input.subject;
  const repo = githubRepo(input.listId, subject);
  const pr = /\(PR #(\d{1,9})\)/.exec(subject);
  const issue = /\(Issue #(\d{1,9})\)/.exec(subject);
  const plain = /\(#(\d{1,9})\)/.exec(subject);
  const ref = pr?.[1] ?? issue?.[1] ?? plain?.[1] ?? null;
  const base = { source: "github" as const, repo };
  if (reason === "ci_activity" || /\bRun (failed|succeeded|cancell?ed)\b/i.test(subject) || /\bworkflow run\b/i.test(subject)) {
    return { ...base, kind: "ci", state: ciState(subject), ref: null };
  }
  if (reason === "security_alert" || /\bDependabot\b/i.test(subject) || /\bsecurity (alert|advisory)\b/i.test(subject)) {
    return { ...base, kind: "security", state: null, ref };
  }
  if (reason === "review_requested") return { ...base, kind: "review", state: null, ref };
  if (pr !== null) return { ...base, kind: "pr", state: null, ref };
  if (issue !== null) return { ...base, kind: "issue", state: null, ref };
  if (/\]\s+Release\b/.test(subject)) return { ...base, kind: "release", state: null, ref: null };
  return { ...base, kind: "other", state: null, ref };
}

function classifyGitlab(input: DevInput): DevClass | null {
  const { local, domain } = addressParts(input.from);
  const path = header(input.headers, "X-GitLab-Project-Path");
  if (path === null && local !== "gitlab") return null;
  const gitlabCom = domainIs(domain, "gitlab.com");
  // The header and "gitlab@" can be sent by anyone: a self-hosted GitLab must be vouched for (review).
  if (!gitlabCom && !vouched(input, domain)) return null;
  const host = gitlabCom ? "gitlab.com" : domain;
  const repoPath = path === null ? null : path.toLowerCase().replace(/^\/+|\/+$/g, "");
  const repo = repoPath === null || repoPath === "" || host === "" ? null : `${host}/${repoPath}`;
  const base = { source: "gitlab" as const, repo };
  const status = header(input.headers, "X-GitLab-Pipeline-Status");
  if (status !== null || /\bpipeline\b/i.test(input.subject)) {
    return { ...base, kind: "ci", state: ciState(status ?? input.subject), ref: header(input.headers, "X-GitLab-Pipeline-Id") };
  }
  const mr = header(input.headers, "X-GitLab-MergeRequest-IID") ?? /\(!(\d{1,9})\)/.exec(input.subject)?.[1] ?? null;
  if (mr !== null) return { ...base, kind: "mr", state: null, ref: mr };
  const issue = header(input.headers, "X-GitLab-Issue-IID") ?? /\(#(\d{1,9})\)/.exec(input.subject)?.[1] ?? null;
  if (issue !== null) return { ...base, kind: "issue", state: null, ref: issue };
  return { ...base, kind: "other", state: null, ref: null };
}

/** CI services recognised by sender domain. */
const CI_DOMAINS = ["circleci.com", "buildkite.com", "travis-ci.com", "travis-ci.org", "drone.io"];

function classifyCi(input: DevInput): DevClass | null {
  const { local, domain } = addressParts(input.from);
  if (!CI_DOMAINS.some((base) => domainIs(domain, base)) && !(local === "jenkins" && vouched(input, domain))) return null;
  const slash = SLASH_REPO.exec(input.subject);
  const ref = /#(\d{1,12})\b/.exec(input.subject)?.[1] ?? null;
  return {
    source: "ci",
    repo: slash === null ? null : `${slash[1]!.toLowerCase()}/${slash[2]!.toLowerCase()}`,
    kind: "ci",
    state: ciState(input.subject),
    ref,
  };
}

/** Monitoring services by sender domain, named as the class's repo. */
const MONITORING_DOMAINS: [string, string][] = [
  ["sentry.io", "sentry"],
  ["getsentry.com", "sentry"],
  ["grafana.net", "grafana"],
  ["grafana.com", "grafana"],
  ["pagerduty.com", "pagerduty"],
  ["opsgenie.net", "opsgenie"],
  ["opsgenie.com", "opsgenie"],
  ["datadoghq.com", "datadog"],
  ["datadoghq.eu", "datadog"],
  ["dtdg.co", "datadog"],
  ["uptimerobot.com", "uptimerobot"],
  ["betterstack.com", "betterstack"],
  ["betteruptime.com", "betterstack"],
];

/** "[FIRING:2] ..." / "[RESOLVED] ..." as Grafana and Alertmanager send them. */
const ALERTMANAGER_SUBJECT = /^\s*\[(FIRING|RESOLVED)(:\d{1,6})?\]/i;

function alertState(subject: string): DevState {
  const lower = subject.toLowerCase();
  if (/\[resolved|\bresolved\b|\[recovered\]|\brecovered\b|\bis up\b|\[ok\]/.test(lower)) return "resolved";
  return "firing";
}

function classifyMonitoring(input: DevInput): DevClass | null {
  const { local, domain } = addressParts(input.from);
  let provider = MONITORING_DOMAINS.find(([base]) => domainIs(domain, base))?.[1] ?? null;
  // Outside the known domains, an Alertmanager-style subject counts only with a List-Id of the sender's domain (review).
  if (
    provider === null &&
    ALERTMANAGER_SUBJECT.test(input.subject) &&
    /alert|grafana|prometheus|monitor/.test(local) &&
    listOfDomain(input.listId, domain)
  ) {
    provider = local.includes("grafana") ? "grafana" : "alertmanager";
  }
  if (provider === null) return null;
  const ref = /\[#(\d{1,12})\]/.exec(input.subject)?.[1] ?? null;
  return { source: "monitoring", repo: provider, kind: "alert", state: alertState(input.subject), ref };
}

/** The notification's class, or null for ordinary mail. Spam and Trash rows are the caller's to skip. */
export function classifyDev(input: DevInput): DevClass | null {
  return classifyGithub(input) ?? classifyGitlab(input) ?? classifyCi(input) ?? classifyMonitoring(input);
}

/** For rows synced before 3g: From and subject only (no headers, no List-Id), and the project remotes' hosts. */
export function classifyDevFromStored(row: { from: string; subject: string }, knownHosts?: ReadonlySet<string>): DevClass | null {
  return classifyDev({ from: row.from, subject: row.subject, headers: null, listId: null, ...(knownHosts === undefined ? {} : { knownHosts }) });
}
