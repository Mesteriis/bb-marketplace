import { NotificationSettings } from "./section-settings.tsx";
import type { PageSettingsPort } from "./setting-controls.tsx";
import { useState } from "react";
import type { Account, BlockRuleView } from "../../core/model.ts";
import { Button } from "@/components/ui/button";
import { accountLabel } from "../folder-list.tsx";
import { tx } from "../i18n/index.ts";
import { messageOf, formatDay } from "./shared.ts";
import { SectionHeading } from "./primitives.tsx";
import { TabsSettings, type InboxTabsPort } from "./tabs-settings.tsx";

/** The Inbox section: the Inbox tabs (Split Inbox), Blocked senders, and where each account's snoozed mail waits (slice 3e). */
export function InboxSection({
  accounts,
  rules,
  onUnblock,
  onChangeSnoozeFolder,
  settings,
  tabs,
}: {
  settings?: PageSettingsPort;
  /** Split Inbox: the Tabs group; absent: none. */
  tabs?: InboxTabsPort;
  accounts: readonly Account[];
  rules: readonly BlockRuleView[] | null;
  onUnblock: (id: string) => Promise<void>;
  onChangeSnoozeFolder: ((accountId: string) => void) | undefined;
}) {
  const [removing, setRemoving] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  return (
    <div className="flex flex-col gap-2">
      {settings !== undefined ? <NotificationSettings port={settings} /> : null}
      {tabs !== undefined ? <TabsSettings port={tabs} /> : null}
      <SectionHeading>{tx("Blocked senders")}</SectionHeading>
      <p className="text-xs text-muted-foreground">
        {tx("New mail from them moves to Spam in every account while BB runs. Mail already in Spam stays there.")}
      </p>
      {rules === null ? <p className="text-sm text-muted-foreground">{tx("Loading\u2026")}</p> : null}
      {rules !== null && rules.length === 0 ? (
        <p className="text-sm text-muted-foreground">{tx("No blocked senders. Block one from a message's toolbar.")}</p>
      ) : null}
      {rules !== null && rules.length > 0 ? (
        <ul aria-label={tx("Blocked senders")} className="flex flex-col divide-y divide-border rounded-md border border-border">
          {rules.map((rule) => (
            <li key={rule.id} aria-label={rule.value} className="flex flex-col gap-1 px-3 py-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="shrink-0 rounded-sm border border-border px-1 text-xs text-muted-foreground">
                  {rule.kind === "address" ? tx("Address") : tx("Domain")}
                </span>
                <span className="min-w-0 flex-1 break-all text-sm text-foreground">{rule.value}</span>
                <span className="shrink-0 text-xs text-muted-foreground">{formatDay(rule.createdAt)}</span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7"
                  aria-label={tx("Unblock {value}", { value: rule.value })}
                  onClick={() => {
                    setProblem(null);
                    setRemoving(rule.id);
                  }}
                >
                  {tx("Unblock")}
                </Button>
              </div>
              {removing === rule.id ? (
                <div role="alertdialog" aria-label={tx("Unblock {value}", { value: rule.value })} className="flex flex-wrap items-center gap-2">
                  <p className="min-w-0 flex-1 text-xs text-foreground">
                    {tx("Unblock")} {rule.value}{tx("? Mail already in Spam stays there.")}
                  </p>
                  <Button
                    variant="destructive"
                    size="sm"
                    className="h-7"
                    onClick={() => {
                      onUnblock(rule.id).then(
                        () => setRemoving(null),
                        (error: unknown) => setProblem(messageOf(error, "Could not unblock.")),
                      );
                    }}
                  >
                    {tx("Unblock")}
                  </Button>
                  <Button variant="ghost" size="sm" className="h-7" onClick={() => setRemoving(null)}>
                    {tx("Cancel")}
                  </Button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {problem !== null ? (
        <p role="alert" className="text-xs text-destructive">
          {problem}
        </p>
      ) : null}
      <SectionHeading>{tx("Snoozed folder")}</SectionHeading>
      <p className="text-xs text-muted-foreground">
        {tx("Snoozed mail waits in this folder and comes back while BB runs. Renaming it elsewhere ends those snoozes.")}
      </p>
      <ul aria-label={tx("Snoozed folders")} className="flex flex-col divide-y divide-border rounded-md border border-border">
        {accounts.map((account) => (
          <li key={account.id} aria-label={accountLabel(account)} className="flex flex-wrap items-center gap-2 px-3 py-2">
            <span className="min-w-0 flex-1 truncate text-sm text-foreground">{accountLabel(account)}</span>
            <span className="min-w-0 truncate text-xs text-muted-foreground">
              {account.snoozeFolder ?? tx("None yet; the first snooze asks")}
            </span>
            {onChangeSnoozeFolder !== undefined ? (
              <Button
                variant="outline"
                size="sm"
                className="h-7"
                aria-label={tx("Change the snoozed folder of {p1}", { p1: accountLabel(account) })}
                onClick={() => onChangeSnoozeFolder(account.id)}
              >
                {tx("Change\u2026")}
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
