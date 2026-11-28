import type { RunFilter } from "../../core/ci/model.ts";
import { useT } from "../i18n/use-t.tsx";

const filters: {value: RunFilter; key: "ci.f.all" | "ci.f.active" | "ci.f.failed"}[] = [
  {value: "all", key: "ci.f.all"}, {value: "active", key: "ci.f.active"}, {value: "failed", key: "ci.f.failed"}];

/** All / Active / Failed: which runs a list shows. */
export function RunFilterSeg({value, onChange}: {value: RunFilter; onChange(next: RunFilter): void}) {
  const t = useT();
  return <div className="g-seg" role="group" aria-label={t("ci.show")}>{filters.map(item =>
    <button key={item.value} type="button" aria-pressed={value === item.value} onClick={() => onChange(item.value)}>{t(item.key)}</button>)}</div>;
}
