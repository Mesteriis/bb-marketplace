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
};

/**
 * The same requirement split by side. The source side is what the item reads
 * or removes; the target side is where it is written. Their union is REQUIRED.
 */
const SOURCE_SIDE: Record<OperationKind, Permission[]> = {
  copy: ["read"],
  move: ["read", "delete"],
  rename: [],
  mkdir: [],
  delete: ["delete"],
};

const TARGET_SIDE: Record<OperationKind, Permission[]> = {
  copy: ["write"],
  move: ["write"],
  rename: ["write"],
  mkdir: ["write"],
  delete: [],
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

/**
 * The owner has every permission. An agent needs each item's source and target
 * covered by a grant on that item's endpoint, with its scope containing the path.
 */
export function authorize(
  initiator: Initiator,
  plan: OperationPlan,
  grants: Grant[],
): { ok: true } | { ok: false; missing: Permission[] } {
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
