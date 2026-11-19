// Mail settings, "Plugin access": which other plugins may read mail and what
// each may do. A plugin can only ask; every grant here is the owner's click.
// A plugin id is another plugin's text and is shown as text, never as markup.
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { isGoogleRight, PLUGIN_RIGHTS, type PluginRight } from "../../core/plugin-access.ts";
import { dateLocale, msg, tx } from "../i18n/index.ts";
import { SettingsGroup } from "./primitives.tsx";
import { Switch, type SaveResult } from "./setting-controls.tsx";

export type PluginAccessView = {
  plugins: { pluginId: string; grants: { right: PluginRight; accountId: string; grantedAt: string }[]; lastCallAt: string | null }[];
  requests: { pluginId: string; rights: PluginRight[]; reason: string; askedAt: string }[];
};

export type PluginAccessPort = {
  load: () => Promise<PluginAccessView>;
  setGrant: (pluginId: string, right: PluginRight, accountId: string, on: boolean) => Promise<SaveResult>;
  revoke: (pluginId: string) => Promise<SaveResult>;
  dismiss: (pluginId: string) => Promise<SaveResult>;
};

export type PluginAccessAccount = { id: string; email: string; google: boolean };

export const RIGHT_LABEL: Record<PluginRight, string> = {
  "mail.read": msg("Read mail"),
  "contacts.read": msg("Read contacts"),
  "invites.read": msg("Read invitations"),
  "mail.propose": msg("Propose letters"),
  "google.calendar": msg("Google Calendar key"),
  "google.contacts": msg("Google Contacts key"),
};

const cellKey = (right: PluginRight, accountId: string) => `${right}\n${accountId}`;

