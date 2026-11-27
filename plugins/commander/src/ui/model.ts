import { CommanderError } from "../core/errors.ts";
import type { Entry, Endpoint, OperationJob, ResourceRef } from "../core/model.ts";
import { displayPath, type NameSegment, type ResourcePath } from "../core/path.ts";
import { type DamagedJob, type RpcInput, type UiState } from "../core/wire/rpc.ts";
import { errorText, ru } from "./strings.ts";

export type Side = UiState["activePane"];
export type Tab = UiState[Side]["tabs"][number];
export type EndpointView = Endpoint & { consent?: "none" | "pending" | "granted" | "revoked" };
export type JobView = OperationJob | DamagedJob;
export type PlanCheck = { ok: true; checkedAt: string } | {
  ok: false; checkedAt: string; changed: { index: number; reason: "source_changed" | "target_changed" }[];
};
export interface Problem { code: string; message: string }
export interface Directory { entries: Entry[]; loading: boolean; error: Problem | null }
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
  if (error instanceof CommanderError && [ru.compareLimit, ru.noPreview, ru.terminalUnavailable, ru.terminalOpenPage].includes(error.message)) {
    return { code: error.code, message: error.message };
  }
  let code: unknown;
  if (typeof error === "object" && error !== null && "code" in error) code = error.code;
  if (error instanceof Error) {
    try {
      const detail: unknown = JSON.parse(error.message);
      if (typeof detail === "object" && detail !== null && "code" in detail && typeof detail.code === "string"
        && Object.hasOwn(errorText, detail.code)) code = detail.code;
    } catch { /* Unstructured host errors may contain paths. */ }
  }
  return typeof code === "string" && Object.hasOwn(errorText, code)
    ? { code, message: errorText[code] } : { code: "internal", message: ru.unknownError };
}

const collator = new Intl.Collator("ru", { numeric: true });
function byNumber(a: string | null, b: string | null) {
  if (a === b) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  const x = BigInt(a), y = BigInt(b);
  return x < y ? -1 : x > y ? 1 : 0;
}
export function visibleEntries(entries: Entry[], tab: Tab): Entry[] {
  const filter = tab.filter.toLocaleLowerCase("ru");
  const { by, direction } = tab.sort;
  return entries.filter((entry) => nameOf(entry.name).toLocaleLowerCase("ru").includes(filter)).sort((a, b) => {
    if ((a.kind === "dir") !== (b.kind === "dir")) return a.kind === "dir" ? -1 : 1;
    const names = collator.compare(nameOf(a.name), nameOf(b.name)) || keyOf(a.name).localeCompare(keyOf(b.name));
    const value = by === "name" ? names : by === "kind" ? a.kind.localeCompare(b.kind)
      : by === "size" ? byNumber(a.size, b.size) : byNumber(a.mtimeNs, b.mtimeNs);
    return (direction === "asc" ? value : -value) || names;
  });
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
