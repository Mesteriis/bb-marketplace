// The right side of BB's title bar: the layout switcher with the save state,
// "add panel", the hidden panels and a new thread. On a narrow bar everything
// except "add panel" folds into one menu. It holds workspace controls only;
// navigation between projects and threads stays in BB's own sidebar.
import { type KeyboardEvent, useId, useState } from "react";
import { MoreIcon } from "../tiles/icons.tsx";
import { ContentPicker, type ContentPickerProps } from "./ContentPicker.tsx";
import { HiddenPanelsList, type HiddenPanelsListProps } from "./HiddenPanelsList.tsx";
import { LayoutSwitcher, type LayoutSwitcherProps } from "./LayoutSwitcher.tsx";
import { Icon, Modal, classes, usePopover } from "./primitives.tsx";
import { chromeStrings } from "./strings.ts";

const text = chromeStrings.toolbar;

export interface HeaderActionsProps {
  layouts: LayoutSwitcherProps;
  /** What "add panel" offers. It always adds a tile, so the tile limit applies. */
  content: Pick<ContentPickerProps, "sections" | "tileCount" | "tileLimit" | "onOpen" | "onFocusExisting">;
  hiddenPanels: HiddenPanelsListProps;
  /** Opens BB's new thread screen. */
  onNewThread: () => void;
  /** The bar has no room for the whole row: all but "add panel" is in the "…" menu. */
  narrow?: boolean;
}

/** Left and Right move between the controls of the row; keys pressed inside an open list or field are left alone. */
function moveAlongToolbar(event: KeyboardEvent<HTMLDivElement>): void {
  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
  if (!(event.target instanceof HTMLElement) || !event.target.hasAttribute("data-toolbar-item")) return;
  const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>("[data-toolbar-item]"));
  const index = items.indexOf(event.target);
  const next = event.key === "ArrowRight" ? Math.min(index + 1, items.length - 1) : Math.max(index - 1, 0);
  event.preventDefault();
  items[next].focus();
}

function NewThreadButton({ onNewThread }: { onNewThread: () => void }) {
  return (
    <button type="button" data-toolbar-item className={classes.ghostButton} onClick={onNewThread}>
      {text.newThread}
    </button>
  );
}

/** The folded controls. Its own popover has no scroll box, so the lists inside it open over the page, not inside a clip. */
function MoreMenu({ layouts, hiddenPanels, onNewThread }: Pick<HeaderActionsProps, "layouts" | "hiddenPanels" | "onNewThread">) {
  const popover = usePopover("end");
  return (
    <div ref={popover.rootRef} className="relative shrink-0" onKeyDown={popover.onKeyDown} onBlur={popover.onBlur}>
      <button
        ref={popover.triggerRef}
        type="button"
        data-toolbar-item
        data-focus-return
        className={classes.iconButton}
        aria-haspopup="dialog"
        aria-expanded={popover.open}
        aria-label={text.more}
        title={text.more}
        onClick={() => (popover.open ? popover.close() : popover.setOpen(true))}
      >
        <MoreIcon />
      </button>
      {popover.open && (
        <div
          ref={popover.panelRef}
          role="dialog"
          tabIndex={-1}
          aria-label={text.more}
          className="absolute top-full z-50 mt-1 flex w-max max-w-[calc(100vw-1rem)] flex-col items-stretch gap-1 rounded-md border border-border bg-background p-1 text-sm text-foreground shadow-sm focus-visible:outline-none"
        >
          <LayoutSwitcher {...layouts} />
          <HiddenPanelsList {...hiddenPanels} />
          <NewThreadButton
            onNewThread={() => {
              popover.close();
              onNewThread();
            }}
          />
        </div>
      )}
    </div>
  );
}

export function HeaderActions({ layouts, content, hiddenPanels, onNewThread, narrow = false }: HeaderActionsProps) {
  const [picking, setPicking] = useState(false);
  const pickerHeadingId = useId();

  return (
    <>
      <div role="toolbar" aria-label={chromeStrings.toolbar.label} className="flex shrink-0 items-center gap-1" onKeyDown={moveAlongToolbar}>
        {!narrow && <LayoutSwitcher {...layouts} />}
        <button type="button" data-toolbar-item className={classes.ghostButton} aria-haspopup="dialog" aria-label={text.addPanel} onClick={() => setPicking(true)}>
          <Icon name="plus" />
          <span>{text.addPanelShort}</span>
        </button>
        {narrow ? (
          <MoreMenu layouts={layouts} hiddenPanels={hiddenPanels} onNewThread={onNewThread} />
        ) : (
          <>
            <HiddenPanelsList {...hiddenPanels} />
            <NewThreadButton onNewThread={onNewThread} />
          </>
        )}
      </div>

      {picking && (
        <Modal labelledBy={pickerHeadingId} onDismiss={() => setPicking(false)} className="h-[min(32rem,100%)] max-w-lg">
          <ContentPicker
            target="new-tile"
            headingId={pickerHeadingId}
            sections={content.sections}
            tileCount={content.tileCount}
            tileLimit={content.tileLimit}
            onOpen={(choice) => {
              setPicking(false);
              content.onOpen(choice);
            }}
            onFocusExisting={(tileId) => {
              setPicking(false);
              content.onFocusExisting(tileId);
            }}
          />
        </Modal>
      )}
    </>
  );
}
