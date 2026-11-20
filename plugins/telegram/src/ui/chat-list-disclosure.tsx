import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Button } from "../../components/ui/button.tsx";

export function ChatListDisclosure({ label, trigger, iconOnly = false, className, description, children }: {
  label: string;
  trigger: ReactNode;
  iconOnly?: boolean;
  className?: string;
  description?: string;
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const id = useId();

  useEffect(() => {
    if (!open) return;
    const dismissOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener("pointerdown", dismissOutside);
    return () => document.removeEventListener("pointerdown", dismissOutside);
  }, [open]);

  function close() {
    setOpen(false);
    button.current?.focus({ preventScroll: true });
  }

  return <div className={className ? `mtg-list-disclosure ${className}` : "mtg-list-disclosure"} ref={root}
    onBlur={(event) => {
      if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) setOpen(false);
    }}
    onKeyDown={(event) => {
      if (open && event.key === "Escape" && !event.defaultPrevented) {
        event.preventDefault();
        event.stopPropagation();
        close();
      }
    }}>
    <Button ref={button} type="button" variant={iconOnly ? "ghost" : "outline"} size={iconOnly ? "icon" : "sm"}
      className="mtg-list-disclosure-trigger" aria-label={label} aria-description={description}
      aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>{trigger}</Button>
    <div className="mtg-list-popup" role="group" aria-label={label} id={id} hidden={!open}>{children(close)}</div>
  </div>;
}
