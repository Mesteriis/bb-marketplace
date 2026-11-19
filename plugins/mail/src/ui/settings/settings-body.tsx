import { useEffect, useState } from "react";
import { AiAccessSettings } from "../ai-access-settings.tsx";
import { AgentActivity } from "../agent-activity.tsx";
import { BbIntegrationSettings } from "../bb-integration-settings.tsx";
import { RulesSettings } from "../rules-settings.tsx";
import { FiltersSettings } from "../filters-settings.tsx";
import { SubscriptionsSettings } from "../subscriptions-settings.tsx";
import { tx } from "../i18n/index.ts";
import type { SettingsSectionId } from "./sections.ts";
import { PgpSettings } from "../pgp-settings.tsx";
import { PLUGIN_SETTINGS_HINT, type MailSettingsProps } from "./shared.ts";
import { AccountsSection } from "./accounts-section.tsx";
import { AgentSwitches } from "./section-settings.tsx";
import { AddressesSection } from "./addresses-section.tsx";
import { LocalDataSection } from "./local-data-section.tsx";
import { PluginAccessSection } from "./plugin-access-section.tsx";
import { AiFeaturesSection } from "./ai-features-section.tsx";
import { InboxSection } from "./inbox-section.tsx";
import { SearchSection } from "./reading-section.tsx";
import { TemplatesSection } from "./templates-section.tsx";

/** Which sections the page can show with the ports it was given. */
export function availableSections(props: MailSettingsProps): ReadonlySet<SettingsSectionId> {
  const ids: SettingsSectionId[] = ["accounts", "addresses", "templates", "local"];
  if (props.onUnblock !== undefined) ids.push("inbox");
  if (props.filters !== undefined) ids.push("filters");
  if (props.subscriptions !== undefined) ids.push("subscriptions");
  if (props.ai !== undefined) ids.push("ai", "ai_access", "activity");
  if (props.bb !== undefined) ids.push("bb", "rules");
  if (props.search !== undefined) ids.push("reading");
  if (props.pgp !== undefined) ids.push("pgp");
  if (props.pluginAccess !== undefined) ids.push("plugin_access");
  return new Set(ids);
}

/** One section of the settings page; a section the page cannot show falls back to the first. */
export function SettingsBody(props: MailSettingsProps & { section: SettingsSectionId }) {
  const { accounts, section } = props;
  const [accountId, setAccountId] = useState<string | null>(accounts[0]?.id ?? null);
  useEffect(() => {
    if (accountId === null || !accounts.some((a) => a.id === accountId)) setAccountId(accounts[0]?.id ?? null);
  }, [accountId, accounts]);
  const account = accounts.find((a) => a.id === accountId) ?? null;

  if (section === "addresses") {
    return account === null ? (
      <p className="text-sm text-muted-foreground">{tx("No mail account yet.")}</p>
    ) : (
      <AddressesSection key={account.id} {...props} account={account} onSelectAccount={setAccountId} />
    );
  }
  if (section === "ai_access" && props.ai !== undefined) {
    return (
      <div className="flex flex-col gap-4">
        {props.settings !== undefined ? <AgentSwitches port={props.settings} /> : null}
        <AiAccessSettings accounts={accounts} {...props.ai.scope} />
      </div>
    );
  }
  if (section === "plugin_access" && props.pluginAccess !== undefined) {
    return (
      <PluginAccessSection
        port={props.pluginAccess.port}
        accounts={accounts.map((a) => ({ id: a.id, email: a.email, google: a.authKind === "google" }))}
        onGoogleGrant={props.pluginAccess.onGoogleGrant}
        reloadKey={props.pluginAccess.reloadKey}
      />
    );
  }
  if (section === "activity" && props.ai !== undefined) return <AgentActivity {...props.ai.activity} />;
  if (section === "ai" && props.ai !== undefined) return <AiFeaturesSection ai={props.ai} settings={props.settings} />;
  if (section === "bb" && props.bb !== undefined) {
    return <BbIntegrationSettings values={props.bb.values} call={props.bb.call} hint={PLUGIN_SETTINGS_HINT} settings={props.settings} />;
  }
  if (section === "rules" && props.bb !== undefined) {
    return <RulesSettings on={props.bb.mailRules} call={props.bb.call} notify={props.bb.notify} hint={PLUGIN_SETTINGS_HINT} settings={props.settings} />;
  }
  if (section === "subscriptions" && props.subscriptions !== undefined) {
    return <SubscriptionsSettings ports={props.subscriptions} accounts={props.accounts} />;
  }
  if (section === "filters" && props.filters !== undefined) return <FiltersSettings ports={props.filters} accounts={props.accounts} />;
  if (section === "pgp" && props.pgp !== undefined) return <PgpSettings ports={props.pgp} identities={props.identities} />;
  if (section === "reading" && props.search !== undefined) return <SearchSection search={props.search} hint={PLUGIN_SETTINGS_HINT} settings={props.settings} />;
  if (section === "inbox" && props.onUnblock !== undefined) {
    return (
      <InboxSection
        accounts={accounts}
        rules={props.blockRules ?? null}
        onUnblock={props.onUnblock}
        onChangeSnoozeFolder={props.onChangeSnoozeFolder}
        settings={props.settings}
      />
    );
  }
  if (section === "templates") {
    return <TemplatesSection templates={props.templates} onSave={props.onSaveTemplate} onDelete={props.onDeleteTemplate} />;
  }
  if (section === "local") return <LocalDataSection vaultReady={props.vaultReady !== false} onCopy={props.onCopy} />;
  return (
    <AccountsSection
      accounts={accounts}
      settings={props.settings}
      onAddAccount={props.onAddAccount}
      onReplacePassword={props.onReplacePassword}
      onGoogleSwitch={props.onGoogleSwitch}
      onOpenSmtp={props.onOpenSmtp}
      onCopy={props.onCopy}
    />
  );
}
