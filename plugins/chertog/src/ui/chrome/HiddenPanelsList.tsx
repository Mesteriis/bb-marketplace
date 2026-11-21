// Live panels that are in no tile of the current layout. Hiding a panel must
// not lose it: the button counts them, and the list shows or closes each one.
// Whether closing needs a confirmation is the caller's decision.
import { useRef } from "react";
import { Icon, classes, moveByArrows, usePendingFocus, usePopover } from "./primitives.tsx";
import { chromeStrings } from "./strings.ts";
import type { HiddenPanelEntry } from "./types.ts";

const text = chromeStrings.hidden;

export interface HiddenPanelsListProps {
  panels: readonly HiddenPanelEntry[];
  onShow: (instanceId: string) => void;
  onClose: (instanceId: string) => void;
}

export function HiddenPanelsList({ panels, onShow, onClose }: HiddenPanelsListProps) {
  const popover = usePopover();
  const requestFocus = usePendingFocus(popover.rootRef);
  const listRef = useRef<HTMLUListElement>(null);

  function toggle() {
    if (popover.open) return popover.close();
    popover.setOpen(true);
    requestFocus((container) => container.querySelector<HTMLElement>("[data-nav]"));
  }

  return (
    <div ref={popover.rootRef} className="relative shrink-0" onKeyDown={popover.onKeyDown} onBlur={popover.onBlur}>
      <button
        ref={popover.triggerRef}
        type="button"
        data-focus-return
        data-toolbar-item
        className={classes.ghostButton}
        aria-haspopup="dialog"
        aria-expanded={popover.open}
        aria-label={text.triggerLabel(panels.length)}
        onClick={toggle}
      >
        <Icon name="hidden" />
        <span className="hidden sm:inline">{text.trigger}</span>
        <span className="rounded bg-secondary px-1 tabular-nums text-secondary-foreground">{panels.length}</span>
      </button>

      {popover.open && (
        <div ref={popover.panelRef} role="dialog" tabIndex={-1} aria-label={text.popoverLabel} className={`${classes.popover} right-0`}>
          {panels.length === 0 ? (
            <p className={classes.muted}>{text.empty}</p>
          ) : (
            <>
              <p className={classes.muted}>{text.hint}</p>
              <ul ref={listRef} className="flex flex-col gap-0.5" onKeyDown={(event) => moveByArrows(event, listRef.current)}>
                {panels.map((panel) => (
                  <li key={panel.instanceId} className="flex min-h-7 items-center gap-1 px-1">
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate text-xs font-medium">{panel.title}</span>
                      {panel.context !== undefined && <span className="truncate text-xs text-muted-foreground">{panel.context}</span>}
                    </span>
                    <button
                      type="button"
                      data-nav
                      className={classes.button}
                      aria-label={text.showLabel(panel.title)}
                      onClick={() => onShow(panel.instanceId)}
                    >
                      {text.show}
                    </button>
                    <button type="button" className={classes.button} aria-label={text.closeLabel(panel.title)} onClick={() => onClose(panel.instanceId)}>
                      {text.close}
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </div>
  );
}
