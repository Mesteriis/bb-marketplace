// The composer lock with its own popover: the window is as wide as its
// content, sits above the button, lines up with the button's right edge and
// stays inside the viewport. Placement, dismissal (Escape, a press outside, a
// second press on the button) and the focus returning to the button are the
// popover library's; the host provides that library to plugins at run time.
import * as Popover from "@radix-ui/react-popover";
import { useRef } from "react";
import { GuardButton } from "./guard-button.tsx";
import { GuardPopup, type GuardPopupProps } from "./guard-popup.tsx";

export interface GuardToggleProps extends Omit<GuardPopupProps, "layout"> {
  /** Why the state is unknown, when it is. */
  problem?: string | null;
  /**
   * Attributes that mark the portaled window as the plugin's: it is rendered
   * outside the plugin's root, and the plugin's styles are scoped to them.
   */
  scopeProps?: Readonly<Record<`data-${string}`, string>>;
}

const WINDOW =
  "z-50 max-w-[var(--radix-popover-content-available-width)] rounded-lg border border-border bg-popover text-popover-foreground shadow-md outline-none";

export function GuardToggle({ problem, scopeProps, ...popup }: GuardToggleProps) {
  const content = useRef<HTMLDivElement>(null);
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <GuardButton view={popup.view} now={popup.now} problem={problem} />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          {...scopeProps}
          ref={content}
          side="top"
          align="end"
          sideOffset={8}
          collisionPadding={8}
          aria-label="Секреты"
          className={WINDOW}
          // The scope comes first in the reading order; with the guard open the
          // library would otherwise start on «Закрыть».
          onOpenAutoFocus={(event) => {
            const selected = content.current?.querySelector<HTMLElement>('[role="radio"][aria-checked="true"]');
            if (selected === null || selected === undefined) return;
            event.preventDefault();
            selected.focus();
          }}
        >
          <GuardPopup {...popup} layout="fit" />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
