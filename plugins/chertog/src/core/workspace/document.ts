// The workspace document: what Chertog stores about one workspace. It keeps
// the long-lived references of the panels and the named layouts that place
// them, and no panel title. It never keeps a live handle (an instance id, a process, a DOM node)
// and, through `panelRefSchema`, never keeps credentials, correspondence,
// tokens or links with a password.
import { z } from "zod";
import type { LayoutNode, WorkspaceState } from "../layout/index.ts";
import { createWorkspace, listGroups } from "../layout/index.ts";
import { panelRefSchema } from "../panels/index.ts";
import type { PanelRef } from "../panels/index.ts";

/** The version this code writes. A change of the stored shape raises it and adds a step to the migration chain. */
export const SCHEMA_VERSION = 2;

/**
 * A panel the workspace knows: how to find it again. The document keeps no
 * title for it: a title comes from the provider, may quote anything, and is
 * asked for live by the reference each time the panel is shown.
 */
export interface WorkspacePanel {
  readonly ref: PanelRef;
}

/** One named arrangement: the tree with its own focus and maximized tile. */
export interface NamedLayout {
  readonly id: string;
  readonly name: string;
  readonly workspace: WorkspaceState;
}

export interface WorkspaceDocument {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  /** How many times the document was saved. A save names the revision it was made from. */
  readonly revision: number;
  /**
   * Every panel a layout places or a live instance still shows, by panel id.
   * Several layouts may place one panel; one layout places it at most once.
   */
  readonly panels: Readonly<Record<string, WorkspacePanel>>;
  /** At least one layout, in the order the user sees them. */
  readonly layouts: readonly NamedLayout[];
  /** The layout the next entry through Home opens. */
  readonly activeLayoutId: string;
}

const MAX_NAME_LENGTH = 64;

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const NODE_ID = /^(group|split)-([1-9][0-9]*)$/;
const CONTROL = /[\u0000-\u001f\u007f]/;

/** Shares are stored as computed; within this they count as summing to 1. */
const SHARE_TOLERANCE = 1e-6;

/** Whether a caption is already trimmed, within the length and on one line. */
function isCaption(text: string, maxLength: number): boolean {
  return text.length >= 1 && text.length <= maxLength && text === text.trim() && !CONTROL.test(text);
}

/** An id of a layout or a panel: letters, digits and `. _ : -`, without whitespace. */
export const idSchema = z.string().regex(ID);

/** A link, an address or a `key=value` pair, in plain form or behind percent, HTML or backslash escapes. */
const UNSAFE_TEXT = /:\/\/|[@=\\]|%[0-9a-f]{2}|&#|&[a-z][a-z0-9]*;/i;

/**
 * Words that mark a credential, matched in the name with everything but
 * letters and digits taken out, so `Authorization=Bearer`, `api key` and
 * `B-e-a-r-e-r` are all found. `basic` counts when anything follows it.
 */
const SECRET_MARKER = /authorization|bearer|passw|passcode|passphrase|pwd|secret|token|apikey|credential|cookie|пароль|токен|basic./;

/**
 * Whether a layout name may be stored. The user types it, so it is judged as
 * a whole and refused as a whole: no link, no address with `@`, no
 * `key=value` pair, no escape sequence that could hide one of them, and no
 * word that marks a credential. Lookalike characters such as a full-width
 * `＠` count as their plain form.
 */
function isSafeName(name: string): boolean {
  const plain = name.normalize("NFKC");
  return !UNSAFE_TEXT.test(plain) && !SECRET_MARKER.test(plain.toLowerCase().replace(/[^\p{L}\p{N}]/gu, ""));
}

export const layoutNameSchema = z
  .string()
  .refine((name) => isCaption(name, MAX_NAME_LENGTH), "A name is 1 to 64 characters without line breaks")
  .refine((name) => isSafeName(name), "A name must not carry a link or credentials");

/** Words that mark a parameter as a handle of something running now, wherever and in whatever case they stand in its name. */
const LIVE_HANDLE_WORD = /instance|handle|process|socket|descriptor|webcontents|domnode/;

