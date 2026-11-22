import type { ReactNode } from "react";
import * as Popover from "@radix-ui/react-popover";
import { usePortalScopeProps } from "@/lib/portal-scope";

export function ActionPopover({
  label,
  trigger,
  children,
}: {
  label: string;
  trigger: ReactNode;
  children: ReactNode;
}) {
  const scope = usePortalScopeProps();
  return (
    <Popover.Root>
      <Popover.Trigger asChild>{trigger}</Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          {...scope}
          align="end"
          sideOffset={4}
          collisionPadding={8}
          aria-label={label}
          onEscapeKeyDown={(event) => event.stopPropagation()}
          className="z-50 flex max-w-[calc(100vw-1rem)] flex-col items-stretch gap-1 rounded-md border border-border bg-popover p-2 text-popover-foreground shadow-md [&_button]:justify-start"
        >
          {children}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
