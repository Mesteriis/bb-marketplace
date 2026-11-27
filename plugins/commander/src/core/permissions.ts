import { CommanderError } from "./errors.ts";
import { isAncestorOrSelf, type ResourcePath } from "./path.ts";
import {
  Permission,
  type EndpointId,
  type Initiator,
  type OperationKind,
  type OperationPlan,
} from "./model.ts";

/** Permissions the whole operation needs, per kind. */
export const REQUIRED: Record<OperationKind, Permission[]> = {
  copy: ["read", "write"],
  move: ["read", "write", "delete"],
  rename: ["write"],
  mkdir: ["write"],
  delete: ["delete"],
  pack: ["read", "write"],
};

/**
 * The same requirement split by side. The source side is what the item reads
 * or removes; the target side is where it is written. Their union is REQUIRED.
 */
const SOURCE_SIDE: Record<OperationKind, Permission[]> = {
  copy: ["read"],
  move: ["read", "delete"],
  // rename rewrites the entry in place, so the source needs write as well as the target.
  rename: ["write"],
  mkdir: [],
  delete: ["delete"],
  pack: ["read"],
};

const TARGET_SIDE: Record<OperationKind, Permission[]> = {
  copy: ["write"],
  move: ["write"],
  rename: ["write"],
  mkdir: ["write"],
  delete: [],
  pack: ["write"],
};

export interface Grant {
  endpoint: EndpointId | "*";
  permissions: Permission[];
  /** Null grants no path. */
  scope: ResourcePath | null;
}

// Grant scopes are compared case-sensitively: an agent never gets more than the
// grant names, even on a case-insensitive endpoint.
const CONSERVATIVE_CASE_SENSITIVE = true;

function coveringPermissions(
  grants: Grant[],
  endpoint: EndpointId,
  path: ResourcePath,
): Set<Permission> {
  const granted = new Set<Permission>();
  for (const grant of grants) {
    const endpointMatches = grant.endpoint === "*" || grant.endpoint === endpoint;
    if (!endpointMatches || grant.scope === null) continue;
    if (!isAncestorOrSelf(grant.scope, path, CONSERVATIVE_CASE_SENSITIVE)) continue;
    for (const permission of grant.permissions) granted.add(permission);
  }
  return granted;
}

function sideMissing(
  required: Permission[],
  grants: Grant[],
  ref: { endpoint: EndpointId; path: ResourcePath },
): Permission[] {
  const granted = coveringPermissions(grants, ref.endpoint, ref.path);
  return required.filter((permission) => !granted.has(permission));
}

function sameInitiator(a: Initiator, b: Initiator): boolean {
  if (a.kind === "owner" || b.kind === "owner") return a.kind === b.kind;
  return a.threadId === b.threadId;
}

/**
 * The owner has every permission. An agent needs each item's source and target
 * covered by a grant on that item's endpoint, with its scope containing the path.
 *
 * The initiator must be the plan's own initiator: a mismatch is a caller bug and
 * throws internal instead of authorizing anything.
 *
 * Known limit: the plan lists names outside the agent's grant. S7 must not return
 * the plan itself to an agent; only the grant verdict may leave the core.
 */
export function authorize(
  initiator: Initiator,
  plan: OperationPlan,
  grants: Grant[],
): { ok: true } | { ok: false; missing: Permission[] } {
  if (!sameInitiator(initiator, plan.initiator)) {
    throw new CommanderError("internal", "authorize was called with another initiator than the plan's");
  }
  if (initiator.kind === "owner") return { ok: true };

  const missing = new Set<Permission>();
  for (const item of plan.items) {
    if (item.source !== null) {
      for (const permission of sideMissing(SOURCE_SIDE[plan.kind], grants, item.source)) missing.add(permission);
    }
    if (item.target !== null) {
      for (const permission of sideMissing(TARGET_SIDE[plan.kind], grants, item.target)) missing.add(permission);
    }
  }
  if (missing.size === 0) return { ok: true };
  return { ok: false, missing: Permission.options.filter((permission) => missing.has(permission)) };
}