/** Rights by accounts: one switch per cell. */
function RightsTable({
  pluginId,
  rights,
  accounts,
  on,
  busy,
  onToggle,
}: {
  pluginId: string;
  rights: readonly PluginRight[];
  accounts: readonly PluginAccessAccount[];
  on: ReadonlySet<string>;
  busy: boolean;
  onToggle: (right: PluginRight, account: PluginAccessAccount, next: boolean) => void;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-max border-collapse text-sm">
        <thead>
          <tr>
            <th scope="col" className="py-1.5 pr-3 text-left text-xs font-medium text-muted-foreground">
              {tx("Right")}
            </th>
            {accounts.map((account) => (
              <th key={account.id} scope="col" className="px-2 py-1.5 text-left text-xs font-medium text-muted-foreground">
                {account.email}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rights.map((right) => (
            <tr key={right} className="border-t border-border">
              <th scope="row" className="py-2 pr-3 text-left font-normal text-foreground">
                {tx(RIGHT_LABEL[right])}
              </th>
              {accounts.map((account) => {
                const needsGoogle = isGoogleRight(right) && !account.google;
                return (
                  <td key={account.id} className="px-2 py-2">
                    <span className="flex items-center gap-2">
                      <Switch
                        id={`plugin-${pluginId}-${right}-${account.id}`}
                        label={`${tx(RIGHT_LABEL[right])}, ${account.email}`}
                        checked={on.has(cellKey(right, account.id))}
                        disabled={busy || needsGoogle}
                        onChange={(next) => onToggle(right, account, next)}
                      />
                      {needsGoogle ? <span className="text-xs text-muted-foreground">{tx("Needs Google sign-in")}</span> : null}
                    </span>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function shortDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString(dateLocale(), { dateStyle: "medium", timeStyle: "short" });
}

export function PluginAccessSection({
  port,
  accounts,
  onGoogleGrant,
  reloadKey = 0,
}: {
  port: PluginAccessPort;
  accounts: readonly PluginAccessAccount[];
  /** A Google key needs Google's consent first: the page runs that sign-in and saves the grant. */
  onGoogleGrant?: (pluginId: string, right: PluginRight, accountId: string) => void;
  /** Changes when requests or grants changed elsewhere. */
  reloadKey?: number;
}) {
  const [view, setView] = useState<PluginAccessView | null>(null);
  const [problem, setProblem] = useState<{ pluginId: string | null; message: string } | null>(null);
  const [busy, setBusy] = useState(false);
  /** A request being allowed: its plugin and the cells checked so far; nothing is saved until Save. */
  const [allowing, setAllowing] = useState<{ pluginId: string; cells: ReadonlySet<string> } | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setView(await port.load());
    } catch {
      setProblem({ pluginId: null, message: tx("Could not load plugin access.") });
    }
  }, [port]);
  useEffect(() => {
    void reload();
  }, [reload, reloadKey]);

  const run = async (pluginId: string, work: () => Promise<SaveResult>) => {
    setBusy(true);
    setProblem(null);
    try {
      const result = await work();
      if (!result.ok) setProblem({ pluginId, message: result.message });
    } finally {
      await reload();
      setBusy(false);
    }
  };

  // Google keys are offered only where the page can run Google's consent for them.
  const rights = PLUGIN_RIGHTS.filter((right) => onGoogleGrant !== undefined || !isGoogleRight(right));

  const note = (
    <p className="text-xs text-muted-foreground">
      {tx("This governs calls from other plugins' servers. A plugin's page runs with your own access, as everything you install in BB does.")}
    </p>
  );
  if (view === null) {
    return (
      <div className="flex flex-col gap-3">
        {note}
        {problem !== null ? (
          <p role="alert" className="text-sm text-destructive">
            {problem.message}
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">{tx("Loading…")}</p>
        )}
      </div>
    );
  }

  const problemOf = (pluginId: string) =>
    problem !== null && problem.pluginId === pluginId ? (
      <p role="alert" className="text-xs text-destructive">
        {problem.message}
      </p>
    ) : null;

  return (
    <div className="flex flex-col gap-4">
      {note}
      {view.requests.length === 0 && view.plugins.length === 0 ? (
        <p className="text-sm text-muted-foreground">{tx("No plugin has asked for access to mail.")}</p>
      ) : null}

      {view.requests.length > 0 ? (
        <SettingsGroup title={tx("Requests")}>
          <ul className="flex flex-col gap-2">
            {view.requests.map((request) => {
              const open = allowing?.pluginId === request.pluginId;
              return (
                <li key={request.pluginId} aria-label={request.pluginId} className="flex flex-col gap-2 rounded-md border border-border p-3">
                  <div className="flex flex-col gap-0.5">
                    <span className="break-all font-mono text-sm text-foreground">{request.pluginId}</span>
                    {request.reason !== "" ? <span className="text-sm text-muted-foreground">{request.reason}</span> : null}
                    <span className="text-xs text-muted-foreground">
                      {tx("Asks for: {rights}", { rights: request.rights.map((right) => tx(RIGHT_LABEL[right])).join(", ") })}
                    </span>
                  </div>
                  {open ? (
                    <>
                      <RightsTable
                        rights={rights}
                        pluginId={request.pluginId}
                        accounts={accounts}
                        on={allowing.cells}
                        busy={busy}
                        onToggle={(right, account, next) => {
                          if (isGoogleRight(right)) {
                            if (next) onGoogleGrant?.(request.pluginId, right, account.id);
                            return;
                          }
                          const cells = new Set(allowing.cells);
                          if (next) cells.add(cellKey(right, account.id));
                          else cells.delete(cellKey(right, account.id));
                          setAllowing({ pluginId: request.pluginId, cells });
                        }}
                      />
                      <div className="flex flex-wrap gap-2">
                        <Button
                          size="sm"
                          disabled={busy}
                          onClick={() =>
                            void run(request.pluginId, async () => {
                              for (const cell of allowing.cells) {
                                const [right, accountId] = cell.split("\n") as [PluginRight, string];
                                const saved = await port.setGrant(request.pluginId, right, accountId, true);
                                if (!saved.ok) return saved;
                              }
                              setAllowing(null);
                              return port.dismiss(request.pluginId);
                            })
                          }
                        >
                          {tx("Save")}
                        </Button>
                        <Button variant="outline" size="sm" disabled={busy} onClick={() => setAllowing(null)}>
                          {tx("Cancel")}
                        </Button>
                      </div>
                    </>
                  ) : (
                    <div className="flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        disabled={busy}
                        onClick={() =>
                          setAllowing({
                            pluginId: request.pluginId,
                            // With one mailbox the asked rights start checked; with several, which mailbox is the owner's to pick.
                            // Google keys are turned on one by one.
                            cells: new Set(
                              accounts.length === 1
                                ? request.rights.filter((right) => !isGoogleRight(right)).map((right) => cellKey(right, accounts[0]!.id))
                                : [],
                            ),
                          })
                        }
                      >
                        {tx("Allow…")}
                      </Button>
                      <Button variant="outline" size="sm" disabled={busy} onClick={() => void run(request.pluginId, () => port.dismiss(request.pluginId))}>
                        {tx("Dismiss")}
                      </Button>
                    </div>
                  )}
                  {problemOf(request.pluginId)}
                </li>
              );
            })}
          </ul>
        </SettingsGroup>
      ) : null}

      {view.plugins.length > 0 ? (
        <SettingsGroup title={tx("Plugins with access")}>
          <ul className="flex flex-col gap-2">
            {view.plugins.map((plugin) => (
              <li key={plugin.pluginId} aria-label={plugin.pluginId} className="flex flex-col gap-2 rounded-md border border-border p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="min-w-0 flex-1 break-all font-mono text-sm text-foreground">{plugin.pluginId}</span>
                  <span className="text-xs text-muted-foreground">
                    {plugin.lastCallAt === null ? tx("Never called") : tx("Last call: {date}", { date: shortDate(plugin.lastCallAt) })}
                  </span>
                </div>
                <RightsTable
                  rights={rights}
                  pluginId={plugin.pluginId}
                  accounts={accounts}
                  on={new Set(plugin.grants.map((grant) => cellKey(grant.right, grant.accountId)))}
                  busy={busy}
                  onToggle={(right, account, next) => {
                    if (next && isGoogleRight(right)) {
                      onGoogleGrant?.(plugin.pluginId, right, account.id);
                      return;
                    }
                    void run(plugin.pluginId, () => port.setGrant(plugin.pluginId, right, account.id, next));
                  }}
                />
                {plugin.grants.some((grant) => isGoogleRight(grant.right)) ? (
                  <p className="text-xs text-muted-foreground">{tx("A key already handed out works for up to an hour after you revoke.")}</p>
                ) : null}
                {revoking === plugin.pluginId ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm text-foreground">{tx("Take away everything this plugin has?")}</span>
                    <Button
                      variant="destructive"
                      size="sm"
                      disabled={busy}
                      onClick={() => {
                        setRevoking(null);
                        void run(plugin.pluginId, () => port.revoke(plugin.pluginId));
                      }}
                    >
                      {tx("Revoke")}
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => setRevoking(null)}>
                      {tx("Cancel")}
                    </Button>
                  </div>
                ) : (
                  <div>
                    <Button variant="outline" size="sm" disabled={busy} onClick={() => setRevoking(plugin.pluginId)}>
                      {tx("Revoke all")}
                    </Button>
                  </div>
                )}
                {problemOf(plugin.pluginId)}
              </li>
            ))}
          </ul>
        </SettingsGroup>
      ) : null}
    </div>
  );
}
