// Mail settings as a page of its own: a grouped menu on the left, one
// section on the right. Every section has an address (routes.ts
// settingsSubPath), so the menu's items are links and BB's back and forward
// work. In a narrow panel the menu is a select above the section.
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { tx } from "../i18n/index.ts";
import { SettingsBody, availableSections } from "./settings-body.tsx";
import type { MailSettingsProps } from "./shared.ts";
import { SettingsSection } from "./primitives.tsx";
import { SETTINGS_GROUPS, settingsSectionText, type SettingsSectionId } from "./sections.ts";

export type SettingsPageProps = MailSettingsProps & {
  /** The section the address names. */
  section: SettingsSectionId;
  onSection: (section: SettingsSectionId) => void;
  /** Back to the mailbox the owner came from. */
  onBack: () => void;
};

export function SettingsPage(props: SettingsPageProps) {
  const available = availableSections(props);
  const groups = SETTINGS_GROUPS.map((group) => ({
    ...group,
    sections: group.sections.filter((section) => available.has(section.id)),
  })).filter((group) => group.sections.length > 0);
  // A section the page cannot show (its ports are missing) opens the first one that it can.
  const section = available.has(props.section) ? props.section : groups[0]!.sections[0]!.id;
  const text = settingsSectionText(section);

  return (
    <section aria-label={tx("Mail settings")} className="@container flex min-h-0 flex-col gap-4">
      <header className="flex items-center gap-2">
        <Button variant="ghost" size="sm" className="h-7 gap-1 px-2 text-muted-foreground" onClick={props.onBack}>
          <Icon name="ArrowLeft" className="size-3.5" />
          {tx("Mail")}
        </Button>
        <h1 className="text-base font-semibold text-foreground">{tx("Settings")}</h1>
      </header>

      <div className="flex min-h-0 flex-col gap-4 @2xl:flex-row @2xl:gap-8">
        <div className="@2xl:hidden">
          <Select value={section} onValueChange={(next) => props.onSection(next as SettingsSectionId)}>
            <SelectTrigger aria-label={tx("Section")} className="h-9 w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {groups.map((group) => (
                <SelectGroup key={group.id}>
                  <SelectLabel>{tx(group.title)}</SelectLabel>
                  {group.sections.map((item) => (
                    <SelectItem key={item.id} value={item.id}>
                      {tx(item.title)}
                    </SelectItem>
                  ))}
                </SelectGroup>
              ))}
            </SelectContent>
          </Select>
        </div>

        <nav aria-label={tx("Settings")} className="hidden w-52 shrink-0 flex-col gap-4 @2xl:flex">
          {groups.map((group) => (
            <div key={group.id} className="flex flex-col gap-0.5">
              <p id={`settings-group-${group.id}`} className="px-2 pb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {tx(group.title)}
              </p>
              <ul aria-labelledby={`settings-group-${group.id}`} className="flex flex-col gap-0.5">
                {group.sections.map((item) => (
                  <li key={item.id}>
                    <a
                      href={`#${item.id}`}
                      aria-current={item.id === section ? "page" : undefined}
                      onClick={(event) => {
                        event.preventDefault();
                        props.onSection(item.id);
                      }}
                      className={cn(
                        "block rounded-md px-2 py-1.5 text-sm transition-colors",
                        item.id === section
                          ? "bg-state-active font-medium text-foreground"
                          : "text-muted-foreground hover:bg-state-hover hover:text-foreground",
                      )}
                    >
                      {tx(item.title)}
                      {item.id === "plugin_access" && (props.pluginAccess?.waiting ?? 0) > 0 ? (
                        <span className="ml-1.5 rounded-full bg-primary px-1.5 py-0.5 text-xs font-medium text-primary-foreground">
                          {props.pluginAccess?.waiting}
                        </span>
                      ) : null}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>

        <div role="region" aria-label={tx(text.title)} className="min-w-0 max-w-2xl flex-1">
          <SettingsSection title={tx(text.title)} description={tx(text.description)}>
            <SettingsBody {...props} section={section} />
          </SettingsSection>
        </div>
      </div>
    </section>
  );
}
