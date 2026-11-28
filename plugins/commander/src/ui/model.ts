import { archiveReasonText } from "./archive-text.ts";
import { CommanderError } from "../core/errors.ts";
import type { Entry, Endpoint, OperationJob, ResourceRef } from "../core/model.ts";
import { displayPath, type NameSegment, type ResourcePath } from "../core/path.ts";
import { type DamagedJob, type RpcInput, type UiState } from "../core/wire/rpc.ts";
import { batchRenameText, errorText, ru } from "./strings.ts";

export type Side = UiState["activePane"];
export type Tab = UiState[Side]["tabs"][number];
export type EndpointView = Endpoint & { consent?: "none" | "pending" | "granted" | "revoked" };
export type JobView = OperationJob | DamagedJob;
export type PlanCheck = { ok: true; checkedAt: string } | {
  ok: false; checkedAt: string; changed: { index: number; reason: "source_changed" | "target_changed" }[];
};
export interface Problem { code: string; message: string }
/**
 * `partial`: the first pages of a long listing, shown while the rest is still being read. Rows are drawn, but
 * anything that acts on the whole directory (copy, search, selection checks) waits for the last page.
 */
export interface Directory { entries: Entry[]; loading: boolean; error: Problem | null; partial?: boolean }
export const unloaded: Directory = { entries: [], loading: true, error: null };
export const sides = ["left", "right"] as const;
export const otherSide = (side: Side): Side => side === "left" ? "right" : "left";
export const keyOf = (name: NameSegment) => "t" in name ? "t:" + name.t : "b:" + name.b;
export const nameOf = (name: NameSegment) => displayPath({ segments: [name] }).slice(1);
export const activeTab = (state: UiState, side: Side) => state[side].tabs[state[side].activeTab ?? -1];
export const currentRef = (tab: Tab): ResourceRef => ({ endpoint: tab.endpoint, path: tab.path });
export const newTab = (endpoint: string, path: ResourcePath): Tab => ({
  endpoint, path, sort: { by: "name", direction: "asc" }, filter: "", selection: [], scrollTop: 0,
});
export const emptyState: UiState = {
  left: { tabs: [], activeTab: null }, right: { tabs: [], activeTab: null },
  activePane: "left", layout: "horizontal", split: 0.5,
};

export function nativePath(path: ResourcePath): string | null {
  if (path.segments.some((name) => !("t" in name))) return null;
  return "/" + path.segments.map((name) => "t" in name ? name.t : "").join("/");
}

export function damaged(job: JobView): job is DamagedJob {
  return job.state === "unknown" && ("damaged" in job || (
    job.error?.code === "internal" && job.error.message === "Stored job is damaged"
  ));
}

export function problemOf(error: unknown): Problem {
  if (error instanceof CommanderError && Object.hasOwn(batchRenameText.coreMessages, error.message)) {
    return { code: error.code, message: batchRenameText.coreMessages[error.message] };
  }
  if (error instanceof CommanderError && [ru.compareLimit, ru.noPreview, ru.terminalUnavailable, ru.terminalOpenPage].includes(error.message)) {
    return { code: error.code, message: error.message };
  }
  let code: unknown;
  if (typeof error === "object" && error !== null && "code" in error) code = error.code;
  if (error instanceof Error) {
    try {
      const detail: unknown = JSON.parse(error.message);
      if (typeof detail === "object" && detail !== null && "code" in detail && typeof detail.code === "string"
        && Object.hasOwn(errorText, detail.code)) {
        code = detail.code;
        // S14: the line is chosen by the pair code + reason; the host's own text is not shown.
        const reason = "reason" in detail && typeof detail.reason === "string" ? archiveReasonText(detail.code, detail.reason) : null;
        if (reason !== null) return { code: detail.code, message: reason };
      }
    } catch { /* Unstructured host errors may contain paths. */ }
  }
  return typeof code === "string" && Object.hasOwn(errorText, code)
    ? { code, message: errorText[code] } : { code: "internal", message: ru.unknownError };
}

const collator = new Intl.Collator("ru", { numeric: true });
function byNumber(a: bigint | null, b: bigint | null) {
  if (a === b) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}
const toBig = (value: string | null) => value === null ? null : BigInt(value);

/**
 * Display name, sort key and number are computed once per entry, not on every comparison: a 100 000-entry panel
 * spent most of its main-thread time in `nameOf` (a regular-expression replace) inside the comparator (S19a).
 */
export function visibleEntries(entries: Entry[], tab: Tab): Entry[] {
  const filter = tab.filter.toLocaleLowerCase("ru");
  const { by, direction } = tab.sort;
  const rows: { entry: Entry; name: string; number: bigint | null }[] = [];
  for (const entry of entries) {
    const name = nameOf(entry.name);
    if (filter !== "" && !name.toLocaleLowerCase("ru").includes(filter)) continue;
    rows.push({ entry, name, number: by === "size" ? toBig(entry.size) : by === "mtime" ? toBig(entry.mtimeNs) : null });
  }
  rows.sort((a, b) => {
    if ((a.entry.kind === "dir") !== (b.entry.kind === "dir")) return a.entry.kind === "dir" ? -1 : 1;
    const names = collator.compare(a.name, b.name) || keyOf(a.entry.name).localeCompare(keyOf(b.entry.name));
    const value = by === "name" ? names : by === "kind" ? a.entry.kind.localeCompare(b.entry.kind) : byNumber(a.number, b.number);
    return (direction === "asc" ? value : -value) || names;
  });
  return rows.map((row) => row.entry);
}

export function bytes(size: string | bigint) {
  const value = BigInt(size);
  if (value < 1024n) return value + " " + ru.bytes;
  const units = [ru.kib, ru.mib, ru.gib, ru.tib];
  let unit = 1024n, index = 0;
  while (index < units.length - 1 && value >= unit * 1024n) { unit *= 1024n; index++; }
  return (Number((value * 100n + unit / 2n) / unit) / 100).toLocaleString("ru") + " " + units[index];
}
const clock = new Intl.DateTimeFormat("ru", { dateStyle: "short", timeStyle: "short" });
export function date(value: string | null, nanoseconds = false): string {
  if (value === null) return "—";
  const instant = new Date(nanoseconds ? Number(BigInt(value) / 1_000_000n) : value);
  return Number.isNaN(instant.getTime()) ? "—" : clock.format(instant);
}
const compactClock = new Intl.DateTimeFormat("ru", {
  day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit",
});
export function shortDate(value: string | null): string {
  if (value === null) return "—";
  const instant = new Date(Number(BigInt(value) / 1_000_000n));
  return Number.isNaN(instant.getTime()) ? "—" : compactClock.format(instant).replace(",", "");
}
export function shortPath(path: ResourcePath): string {
  return (path.segments.length > 2 ? "…/" : "/") + path.segments.slice(-2).map(nameOf).join("/");
}
export function selectionInfo(entries: Entry[], selection: NameSegment[]) {
  const keys = new Set(selection.map(keyOf));
  let count = 0, size = 0n;
  for (const entry of entries) if (keys.has(keyOf(entry.name))) {
    count++;
    if (entry.kind !== "dir") size += BigInt(entry.size);
  }
  return { count, size: bytes(size) };
}

export type PlanRequest = RpcInput<"plan_create">;
