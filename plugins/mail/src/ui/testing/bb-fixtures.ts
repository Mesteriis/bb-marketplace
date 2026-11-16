// A fake BB call for the page's slice 3g tests: answers from handlers,
// records every call, and rejects a method without a handler (as BB's rpc
// client does). Projects and repositories are made up.
import type { ProjectListItem, RpcIn, RpcMethod } from "../../core/contract.ts";
import type { BbCall } from "../bb-ports.ts";

export type BbHandlers = { [M in RpcMethod]?: (input: RpcIn<M>) => unknown };

export const PROJECTS: ProjectListItem[] = [
  { id: "p-api", name: "api", kind: "local", hasTree: true, repo: "github.com/example-org/demo" },
  { id: "p-docs", name: "docs", kind: "remote", hasTree: false, repo: null },
];

export function fakeCall(handlers: BbHandlers = {}) {
  const calls: { method: RpcMethod; input: unknown }[] = [];
  const call = (async (method: RpcMethod, input: unknown) => {
    calls.push({ method, input });
    const handler = (handlers as Record<string, ((input: unknown) => unknown) | undefined>)[method];
    if (handler !== undefined) return handler(input);
    if (method === "projects_list") return { projects: PROJECTS };
    throw new Error(`no handler for ${method}`);
  }) as BbCall;
  const to = (method: RpcMethod) => calls.filter((c) => c.method === method).map((c) => c.input);
  return { call, calls, to };
}
