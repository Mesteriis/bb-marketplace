import { Eye } from "lucide-react";

const compact = new Intl.NumberFormat(undefined, { notation: "compact" });
const full = new Intl.NumberFormat();

export function ChannelViewCount({ count }: { count: number }) {
  const label = `${full.format(count)} ${count === 1 ? "view" : "views"}`;
  return <span role="img" aria-label={label} title={label}>
    <Eye size={14} aria-hidden="true" />
    {compact.format(count)}
  </span>;
}