/**
 * `pid` and `pty` as a word of the name: `pid`, `shellPid`, `PIDHandle`,
 * `ssh_pty`, `PTYID`. Inside another word, as in `appId`, `groupId`,
 * `rapidMode` or `emptyState`, they mark nothing.
 */
const LIVE_HANDLE_SHORT_WORD = /(?:^|[^A-Za-z])(?:pid|pty)|(?:^|[^A-Z])(?:PID|Pid|PTY|Pty)/;

/** Whether a parameter name such as `instanceId`, `pty_handle` or `webContentsId` names a live handle. */
function isLiveHandleName(name: string): boolean {
  return LIVE_HANDLE_WORD.test(name.toLowerCase().replace(/[^a-z0-9]/g, "")) || LIVE_HANDLE_SHORT_WORD.test(name);
}

/** A reference as the document stores it: `panelRefSchema`, and no parameter that names a live handle. */
const storedPanelRefSchema = panelRefSchema.superRefine((ref, context) => {
  for (const name of Object.keys(ref.params)) {
    if (isLiveHandleName(name)) {
      context.addIssue({ code: "custom", path: ["params", name], message: "A panel reference must not carry a live handle" });
    }
  }
});

/**
 * Unknown fields are refused, and so is a parameter that names a live handle:
 * neither an instance id nor a title can ride along with a reference.
 */
export const workspacePanelSchema: z.ZodType<WorkspacePanel> = z.strictObject({
  ref: storedPanelRefSchema,
});

const nodeIdSchema = z.string().regex(NODE_ID);

const layoutNodeSchema: z.ZodType<LayoutNode> = z.lazy(() => z.discriminatedUnion("kind", [groupNodeSchema, splitNodeSchema]));

const groupNodeSchema = z.strictObject({
  kind: z.literal("group"),
  id: nodeIdSchema,
  tabs: z.array(idSchema),
  activeTab: idSchema.nullable(),
});

const splitNodeSchema = z.strictObject({
  kind: z.literal("split"),
  id: nodeIdSchema,
  direction: z.enum(["row", "column"]),
  children: z.array(layoutNodeSchema).min(2),
  sizes: z.array(z.number().positive()),
});

/**
 * What breaks the rules of the layout model in a tree of the right shape, or
 * `null`. The layout operations rely on every one of these rules.
 */
function workspaceProblem(workspace: WorkspaceState): string | null {
  const nodeIds = new Set<string>();
  const panelIds = new Set<string>();
  const groupIds = new Set<string>();

  const visit = (node: LayoutNode, parent: LayoutNode | null): string | null => {
    const match = NODE_ID.exec(node.id);
    if (match === null || match[1] !== node.kind) return "the " + node.kind + " id " + node.id + " is not a " + node.kind + " id";
    if (nodeIds.has(node.id)) return "the node id " + node.id + " is used twice";
    nodeIds.add(node.id);
    if (Number(match[2]) >= workspace.nextNodeId) {
      return "the node id " + node.id + " is not below the next id " + workspace.nextNodeId;
    }
    if (node.kind === "group") {
      groupIds.add(node.id);
      if (node.tabs.length === 0 && parent !== null) return "the empty group " + node.id + " is not the only tile";
      for (const panelId of node.tabs) {
        if (panelIds.has(panelId)) return "the panel " + panelId + " is placed twice";
        panelIds.add(panelId);
      }
      if (node.activeTab === null) return node.tabs.length === 0 ? null : node.id + " shows no tab";
      return node.tabs.includes(node.activeTab) ? null : node.id + " shows the tab " + node.activeTab + " it does not hold";
    }
    if (node.children.length !== node.sizes.length) {
      return node.id + " has " + node.children.length + " children and " + node.sizes.length + " sizes";
    }
    const total = node.sizes.reduce((sum, size) => sum + size, 0);
    if (Math.abs(total - 1) > SHARE_TOLERANCE) return "the shares of " + node.id + " sum to " + total;
    if (parent !== null && parent.kind === "split" && parent.direction === node.direction) {
      return node.id + " repeats the direction of its parent";
    }
    for (const child of node.children) {
      const problem = visit(child, node);
      if (problem !== null) return problem;
    }
    return null;
  };

  const problem = visit(workspace.root, null);
  if (problem !== null) return problem;
  if (!groupIds.has(workspace.focusedGroupId)) return "the focused group " + workspace.focusedGroupId + " is not in the tree";
  if (workspace.maximizedGroupId !== null && !groupIds.has(workspace.maximizedGroupId)) {
    return "the maximized group " + workspace.maximizedGroupId + " is not in the tree";
  }
  return null;
}

