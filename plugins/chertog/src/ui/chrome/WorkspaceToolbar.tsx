// The narrow strip above the tiled surface: the layout switcher with the save
// state, "add panel" and the hidden panels. It holds workspace controls only;
// navigation between projects and threads stays in BB's own sidebar.
import { type KeyboardEvent, useId, useState } from "react";
import { ContentPicker, type ContentPickerProps } from "./ContentPicker.tsx";
import { HiddenPanelsList, type HiddenPanelsListProps } from "./HiddenPanelsList.tsx";
import { LayoutSwitcher, type LayoutSwitcherProps } from "./LayoutSwitcher.tsx";
import { Icon, Modal, classes } from "./primitives.tsx";
import { chromeStrings } from "./strings.ts";

const text = chromeStrings.toolbar;

export interface WorkspaceToolbarProps {
  layouts: LayoutSwitcherProps;
  /** What "add panel" offers. The toolbar always adds a tile, so the tile limit applies. */
  content: Pick<ContentPickerProps, "sections" | "tileCount" | "tileLimit" | "onOpen" | "onFocusExisting">;
  hiddenPanels: HiddenPanelsListProps;
}

/** Left and Right move between the strip's own controls; keys pressed inside an open list or field are left alone. */
function moveAlongToolbar(event: KeyboardEvent<HTMLDivElement>): void {
  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
  if (!(event.target instanceof HTMLElement) || !event.target.hasAttribute("data-toolbar-item")) return;
  const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>("[data-toolbar-item]"));
  const index = items.indexOf(event.target);
  const next = event.key === "ArrowRight" ? Math.min(index + 1, items.length - 1) : Math.max(index - 1, 0);
  event.preventDefault();
  items[next].focus();
}

export function WorkspaceToolbar({ layouts, content, hiddenPanels }: WorkspaceToolbarProps) {
  const [picking, setPicking] = useState(false);
  const pickerHeadingId = useId();

  return (
    <>
      <div
        role="toolbar"
        aria-label={text.label}
        className="flex h-9 w-full shrink-0 items-center gap-2 border-b border-border bg-background px-2"
        onKeyDown={moveAlongToolbar}
      >
        <LayoutSwitcher {...layouts} />
        <span className="flex-1" />
        <button type="button" data-toolbar-item className={classes.ghostButton} aria-haspopup="dialog" onClick={() => setPicking(true)}>
          <Icon name="plus" />
          <span>{text.addPanel}</span>
        </button>
        <HiddenPanelsList {...hiddenPanels} />
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
