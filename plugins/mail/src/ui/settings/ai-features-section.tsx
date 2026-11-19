import { useEffect, useState } from "react";
import type { CategoryRuleView } from "../../core/model.ts";
import { categoryLabel } from "../category-chips.tsx";
import { Button } from "@/components/ui/button";
import { tx } from "../i18n/index.ts";
import { type SettingsAiPorts, PLUGIN_SETTINGS_HINT, messageOf } from "./shared.ts";
import { SectionHeading } from "./primitives.tsx";

/** Categories, Today, reply reminders and AI settings (slice 3f). */
export function AiFeaturesSection({ ai }: { ai: SettingsAiPorts }) {
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
        <p className="text-sm text-foreground">{ai.categoriesOn ? tx("On: mail is sorted into local labels.") : "Off."}</p>
        <p className="text-xs text-muted-foreground">
          {tx("Bills, Notifications, Personal and Newsletters live only in Makosh Mail; nothing is written to the mail server.")}{" "}
          {PLUGIN_SETTINGS_HINT}
        </p>
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
        <p className="text-sm text-foreground">
          {ai.morningDigest ? `On: the Today digest is ready at ${ai.digestTime}.` : tx("Off: the Today view still works when you open it.")}
        </p>
        <p className="text-xs text-muted-foreground">{PLUGIN_SETTINGS_HINT}</p>
      </section>
      <section aria-label={tx("Reply reminders")} className="flex flex-col gap-1">
        <SectionHeading>{tx("Reply reminders")}</SectionHeading>
        <p className="text-sm text-foreground">{tx("Remind me after {p1} by default.", { p1: ai.reminderDays === 1 ? "1 day" : `${ai.reminderDays} days` })}</p>
        <p className="text-xs text-muted-foreground">
          {tx("A reminder turns due when no message answering yours (by In-Reply-To or References) arrives in time.")} {PLUGIN_SETTINGS_HINT}
        </p>
      </section>
      <section aria-label={tx("AI settings")} className="flex flex-col items-start gap-1">
        <SectionHeading>{tx("AI settings")}</SectionHeading>
        <p className="text-xs text-muted-foreground">{tx("The Makosh AI provider and model every AI feature and translation uses.")}</p>
        <Button variant="outline" size="sm" onClick={ai.onOpenAiSettings}>
          {tx("AI settings\u2026")}
        </Button>
      </section>
    </div>
  );
}
