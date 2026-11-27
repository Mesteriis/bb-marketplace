import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import type { InboxTab } from "../../core/pulls/inbox.ts";
import { pushText } from "../../core/pulls/watch.ts";
import type { Account } from "../../core/providers.ts";
import { failureFor } from "../../core/workspace.ts";
import { inboxService, watchRound, type InboxAlert } from "./inbox-service.ts";

type Caller = {experimental_caller: {kind: string}};
type Deps = {accounts(): Promise<Account[]>; credential(id: string): Promise<{account: Account; token: string}>};
const maxAlerts = 50;
/** Realtime channel: the alert list changed. */
export const inboxChannel = "inbox-alerts";
const pushSent = z.object({ok: z.literal(true), channels: z.array(z.string())});

/** Incoming pull requests of every account, their watcher and its alerts; only the app calls the RPC. */
export function inboxHandlers(bb: BbPluginApi, deps: Deps) {
  const settings = bb.settings.define({
    inboxNotifyCi: {type: "boolean", label: "My PRs: alert when CI starts failing", default: true},
    inboxNotifyComments: {type: "boolean", label: "My PRs: alert on new comments and reviews (GitHub)", default: true},
    inboxToasts: {type: "boolean", label: "My PRs: show alerts as toasts", default: true},
    inboxDesktop: {type: "boolean", label: "My PRs: send alerts through Push notifications", default: true},
    inboxBadge: {type: "boolean", label: "My PRs: show the unread count", default: true},
    inboxIgnore: {type: "string", label: "My PRs: never alert for comments from (comma-separated logins)", default: ""},
    inboxEveryMinutes: {type: "number", label: "My PRs: check every (minutes)", experimental_schema: z.number().int().min(2).max(60), default: 5},
  });
  // Turning toasts or the unread count off or on takes effect at once: the app reads the alert summary again.
  settings.onChange((next, prev) => {
    if (next.inboxToasts !== prev.inboxToasts || next.inboxBadge !== prev.inboxBadge) bb.realtime.publish(inboxChannel, {settings: true});
  });
  const kv = bb.storage.kv;
  const service = inboxService(deps);
  const stored = async () => await kv.get<InboxAlert[]>("inbox-alerts") ?? [];
  async function summary() {
    const [list, current] = await Promise.all([stored(), settings.get()]);
    return {alerts: list, unseen: list.filter(alert => !alert.seen).length, toasts: current.inboxToasts, badge: current.inboxBadge};
  }
  /** Sends alerts through Push notifications when the setting allows; says whether they went out, and on how many channels. */
  async function push(alerts: InboxAlert[]): Promise<{sent: boolean; message: string}> {
    if (!alerts.length) return {sent: false, message: "Nothing to send."};
    if (!(await settings.get()).inboxDesktop) return {sent: false, message: "Sending through Push notifications is off in these settings."};
    try {
      const sent = await bb.sdk.plugins.callRpc({pluginId: "push-notifications", method: "notifications.send", input: pushText(alerts),
        outputSchema: pushSent, signal: AbortSignal.timeout(15_000)});
      return sent.channels.length ? {sent: true, message: "Sent through Push notifications: " + sent.channels.join(", ") + "."}
        : {sent: false, message: "Push notifications has no channel turned on."};
    } catch (error) {
      // A missing or disabled Push notifications must not stop the watcher.
      bb.log.warn("My PRs alert not pushed: " + (error instanceof Error ? error.message : String(error)));
      return {sent: false, message: "Push notifications did not take it: install or enable that plugin."};
    }
  }
  async function round() {
    const current = await settings.get();
    const fresh = await watchRound({...deps, kv, now: () => new Date().toISOString(), keys: () => kv.list("inbox-watch/")},
      {ci: current.inboxNotifyCi, comments: current.inboxNotifyComments, ignore: current.inboxIgnore});
    if (!fresh.length) return;
    const known = new Set((await stored()).map(alert => alert.id));
    const added = fresh.filter(alert => !known.has(alert.id));
    if (!added.length) return;
    await kv.set("inbox-alerts", [...added, ...await stored()].slice(0, maxAlerts));
    bb.realtime.publish(inboxChannel, {added: added.length});
    await push(added);
  }
  bb.background.service("inbox-watch", {
    async start(signal) {
      while (!signal.aborted) {
        let minutes = 5;
        // Nothing here may end the loop: a failing round or settings read only skips this round.
        try { await round(); minutes = Math.max(2, (await settings.get()).inboxEveryMinutes); }
        catch (error) { bb.log.warn("My PRs watch skipped: " + (error instanceof Error ? error.message : String(error))); }
        await new Promise<void>(resolve => {
          const stop = () => { clearTimeout(timer); resolve(); };
          const timer = setTimeout(() => { signal.removeEventListener("abort", stop); resolve(); }, minutes * 60_000);
          signal.addEventListener("abort", stop, {once: true});
        });
      }
    },
  });
  const handle = <I, O extends object>(action: (input: I) => Promise<O>) => async (input: I, context: Caller) => {
    if (context.experimental_caller.kind !== "client") return failureFor(undefined, "ACCESS_DENIED");
    try { return {ok: true as const, ...await action(input)}; }
    catch (error) { return failureFor(error, "PROVIDER_UNAVAILABLE"); }
  };
  return {
    inboxList: handle(({tab}: {tab: InboxTab}) => service.list(tab)),
    inboxHistory: handle(({tab}: {tab: "merged" | "closed"}) => service.history(tab)),
    inboxAlerts: handle(async () => summary()),
    /** A test alert, as a real one arrives: in the list, as a toast and through Push notifications. */
    inboxTest: handle(async () => {
      const at = new Date().toISOString();
      const alert: InboxAlert = {id: "test:" + at, kind: "test", repo: "", number: 0, url: "", seen: false, at, accountId: "",
        headline: "Test alert from Makosh Git", detail: "This is how failing CI and new comments on your pull requests reach you."};
      await kv.set("inbox-alerts", [alert, ...await stored()].slice(0, maxAlerts));
      bb.realtime.publish(inboxChannel, {added: 1});
      return {...await summary(), push: await push([alert])};
    }),
    inboxSeen: handle(async () => {
      await kv.set("inbox-alerts", (await stored()).map(alert => ({...alert, seen: true})));
      bb.realtime.publish(inboxChannel, {seen: true});
      return summary();
    }),
  };
}
