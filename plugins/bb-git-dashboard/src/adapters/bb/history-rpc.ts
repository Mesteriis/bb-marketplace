import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { failureFor, type Copy } from "../../core/workspace.ts";
import { hostContract } from "./host-contract.ts";

type Caller = {experimental_caller: {kind: string}};
const pageSize = 100;

/** RPC handlers of the History tab; Git runs on the copy's own host, read-only. */
export function historyHandlers(bb: BbPluginApi, copyOf: (copyId: string) => Promise<Copy | undefined>) {
  const host = bb.hosts.experimental_client({contract: hostContract});
  // Read by the app through useSettings(); the server only declares them.
  bb.settings.define({
    historyGraph: {type: "boolean", label: "History: draw branch and merge lanes", description: "Off shows the history as one list without the graph.", default: true},
    reviewHeaderShortcut: {type: "boolean", label: "Line review: show a Review button in the thread header",
      description: "It opens the thread's Review tab, or closes it. Review stays available from the thread panel's New tab and the palette either way.", default: true},
    historyHeaderShortcut: {type: "boolean", label: "History: show a Git History button in the thread header",
      description: "Git History stays available from the thread panel's New tab either way.", default: false},
  });
  const on = <I extends {copyId: string}, O extends {ok: boolean}>(call: (copy: Copy, input: I) => Promise<O>) => async (input: I, context: Caller) => {
    if (context.experimental_caller.kind !== "client") return failureFor(undefined, "ACCESS_DENIED");
    const copy = await copyOf(input.copyId);
    if (!copy) return failureFor(undefined, "NOT_FOUND");
    return call(copy, input).catch(() => failureFor(undefined, "HOST_UNAVAILABLE"));
  };
  const target = (copy: Copy) => ({root: copy.root, identity: copy.identity});
  return {
    historyPage: on((copy, {offset}: {copyId: string; offset: number}) =>
      host.call("historyPage", {...target(copy), offset, limit: pageSize}, {hostId: copy.hostId})),
    historyRevision: on(copy => host.call("historyRevision", target(copy), {hostId: copy.hostId})),
    historyCommit: on((copy, {hash}: {copyId: string; hash: string}) => host.call("historyCommit", {...target(copy), hash}, {hostId: copy.hostId})),
    historyPatch: on(async (copy, {hash, path}: {copyId: string; hash: string | null; path: string}) => {
      const result = await host.call("historyPatch", {...target(copy), hash, path}, {hostId: copy.hostId});
      return result.ok ? {ok: true as const, text: result.value.text, truncated: result.value.truncated} : result;
    }),
  };
}
