import { useRef, useState, type ReactNode } from "react";
import { useModal } from "../system/dialog.tsx";
import { message } from "./ci-api.ts";

/** Shows what a CI write will do and performs it only on Confirm. */
export function ConfirmDialog({title, lines, onConfirm, onClose, children, disabled = false}: {
  title: string; lines: string[]; onConfirm(): Promise<void>; onClose(done: boolean): void;
  /** Choices that shape the write (an option, the author), shown under the lines. */
  children?: ReactNode;
  /** Confirm stays off until the choices are complete. */
  disabled?: boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  useModal(dialog);
  const confirm = async () => {
    setPending(true);
    setError("");
    try { await onConfirm(); onClose(true); }
    catch (cause) { setError(message(cause)); setPending(false); }
  };
  return <dialog ref={dialog} className="git-ci-dialog" aria-labelledby="git-ci-dialog-title" onCancel={event => { event.preventDefault(); if (!pending) onClose(false); }}>
    <div className="git-stack">
      <h2 id="git-ci-dialog-title">{title}</h2>
      <ul className="git-ci-lines">{lines.map((line, index) => <li key={index}>{line}</li>)}</ul>
      {children}
      {error && <p className="git-error" role="alert">{error}</p>}
      <div className="git-row git-ci-dialog-actions">
        <button type="button" disabled={pending} onClick={() => onClose(false)}>Cancel</button>
        <button type="button" className="git-primary" disabled={pending || disabled} onClick={() => void confirm()}>{pending ? "Working…" : "Confirm"}</button>
      </div>
    </div>
  </dialog>;
}
