import { experimental_PluginRpcRefusal, type PluginKvStorage } from "@get-bb/plugin-sdk";
import { z } from "zod";
import type { Permission, ResourceRef } from "../../core/model.ts";
import { isAncestorOrSelf, samePath } from "../../core/path.ts";
import { AgentGrant, type GrantKey } from "../../core/wire/rpc.ts";

const key = "agent-grants";
const grantsSchema = z.array(AgentGrant).max(256);

export function createAgentGrants(kv: PluginKvStorage) {
  let pending: Promise<unknown> = Promise.resolve();
  async function list(): Promise<AgentGrant[]> {
    return grantsSchema.safeParse(await kv.get(key)).data ?? [];
  }

  function update(operation: (grants: AgentGrant[]) => AgentGrant[]): Promise<void> {
    const revision = pending.then(async () => {
      const grants = operation(await list());
      if (grants.length > 256 || Buffer.byteLength(JSON.stringify(grants)) > 256 * 1024) {
        throw new experimental_PluginRpcRefusal({ code: "invalid", message: "Agent grant storage limit exceeded" });
      }
      await kv.set(key, grants);
    });
    pending = revision.catch(() => {});
    return revision;
  }

  function without(grants: AgentGrant[], row: GrantKey) {
    return grants.filter((grant) => grant.threadId !== row.threadId || grant.endpoint !== row.endpoint
      || !samePath(grant.scope, row.scope, true));
  }

  return {
    list,
    set: (row: AgentGrant) => update((grants) => [...without(grants, row), row]),
    revoke: (row: GrantKey) => update((grants) => without(grants, row)),
    async forThread(threadId: string) {
      await pending;
      return (await list()).filter((grant) => grant.threadId === threadId || grant.threadId === "*");
    },
  };
}

export function covers(grants: AgentGrant[], ref: ResourceRef, permission: Permission): boolean {
  return grants.some((row) => (row.endpoint === "*" || row.endpoint === ref.endpoint)
    && row.permissions.includes(permission) && isAncestorOrSelf(row.scope, ref.path, true));
}
