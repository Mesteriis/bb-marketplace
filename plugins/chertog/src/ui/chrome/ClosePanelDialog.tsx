// Asked before a close that would end a session, because the panel is the
// session's last view. The three outcomes stay apart: hiding keeps the
// session and is the default, closing ends it and is marked dangerous, and
// cancelling (also Escape and a press outside) changes nothing.
import { useId } from "react";
import { Modal, classes } from "./primitives.tsx";
import { chromeStrings } from "./strings.ts";

const text = chromeStrings.closeDialog;

export interface ClosePanelDialogProps {
  open: boolean;
  panelTitle: string;
  /** The panel is a parent: closing it closes this many linked tiles too. */
  linkedCount?: number;
  onHide: () => void;
  onCloseAndEnd: () => void;
  onCancel: () => void;
}

export function ClosePanelDialog({ open, panelTitle, linkedCount, onHide, onCloseAndEnd, onCancel }: ClosePanelDialogProps) {
  const titleId = useId();
  const textId = useId();
  if (!open) return null;
  return (
    <Modal labelledBy={titleId} describedBy={textId} onDismiss={onCancel}>
      <h2 id={titleId} className="text-sm font-medium">
        {text.title(panelTitle)}
      </h2>
      <p id={textId} className="text-xs text-muted-foreground">
        {text.text}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" data-variant="neutral" className={classes.button} onClick={onCancel}>
          {text.cancel}
        </button>
        <span className="flex-1" />
        <button type="button" data-variant="danger" className={classes.dangerButton} onClick={onCloseAndEnd}>
          {linkedCount ? text.closeBlockAndEnd(linkedCount) : text.closeAndEnd}
        </button>
        <button type="button" data-variant="primary" data-autofocus className={classes.primaryButton} onClick={onHide}>
          {text.hide}
        </button>
      </div>
    </Modal>
  );
}
