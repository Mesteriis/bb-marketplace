// Mail settings -> Subscriptions (slice 3n, #87): the mailing lists the
// stored mail comes from, with how much each sends, and Unsubscribe for
// several at once. Each request is the one the message's own Unsubscribe
// makes: one click to the list's host when the message proves it, else an
// email with exactly the subject and text shown here, sent through the
// Outbox with Undo. Nothing goes out before the owner confirms the list of
// requests; names and addresses come from the senders and are shown as text.
import { useCallback, useEffect, useState } from "react";
import type { SubscriptionView } from "../core/contract.ts";
import type { Account } from "../core/model.ts";
import { SUBSCRIPTIONS_BATCH_MAX } from "../core/subscriptions.ts";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { shownText } from "./agent-send-card.tsx";
import { MailtoPreview, UNSUBSCRIBE_PRIVACY, unsubscribeFailureText, type UnsubscribeMethod } from "./unsubscribe-dialog.tsx";
import { dateLocale, msg, tx, txn } from "./i18n/index.ts";

export type SubscriptionOutcome = { outcome: "done" | "redirected" | "failed" | "queued"; reason: string | null };

export interface SettingsSubscriptionPorts {
  list: () => Promise<{ subscriptions: SubscriptionView[]; truncated: boolean }>;
  /** One unsubscribe request, as the message's own Unsubscribe makes it. */
  run: (messageId: string, method: UnsubscribeMethod) => Promise<SubscriptionOutcome>;
}

const messageOf = (error: unknown, fallback: string) => tx(error instanceof Error && error.message !== "" ? error.message : fallback);

const STATE: Record<NonNullable<SubscriptionView["already"]>["state"], string> = {
  done: msg("Unsubscribed {date}"),
  sent: msg("Unsubscribe email sent {date}"),
  queued: msg("Unsubscribe email is waiting in the Outbox"),
  redirected: msg("Asked {date}; the list answered with a redirect"),
  failed: msg("A request on {date} failed"),
  cancelled: msg("A request on {date} was cancelled"),
};

/** A list's latest request means nothing more is to be asked. */
const settled = (list: SubscriptionView) => list.already !== null && ["done", "sent", "queued"].includes(list.already.state);

/** Whether the list can be ticked for a batch. */
export function subscriptionSelectable(list: SubscriptionView): boolean {
  return list.method !== null && list.batch && !settled(list);
}

function dayText(iso: string | null): string {
  if (iso === null) return "";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString(dateLocale(), { day: "numeric", month: "short", year: "numeric" });
}

/** What a request did, in words. */
export function outcomeText(result: SubscriptionOutcome): string {
  switch (result.outcome) {
    case "done":
      return tx("Unsubscribed");
    case "queued":
      return tx("The email is in the Outbox");
    case "redirected":
      return tx("The list answered with a redirect, so it may not have unsubscribed you");
    case "failed":
      return tx("Could not unsubscribe: {p1}", { p1: tx(unsubscribeFailureText(result.reason)) });
  }
}

