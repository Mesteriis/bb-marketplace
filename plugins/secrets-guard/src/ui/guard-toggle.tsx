// The composer lock with its own popover. The window belongs to the composer,
// not to the lock: it sits right above the composer, lines up with the
// composer's right edge and is never wider than the composer, so it stays
// inside the composer's column and does not cover the composer itself.
// Placement, dismissal (Escape, a press outside, a second press on the button)
// and the focus returning to the button are the popover library's; the host
// provides that library to plugins at run time.
import * as Popover from "@radix-ui/react-popover";
import { useRef, useState } from "react";
import { findComposerRoot } from "./composer-root.ts";
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

const WINDOW = "z-50 rounded-lg border border-border bg-popover text-popover-foreground shadow-md outline-none";
/**
 * The window's width limit. Anchored to the composer: the composer's width
 * (the library reports its anchor's width), so with the right edges lined up
 * the window cannot leave the composer on the left; the controls fold inside.
 * Anchored to the button, when no composer is found: the room in the viewport.
 */
const WIDTH = {
  composer: "max-w-[min(var(--radix-popover-trigger-width),var(--radix-popover-content-available-width))]",
  button: "max-w-[var(--radix-popover-content-available-width)]",
} as const;

export function GuardToggle({ problem, scopeProps, ...popup }: GuardToggleProps) {
  const button = useRef<HTMLButtonElement>(null);
  const content = useRef<HTMLDivElement>(null);
  // The composer the window is anchored to; looked up on every opening.
  const composer = useRef<HTMLElement | null>(null);
  const [anchor, setAnchor] = useState<"composer" | "button">("button");

  return (
    <Popover.Root
      onOpenChange={(open) => {
        if (!open) return;
        composer.current = findComposerRoot(button.current);
        setAnchor(composer.current === null ? "button" : "composer");
      }}
    >
      {anchor === "composer" ? <Popover.Anchor virtualRef={composer as { current: HTMLElement }} /> : null}
      <Popover.Trigger asChild>
        <GuardButton ref={button} view={popup.view} now={popup.now} problem={problem} />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          {...scopeProps}
          ref={content}
          data-anchor={anchor}
          side="top"
          align="end"
          sideOffset={8}
          collisionPadding={8}
          aria-label="Секреты"
          className={`${WINDOW} ${WIDTH[anchor]}`}
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
