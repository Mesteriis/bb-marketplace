// Preview only: BB provides the real icon component at load time; this draws the few glyphs the preview shows.
const PATHS: Record<string, string> = {
  ChevronDown: "m6 9 6 6 6-6",
  ChevronRight: "m9 18 6-6-6-6",
  Plus: "M5 12h14M12 5v14",
  X: "M18 6 6 18M6 6l12 12",
  Settings: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2",
};
export type ExperimentalIconProps = { name: string; className?: string };
export function experimental_Icon({ name, className }: ExperimentalIconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d={PATHS[name] ?? "M4 4h16v16H4z"} />
    </svg>
  );
}
