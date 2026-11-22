// Asked before a parent tile closes together with its linked tiles. One
// question covers the whole block, including any session a member would end;
// cancelling (also Escape and a press outside) changes nothing.
import { useId } from "react";
import { Modal, classes } from "./primitives.tsx";
import { chromeStrings } from "./strings.ts";

const text = chromeStrings.closeBlockDialog;

export interface CloseBlockDialogProps {
  open: boolean;
  panelTitle: string;
  /** How many linked tiles close with the parent. */
  linkedCount: number;
  onConfirm: () => void;
  onCancel: () => void;
}

export function CloseBlockDialog({ open, panelTitle, linkedCount, onConfirm, onCancel }: CloseBlockDialogProps) {
  const titleId = useId();
  const textId = useId();
  if (!open) return null;
  return (
    <Modal labelledBy={titleId} describedBy={textId} onDismiss={onCancel}>
      <h2 id={titleId} className="text-sm font-medium">
        {text.title(linkedCount)}
      </h2>
      <p id={textId} className="text-xs text-muted-foreground">
        {text.text(panelTitle)}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" data-variant="neutral" data-autofocus className={classes.button} onClick={onCancel}>
          {text.cancel}
        </button>
        <span className="flex-1" />
        <button type="button" data-variant="danger" className={classes.dangerButton} onClick={onConfirm}>
          {text.confirm}
        </button>
      </div>
    </Modal>
  );
}