export function SubscriptionsSettings({ ports, accounts }: { ports: SettingsSubscriptionPorts; accounts: readonly Account[] }) {
  const [loaded, setLoaded] = useState<{ subscriptions: SubscriptionView[]; truncated: boolean } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<ReadonlyMap<string, string>>(new Map());

  const load = useCallback(async () => {
    try {
      setLoaded(await ports.list());
    } catch (error) {
      setLoaded({ subscriptions: [], truncated: false });
      setProblem(messageOf(error, "The subscriptions could not be loaded"));
    }
  }, [ports]);
  useEffect(() => {
    void load();
  }, [load]);

  const lists = loaded?.subscriptions ?? [];
  const picked = lists.filter((list) => chosen.has(list.messageId) && subscriptionSelectable(list));
  const full = picked.length >= SUBSCRIPTIONS_BATCH_MAX;
  const toggle = (id: string, on: boolean) =>
    setChosen((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  const run = async () => {
    setConfirming(false);
    setRunning(true);
    setProblem(null);
    const done = new Map(results);
    // One at a time: each is a request to someone else's server or a send of its own.
    for (const list of picked) {
      let text: string;
      try {
        text = outcomeText(await ports.run(list.messageId, list.method!));
      } catch (error) {
        text = messageOf(error, "The request failed; try again");
      }
      done.set(list.messageId, text);
      setResults(new Map(done));
    }
    setChosen(new Set());
    setRunning(false);
    await load();
  };

  const accountOf = (id: string) => (accounts.length > 1 ? (accounts.find((account) => account.id === id)?.email ?? null) : null);

  return (
    <section aria-label={tx("Subscriptions")} className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="min-w-0 flex-1 text-sm font-semibold text-foreground">{tx("Subscriptions")}</h3>
        <Button size="sm" className="h-7 px-2" disabled={picked.length === 0 || running || confirming} onClick={() => setConfirming(true)}>
          {picked.length === 0 ? tx("Unsubscribe") : txn(picked.length, "Unsubscribe from {count} list", "Unsubscribe from {count} lists")}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        {tx(
          "Mailing lists in the mail stored here, outside Spam and Trash, largest first. Tick up to 10 at a time. A list Mail cannot unsubscribe from safely has no tick: use Spam or Block for it.",
        )}
      </p>
      {loaded?.truncated ? <p className="text-xs text-muted-foreground">{tx("Only the newest 50,000 messages were counted.")}</p> : null}
      {problem !== null ? (
        <p role="alert" className="text-sm text-destructive">
          {problem}
        </p>
      ) : null}
      {confirming ? (
        <div role="group" aria-label={tx("Confirm unsubscribing")} className="flex flex-col gap-2 rounded-md border border-border p-3 text-sm">
          <p className="text-foreground">{tx(UNSUBSCRIBE_PRIVACY)}</p>
          <ul aria-label={tx("Requests to send")} className="flex flex-col gap-2">
            {picked.map((list) => (
              <li key={list.messageId} className="flex flex-col gap-1">
                <span className="break-words text-foreground">
                  {shownText(list.name)}
                  <span className="text-muted-foreground">
                    {" \u2192 "}
                    {list.method === "one_click"
                      ? tx("one request to {host}", { host: list.target ?? "" })
                      : tx("an email to {address}", { address: list.target ?? "" })}
                  </span>
                </span>
                {list.mail !== null ? <MailtoPreview subject={list.mail.subject} body={list.mail.body} hiddenChars={list.mail.hiddenChars} /> : null}
              </li>
            ))}
          </ul>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" autoFocus onClick={() => setConfirming(false)}>
              {tx("Cancel")}
            </Button>
            <Button size="sm" onClick={() => void run()}>
              {txn(picked.length, "Unsubscribe from {count} list", "Unsubscribe from {count} lists")}
            </Button>
          </div>
        </div>
      ) : null}
      {loaded === null ? (
        <p className="text-sm text-muted-foreground">{tx("Loading\u2026")}</p>
      ) : lists.length === 0 ? (
        <p className="text-sm text-muted-foreground">{tx("No mailing lists in the stored mail.")}</p>
      ) : (
        <ul aria-label={tx("Mailing lists")} className="flex flex-col divide-y divide-border rounded-md border border-border">
          {lists.map((list) => {
            const selectable = subscriptionSelectable(list);
            const ticked = chosen.has(list.messageId) && selectable;
            const account = accountOf(list.accountId);
            const result = results.get(list.messageId);
            return (
              <li key={list.messageId} aria-label={shownText(list.name)} className="flex items-start gap-2 px-3 py-2 text-sm">
                <Checkbox
                  className="mt-0.5"
                  aria-label={tx("Unsubscribe from {name}", { name: shownText(list.name) })}
                  checked={ticked}
                  disabled={!selectable || running || confirming || (full && !ticked)}
                  onCheckedChange={(checked) => toggle(list.messageId, checked === true)}
                />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="break-words text-foreground">{shownText(list.name)}</span>
                  <span className="break-words text-xs text-muted-foreground">
                    {list.address}
                    {account !== null ? ` \u00b7 ${account}` : ""}
                  </span>
                  {result !== undefined ? (
                    <span role="status" className="text-xs text-foreground">
                      {result}
                    </span>
                  ) : list.already !== null ? (
                    <span className="text-xs text-muted-foreground">{tx(STATE[list.already.state], { date: dayText(list.already.at) })}</span>
                  ) : list.method === null ? (
                    <span className="text-xs text-muted-foreground">{tx("No way to unsubscribe that Mail can trust.")}</span>
                  ) : !list.batch ? (
                    <span className="text-xs text-muted-foreground">
                      {tx("Its unsubscribe address is not at the sender's domain: unsubscribe from a message of this list.")}
                    </span>
                  ) : null}
                </span>
                <span className="shrink-0 text-right text-xs text-muted-foreground">
                  <span className="block text-foreground">{txn(list.total, "{count} message", "{count} messages")}</span>
                  {list.unread > 0 ? <span className="block">{tx("{count} unread", { count: list.unread })}</span> : null}
                  <span className="block">{dayText(list.lastDate)}</span>
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
