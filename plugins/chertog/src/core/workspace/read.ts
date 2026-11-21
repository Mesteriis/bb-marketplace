// Reading what storage returned. The result tells apart: nothing stored, a
// document this code can use, a document written by a newer version, and a
// document it cannot read. The last two must never be saved over.
import { closeTab } from "../layout/index.ts";
import { z } from "zod";
import type { NamedLayout, WorkspaceDocument, WorkspacePanel } from "./document.ts";
import {
  firstProblem,
  idSchema,
  namedLayoutSchema,
  placedPanelIds,
  SCHEMA_VERSION,
  workspaceDocumentSchema,
  workspacePanelSchema,
} from "./document.ts";

/**
 * The steps between versions, keyed by the version a step reads. A step
 * returns the document of the next version; the reader stamps the version.
 */
export type MigrationChain = Readonly<Record<number, (old: Readonly<Record<string, unknown>>) => Record<string, unknown>>>;

/** No stored version precedes version 1. A step is added here together with every new version. */
export const WORKSPACE_MIGRATIONS: MigrationChain = {};

export type MigrationResult =
  | { readonly status: "current"; readonly document: Readonly<Record<string, unknown>> }
  | { readonly status: "migrated"; readonly from: number; readonly document: Readonly<Record<string, unknown>> }
  | { readonly status: "newer"; readonly schemaVersion: number }
  | { readonly status: "corrupt"; readonly reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Brings a stored document to the wanted version, one step at a time. The
 * stored object is not changed. A version above the wanted one is reported as
 * `newer`; a version without a step, or a step that throws, as `corrupt`.
 */
export function migrateToVersion(raw: unknown, version: number, migrations: MigrationChain): MigrationResult {
  if (!isRecord(raw)) return { status: "corrupt", reason: "The stored workspace is not an object" };
  const stored = raw.schemaVersion;
  if (typeof stored !== "number" || !Number.isSafeInteger(stored)) {
    return { status: "corrupt", reason: "The stored workspace has no schema version" };
  }
  if (stored > version) return { status: "newer", schemaVersion: stored };
  if (stored === version) return { status: "current", document: raw };
  let document: Readonly<Record<string, unknown>> = raw;
  for (let from = stored; from < version; from += 1) {
    const step = Object.hasOwn(migrations, from) ? migrations[from] : undefined;
    if (step === undefined) return { status: "corrupt", reason: "No migration from schema version " + from };
    try {
      document = { ...step(document), schemaVersion: from + 1 };
    } catch {
      return { status: "corrupt", reason: "The migration from schema version " + from + " failed" };
    }
  }
  return { status: "migrated", from: stored, document };
}

/** A part of a stored document the reader left out. The reason names fields and identifiers, never a parameter value. */
export type DroppedPart =
  | { readonly kind: "layout"; readonly id: string | null; readonly name: string | null; readonly reason: string }
  | { readonly kind: "panel"; readonly panelId: string | null; readonly reason: string };

export type WorkspaceReadResult =
  /** Nothing is stored yet. */
  | { readonly status: "empty" }
  /**
   * A usable document. `dropped` lists damaged parts left out of it: the next
   * save stores the document without them, so a caller that wants them back
   * keeps the stored original aside first.
   */
  | {
      readonly status: "ok";
      readonly document: WorkspaceDocument;
      /** The stored version when a migration ran, else `null`. */
      readonly migratedFrom: number | null;
      readonly dropped: readonly DroppedPart[];
    }
  /** Written by a newer version of the plugin. Do not save over it. */
  | { readonly status: "newer"; readonly schemaVersion: number }
  /** Unreadable as a whole. Do not save over it. */
  | { readonly status: "corrupt"; readonly reason: string };

/** The outer shape only: each panel and each layout is judged on its own. */
const envelopeSchema = z.strictObject({
  schemaVersion: z.literal(SCHEMA_VERSION),
  revision: z.int().min(0),
  panels: z.record(z.string(), z.unknown()),
  layouts: z.array(z.unknown()),
  activeLayoutId: z.string(),
});

const MAX_REPORTED_NAME_LENGTH = 64;

/** The id and the name of a damaged layout, when it still has them, for the report. */
function labelOf(rawLayout: unknown): { id: string | null; name: string | null } {
  if (!isRecord(rawLayout)) return { id: null, name: null };
  const id = idSchema.safeParse(rawLayout.id);
  const name = typeof rawLayout.name === "string" ? rawLayout.name.slice(0, MAX_REPORTED_NAME_LENGTH) : null;
  return { id: id.success ? id.data : null, name };
}

/** The layout without the tabs of panels that have no usable reference. */
function withoutPanels(layout: NamedLayout, known: Readonly<Record<string, WorkspacePanel>>, missing: Set<string>): NamedLayout {
  let workspace = layout.workspace;
  for (const panelId of placedPanelIds(layout)) {
    if (Object.hasOwn(known, panelId)) continue;
    missing.add(panelId);
    workspace = closeTab(workspace, panelId);
  }
  return workspace === layout.workspace ? layout : { ...layout, workspace };
}

/**
 * Reads a stored document of unknown shape. An older version is migrated
 * along the chain. A damaged layout, or a panel whose reference is refused,
 * is left out and reported, and everything else is kept: a panel of a
 * provider that is not installed has a valid reference and stays where it is.
 */
export function readWorkspaceDocument(raw: unknown, migrations: MigrationChain = WORKSPACE_MIGRATIONS): WorkspaceReadResult {
  if (raw === null || raw === undefined) return { status: "empty" };
  const migration = migrateToVersion(raw, SCHEMA_VERSION, migrations);
  if (migration.status === "newer" || migration.status === "corrupt") return migration;

  const envelope = envelopeSchema.safeParse(migration.document);
  if (!envelope.success) return { status: "corrupt", reason: firstProblem(envelope.error) };

  const dropped: DroppedPart[] = [];
  const panels: Record<string, WorkspacePanel> = {};
  for (const [panelId, rawPanel] of Object.entries(envelope.data.panels)) {
    const panel = workspacePanelSchema.safeParse(rawPanel);
    if (!idSchema.safeParse(panelId).success) {
      dropped.push({ kind: "panel", panelId: null, reason: "The panel id is not an identifier" });
    } else if (!panel.success) {
      dropped.push({ kind: "panel", panelId, reason: firstProblem(panel.error) });
    } else {
      panels[panelId] = panel.data;
    }
  }
  const refused = new Set(dropped.map((part) => (part.kind === "panel" ? part.panelId : null)));

  const layouts: NamedLayout[] = [];
  const unreferenced = new Set<string>();
  for (const rawLayout of envelope.data.layouts) {
    const layout = namedLayoutSchema.safeParse(rawLayout);
    if (!layout.success) {
      dropped.push({ kind: "layout", ...labelOf(rawLayout), reason: firstProblem(layout.error) });
    } else if (layouts.some((read) => read.id === layout.data.id)) {
      dropped.push({ kind: "layout", id: layout.data.id, name: layout.data.name, reason: "A layout with this id is already read" });
    } else {
      layouts.push(withoutPanels(layout.data, panels, unreferenced));
    }
  }
  for (const panelId of unreferenced) {
    if (!refused.has(panelId)) {
      dropped.push({ kind: "panel", panelId, reason: "A tile shows a panel the document has no reference for" });
    }
  }
  if (layouts.length === 0) return { status: "corrupt", reason: "No readable layout is left" };

  const active = layouts.find((layout) => layout.id === envelope.data.activeLayoutId) ?? layouts[0];
  const document = workspaceDocumentSchema.safeParse({
    schemaVersion: SCHEMA_VERSION,
    revision: envelope.data.revision,
    panels,
    layouts,
    activeLayoutId: active.id,
  });
  if (!document.success) return { status: "corrupt", reason: firstProblem(document.error) };
  return {
    status: "ok",
    document: document.data,
    migratedFrom: migration.status === "migrated" ? migration.from : null,
    dropped,
  };
}
