// Alerts from monitoring mail (slice 3g, #80): name, state, severity,
// service, environment and https links read from fixed subject shapes and
// labelled lines, every field redacted. The fingerprint (state left out)
// ties a firing and a resolved mail to one incident thread; RPC outputs call
// it alertRef. Pure.
import { sha256Hex } from "./compose.ts";
import type { DevClass } from "./dev-notify.ts";
import { removeControls, removeInvisible } from "./html-entities.ts";
import { redactSecrets } from "./redact.ts";

export const INCIDENT_APPEND_DAYS = 7;
const FIELD_MAX = 200;
const LINKS_MAX = 5;
const URL_MAX = 2_000;
/** Lines of the body looked at for labels and links. */
const SCAN_LINES = 400;

export type AlertState = "firing" | "resolved";

export type AlertView = {
  /** The monitoring service ("grafana", "sentry", ...). */
  source: string;
  name: string;
  state: AlertState;
  severity: string | null;
  service: string | null;
  environment: string | null;
  links: string[];
  /** The fingerprint (sha256 hex of source, name, service and environment). */
  alertRef: string;
};

export type AlertParts = Omit<AlertView, "alertRef">;

/** One redacted line, at most 200 characters. */
function field(value: string): string {
  const text = redactSecrets(removeInvisible(value)).text;
  const line = removeControls(text.replace(/[\r\n\v\f\u0085\u2028\u2029]+/g, " ")).replace(/\s+/g, " ").trim();
  return line.length > FIELD_MAX ? line.slice(0, FIELD_MAX).trimEnd() : line;
}

function optional(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const text = field(value);
  return text === "" ? null : text;
}

const GRAFANA = /^\s*\[(FIRING|RESOLVED)(?::\d{1,6})?\]\s*(.*)$/i;
const PAGERDUTY = /^\s*\[#\d{1,12}\]\s*(Triggered|Acknowledged|Resolved)\s*:\s*(.*)$/i;
const DATADOG = /^\s*\[(Triggered|Re-Triggered|Recovered|Warn|Warning|No Data|Alert)(?: on [^\]]{0,200})?\]\s*(.*)$/i;
const TRAILING_GROUP = /\s*\([^()]{0,200}\)\s*$/;

const LABEL = /^\s*(?:[-*]\s*)?(alertname|severity|service|env|environment)\s*[=:]\s*(.+?)\s*$/i;
const HTTPS_URL = /https:\/\/[^\s<>"'`()[\]{}]{1,2000}/g;

function fromSubject(source: string, subject: string, fallback: AlertState): { name: string; state: AlertState; service: string | null } {
  const grafana = GRAFANA.exec(subject);
  if (grafana !== null) {
    return {
      name: grafana[2]!.replace(TRAILING_GROUP, "").trim(),
      state: grafana[1]!.toUpperCase() === "RESOLVED" ? "resolved" : "firing",
      service: null,
    };
  }
  const pagerduty = PAGERDUTY.exec(subject);
  if (pagerduty !== null) {
    return { name: pagerduty[2]!.trim(), state: pagerduty[1]!.toLowerCase() === "resolved" ? "resolved" : "firing", service: null };
  }
  const datadog = DATADOG.exec(subject);
  if (datadog !== null) {
    return { name: datadog[2]!.trim(), state: datadog[1]!.toLowerCase() === "recovered" ? "resolved" : "firing", service: null };
  }
  if (source === "sentry") {
    const dash = subject.indexOf(" - ");
    if (dash > 0) return { name: subject.slice(dash + 3).trim(), state: fallback, service: subject.slice(0, dash).trim() };
  }
  return { name: subject.trim(), state: fallback, service: null };
}

/**
 * The alert of a monitoring message, or null for other mail. Labelled lines
 * in the body (alertname=, severity=, service=, env=) win over the subject.
 */
export function alertOf(input: { devClass: DevClass | null; subject: string; text: string }): AlertParts | null {
  const dev = input.devClass;
  if (dev === null || dev.source !== "monitoring") return null;
  const source = field(dev.repo ?? "monitoring") || "monitoring";
  const fallback: AlertState = dev.state === "resolved" ? "resolved" : "firing";
  const subject = fromSubject(source, input.subject, fallback);
  const labels = new Map<string, string>();
  const links: string[] = [];
  for (const line of input.text.replace(/\r\n?/g, "\n").split("\n").slice(0, SCAN_LINES)) {
    const label = LABEL.exec(line);
    if (label !== null) {
      const key = label[1]!.toLowerCase() === "environment" ? "env" : label[1]!.toLowerCase();
      if (!labels.has(key)) labels.set(key, label[2]!);
    }
    for (const match of line.matchAll(HTTPS_URL)) {
      let url = match[0];
      while (url.length > 0 && ".,;:!?".includes(url[url.length - 1]!)) url = url.slice(0, -1);
      if (url.length > URL_MAX || links.length >= LINKS_MAX) continue;
      const redacted = redactSecrets(url).text;
      // A URL that held a secret is not offered as a link.
      if (redacted === url && !links.includes(url)) links.push(url);
    }
  }
  return {
    source,
    name: field(labels.get("alertname") ?? subject.name) || "alert",
    state: subject.state,
    severity: optional(labels.get("severity")),
    service: optional(labels.get("service") ?? subject.service),
    environment: optional(labels.get("env")),
    links,
  };
}

/** sha256 hex of source | name | service | environment, case-folded; the state is left out. */
export function alertFingerprint(parts: Pick<AlertParts, "source" | "name" | "service" | "environment">): Promise<string> {
  const text = [parts.source, parts.name, parts.service ?? "", parts.environment ?? ""].map((part) => part.toLowerCase()).join("|");
  return sha256Hex(new TextEncoder().encode(text));
}
