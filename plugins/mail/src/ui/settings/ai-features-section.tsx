import { useEffect, useState } from "react";
import type { CategoryRuleView } from "../../core/model.ts";
import { categoryLabel } from "../category-chips.tsx";
import { Button } from "@/components/ui/button";
import { tx, txn } from "../i18n/index.ts";
import { CategoriesSetting, ReminderSetting, TodaySettings, TranslateLanguageSetting, WritingSettings } from "./section-settings.tsx";
import type { PageSettingsPort } from "./setting-controls.tsx";
import { type SettingsAiPorts, PLUGIN_SETTINGS_HINT, messageOf } from "./shared.ts";
import { SectionHeading } from "./primitives.tsx";

/** Categories, Today, reply reminders and AI settings (slice 3f). */
export function AiFeaturesSection({ ai, settings }: { ai: SettingsAiPorts; settings?: PageSettingsPort }) {
  const [rules, setRules] = useState<CategoryRuleView[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const { loadRules } = ai;
  useEffect(() => {
    if (!ai.categoriesOn) return;
    let live = true;
    loadRules().then(
      (found) => {
        if (live) setRules(found);
      },
      () => {
        if (live) setRules([]);
      },
    );
    return () => {
      live = false;
    };
  }, [ai.categoriesOn, loadRules]);
  const remove = async (id: string) => {
    try {
      await ai.removeRule(id);
      setRules((prev) => prev?.filter((rule) => rule.id !== id) ?? null);
    } catch (error) {
      setProblem(messageOf(error, "The rule could not be removed"));
    }
  };
  return (
    <div className="flex flex-col gap-4">
      <section aria-label={tx("Categories")} className="flex flex-col gap-1">
        <SectionHeading>{tx("Categories")}</SectionHeading>
        {settings !== undefined ? (
          <CategoriesSetting port={settings} />
        ) : (
          <>
            <p className="text-sm text-foreground">{ai.categoriesOn ? tx("On: mail is sorted into local labels.") : tx("Off.")}</p>
            <p className="text-xs text-muted-foreground">
              {tx("Bills, Notifications, Personal and Newsletters live only in Makosh Mail; nothing is written to the mail server.")}{" "}
              {tx(PLUGIN_SETTINGS_HINT)}
            </p>
          </>
        )}
        {ai.categoriesOn ? (
          rules === null ? null : rules.length === 0 ? (
            <p className="text-xs text-muted-foreground">{tx("No sender rules. Always for this sender in a conversation adds one.")}</p>
          ) : (
            <ul aria-label={tx("Category rules")} className="flex flex-col gap-1">
              {rules.map((rule) => (
                <li key={rule.id} className="flex items-center gap-2 text-sm">
                  <span className="min-w-0 flex-1 truncate text-foreground">{rule.value}</span>
                  <span className="text-xs text-muted-foreground">{categoryLabel(rule.category)}</span>
                  <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={() => void remove(rule.id)}>
                    {tx("Remove")}
                  </Button>
                </li>
              ))}
            </ul>
          )
        ) : null}
        {problem !== null ? (
          <p role="alert" className="text-xs text-destructive">
            {problem}
          </p>
        ) : null}
      </section>
      <section aria-label={tx("Today")} className="flex flex-col gap-1">
        <SectionHeading>{tx("Today")}</SectionHeading>
        {settings !== undefined ? (
          <TodaySettings port={settings} />
        ) : (
          <>
            <p className="text-sm text-foreground">
              {ai.morningDigest ? tx("On: the Today digest is ready at {time}.", { time: ai.digestTime }) : tx("Off: the Today view still works when you open it.")}
            </p>
            <p className="text-xs text-muted-foreground">{tx(PLUGIN_SETTINGS_HINT)}</p>
          </>
        )}
      </section>
      <section aria-label={tx("Reply reminders")} className="flex flex-col gap-1">
        <SectionHeading>{tx("Reply reminders")}</SectionHeading>
        {settings !== undefined ? (
          <ReminderSetting port={settings} />
        ) : (
          <>
            <p className="text-sm text-foreground">{txn(ai.reminderDays, "Remind me after {count} day by default.", "Remind me after {count} days by default.")}</p>
            <p className="text-xs text-muted-foreground">
              {tx("A reminder turns due when no message answering yours (by In-Reply-To or References) arrives in time.")} {tx(PLUGIN_SETTINGS_HINT)}
            </p>
          </>
        )}
      </section>
      {settings !== undefined ? <WritingSettings port={settings} /> : null}
      <section aria-label={tx("AI settings")} className="flex flex-col items-start gap-1">
        <SectionHeading>{tx("AI settings")}</SectionHeading>
        {settings !== undefined ? <TranslateLanguageSetting port={settings} /> : null}
        <p className="text-xs text-muted-foreground">{tx("The Makosh AI provider and model every AI feature and translation uses.")}</p>
        <Button variant="outline" size="sm" onClick={ai.onOpenAiSettings}>
          {tx("AI settings\u2026")}
        </Button>
      </section>
    </div>
  );
}
