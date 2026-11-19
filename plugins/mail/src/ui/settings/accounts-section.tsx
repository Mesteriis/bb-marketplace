// Mailboxes and sign-in: every account with how it signs in and how it
// stands, the actions that change its sign-in, and the settings of sync.
// Removing an account stays a terminal command; the section shows it.
import { Button } from "@/components/ui/button";
import type { Account } from "../../core/model.ts";
import { PRESETS } from "../../core/presets.ts";
import { grantRevoked } from "../../core/sync-problems.ts";
import { tx } from "../i18n/index.ts";
import { accountProblemTexts } from "../mail-status.tsx";
import { SettingsGroup } from "./primitives.tsx";
import { NumberSetting, SwitchSetting, type PageSettingsPort } from "./setting-controls.tsx";

export type AccountsSectionProps = {
  accounts: readonly Account[];
  settings?: PageSettingsPort;
  onAddAccount?: () => void;
  /** Opens the account form to type a new app password. */
  onReplacePassword?: (account: Account) => void;
  /** Opens the account form on Google sign-in (a switch, or a new sign-in after a revoked grant); absent: not offered. */
  onGoogleSwitch?: (account: Account) => void;
  onOpenSmtp: (accountId: string) => void;
  onCopy?: (text: string) => void;
};

function signInText(account: Account): string {
  return account.authKind === "google" ? tx("Signed in with Google") : tx("App password");
}

export function AccountsSection(props: AccountsSectionProps) {
  const { accounts, settings } = props;
  return (
    <div className="flex flex-col gap-4">
      <SettingsGroup
        title={tx("Mailboxes")}
        action={
          props.onAddAccount !== undefined ? (
            <Button variant="outline" size="sm" className="h-7" onClick={props.onAddAccount}>
              {tx("Add an account")}
            </Button>
          ) : undefined
        }
      >
        {accounts.length === 0 ? (
          <p className="text-sm text-muted-foreground">{tx("No mail account yet.")}</p>
        ) : (
          <ul aria-label={tx("Mailboxes")} className="flex flex-col divide-y divide-border rounded-md border border-border">
            {accounts.map((account) => {
              const google = account.authKind === "google";
              const problems = accountProblemTexts(account);
              const removeCommand = `bb makosh-mail remove ${account.id}`;
              return (
                <li key={account.id} aria-label={account.email} className="flex flex-col gap-2 px-3 py-2.5">
                  <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                    <span className="min-w-0 truncate text-sm font-medium text-foreground">{account.email}</span>
                    <span className="text-xs text-muted-foreground">
                      {account.displayName !== null && account.displayName !== "" ? `${account.displayName} · ` : ""}
                      {PRESETS[account.preset].label} · {signInText(account)}
                    </span>
                  </div>
                  {account.authFailed || problems.length > 0 ? (
                    <p role={account.authFailed ? "alert" : undefined} className={account.authFailed ? "text-xs text-destructive" : "text-xs text-muted-foreground"}>
                      {problems.length > 0 ? problems.join(" ") : tx("Sync is stopped for this account.")}
                    </p>
                  ) : null}
                  <div className="flex flex-wrap items-center gap-2">
                    {!google && props.onReplacePassword !== undefined ? (
                      <Button variant="outline" size="sm" className="h-7" onClick={() => props.onReplacePassword?.(account)}>
                        {tx("Replace app password")}
                      </Button>
                    ) : null}
                    {props.onGoogleSwitch !== undefined && account.preset === "gmail" && !google ? (
                      <Button variant="outline" size="sm" className="h-7" onClick={() => props.onGoogleSwitch?.(account)}>
                        {tx("Switch to Google sign-in")}
                      </Button>
                    ) : null}
                    {props.onGoogleSwitch !== undefined && google && (account.authFailed || grantRevoked(account.lastError)) ? (
                      <Button variant="outline" size="sm" className="h-7" onClick={() => props.onGoogleSwitch?.(account)}>
                        {tx("Sign in to Google")}
                      </Button>
                    ) : null}
                    <Button variant="link" size="sm" className="h-7 px-1" onClick={() => props.onOpenSmtp(account.id)}>
                      {tx("SMTP settings…")}
                    </Button>
                  </div>
                  <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <span>{tx("To remove this account with its mail, run in your terminal:")}</span>
                    <code className="rounded-sm bg-muted px-1 py-0.5 text-foreground">{removeCommand}</code>
                    {props.onCopy !== undefined ? (
                      <Button
                        variant="link"
                        size="sm"
                        className="h-auto px-0 text-xs"
                        aria-label={tx("Copy the command that removes {p1}", { p1: account.email })}
                        onClick={() => props.onCopy?.(removeCommand)}
                      >
                        {tx("Copy")}
                      </Button>
                    ) : null}
                  </p>
                </li>
              );
            })}
          </ul>
        )}
      </SettingsGroup>

      {settings !== undefined ? (
        <SettingsGroup title={tx("Sync")}>
          <div className="flex flex-col">
            <NumberSetting port={settings} name="syncIntervalMinutes" label={tx("Check for mail every")} hint={tx("From 1 to 1440 minutes.")} unit={tx("min")} />
            <NumberSetting port={settings} name="syncWindowDays" label={tx("Keep in sync the last")} hint={tx("In every folder. Older mail loads when you ask for it.")} unit={tx("days")} />
            <SwitchSetting port={settings} name="instantMail" label={tx("Instant new mail")} hint={tx("Keeps a connection open to each server (IMAP IDLE), so new mail arrives at once.")} />
          </div>
        </SettingsGroup>
      ) : null}
    </div>
  );
}