/** A tree of the layout model in its normal form, with focus and maximize on tiles it holds. */
export const workspaceStateSchema: z.ZodType<WorkspaceState> = z
  .strictObject({
    root: layoutNodeSchema,
    focusedGroupId: nodeIdSchema,
    maximizedGroupId: nodeIdSchema.nullable(),
    nextNodeId: z.int().min(1),
  })
  .superRefine((workspace, context) => {
    const problem = workspaceProblem(workspace);
    if (problem !== null) context.addIssue({ code: "custom", message: problem });
  });

export const namedLayoutSchema: z.ZodType<NamedLayout> = z.strictObject({
  id: idSchema,
  name: layoutNameSchema,
  workspace: workspaceStateSchema,
});

/** The panel ids a layout places, in reading order. */
export function placedPanelIds(layout: NamedLayout): string[] {
  return listGroups(layout.workspace.root).flatMap((group) => group.tabs);
}

/**
 * The whole document as it is written. Everything a save stores passes this
 * schema: a tile always has a reference behind it, layout ids are unique and
 * the active layout exists.
 */
export const workspaceDocumentSchema: z.ZodType<WorkspaceDocument> = z
  .strictObject({
    schemaVersion: z.literal(SCHEMA_VERSION),
    revision: z.int().min(0),
    panels: z.record(idSchema, workspacePanelSchema),
    layouts: z.array(namedLayoutSchema).min(1),
    activeLayoutId: idSchema,
  })
  .superRefine((document, context) => {
    const layoutIds = new Set<string>();
    document.layouts.forEach((layout, index) => {
      if (layoutIds.has(layout.id)) {
        context.addIssue({ code: "custom", path: ["layouts", index, "id"], message: "the layout id " + layout.id + " is used twice" });
      }
      layoutIds.add(layout.id);
      const stranger = placedPanelIds(layout).find((panelId) => !Object.hasOwn(document.panels, panelId));
      if (stranger !== undefined) {
        context.addIssue({ code: "custom", path: ["layouts", index, "workspace"], message: "the panel " + stranger + " has no reference" });
      }
    });
    if (!layoutIds.has(document.activeLayoutId)) {
      context.addIssue({
        code: "custom",
        path: ["activeLayoutId"],
        message: "the active layout " + document.activeLayoutId + " does not exist",
      });
    }
  });

/**
 * The first problem of a failed parse as one line: the path and the message.
 * It names fields and identifiers and never quotes a parameter value.
 */
export function firstProblem(error: z.ZodError): string {
  let issue = error.issues[0];
  const path = [...issue.path];
  // A refused record key is reported as a wrapper around the key's own problem.
  while (issue.code === "invalid_key" && issue.issues.length > 0) issue = issue.issues[0];
  return (path.length === 0 ? "" : path.join(".") + ": ") + issue.message;
}

/**
 * The document of a workspace nobody has arranged yet: one layout with one
 * full-size tile that offers to choose its content.
 */
export function initialDocument(layoutId: string, name: string): WorkspaceDocument {
  return {
    schemaVersion: SCHEMA_VERSION,
    revision: 0,
    panels: {},
    layouts: [{ id: layoutId, name, workspace: createWorkspace() }],
    activeLayoutId: layoutId,
  };
}

/** The layout the document has open. A valid document always has one. */
export function activeLayout(document: WorkspaceDocument): NamedLayout {
  return document.layouts.find((layout) => layout.id === document.activeLayoutId) ?? document.layouts[0];
}
