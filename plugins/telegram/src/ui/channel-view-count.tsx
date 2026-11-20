import { Eye } from "lucide-react";
import { useTelegramLocale } from "./i18n/index.tsx";

const compact = { en: new Intl.NumberFormat("en", { notation: "compact" }), ru: new Intl.NumberFormat("ru", { notation: "compact" }) };

export function ChannelViewCount({ count }: { count: number }) {
  const { locale, t } = useTelegramLocale();
  const label = t(count === 1 ? "{0} view" : "{0} views", [count.toLocaleString(locale)]);
  return <span role="img" aria-label={label} title={label}>
    <Eye size={14} aria-hidden="true" />
    {compact[locale].format(count)}
  </span>;
}
