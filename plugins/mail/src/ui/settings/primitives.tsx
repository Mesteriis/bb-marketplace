// The layout blocks every settings section is built from, so the sections
// read as one page: a section with its title and one sentence, a row for one
// setting (label and hint on the left, its control on the right), and a
// titled group for a list with its action.
import { useId, type ReactNode } from "react";
import { cn } from "@/lib/utils";

/** A section of the settings page: its title, one sentence about it, its content. */
export function SettingsSection({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold text-foreground">{title}</h2>
        {description !== undefined ? <p className="text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {children}
    </div>
  );
}

/** A group's heading with its action on the right. */
export function SectionHeading({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex items-center gap-2 pb-1 pt-2">
      <h3 className="min-w-0 flex-1 text-sm font-semibold text-foreground">{children}</h3>
      {action}
    </div>
  );
}

/** A titled block for a list (addresses, rules, keys) with its "New …" action. */
export function SettingsGroup({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <SectionHeading action={action}>{title}</SectionHeading>
      {children}
    </div>
  );
}

/**
 * One setting: the label and hint on the left, one control on the right; in
 * a narrow panel the control goes under the text. `control` receives the id
 * the label points at. A refused change is said in the row.
 */
export function SettingRow({
  label,
  hint,
  problem,
  note,
  control,
  className,
}: {
  label: string;
  hint?: string;
  /** Why the last change was refused. */
  problem?: string | null;
  /** A quiet word next to the control ("Saved"). */
  note?: string | null;
  control: (ids: { id: string; describedBy: string | undefined }) => ReactNode;
  className?: string;
}) {
  const id = useId();
  const hintId = hint !== undefined ? `${id}-hint` : undefined;
  return (
    <div className={cn("flex flex-col gap-2 border-t border-border py-3 first:border-t-0 @md:flex-row @md:items-center @md:gap-4", className)}>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <label htmlFor={id} className="text-sm font-medium text-foreground">
          {label}
        </label>
        {hint !== undefined ? (
          <p id={hintId} className="text-xs text-muted-foreground">
            {hint}
          </p>
        ) : null}
        {problem !== undefined && problem !== null ? (
          <p role="alert" className="text-xs text-destructive">
            {problem}
          </p>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {note !== undefined && note !== null ? (
          <span role="status" className="text-xs text-muted-foreground">
            {note}
          </span>
        ) : null}
        {control({ id, describedBy: hintId })}
      </div>
    </div>
  );
}
