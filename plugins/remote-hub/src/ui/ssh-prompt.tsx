// A question OpenSSH asked that the helper must not answer itself: a host key
// confirmation ("yes"/"no") or an informational message. The user's answer is
// handed back once and never stored. Nothing is preselected, Enter on the dialog
// does nothing, and Escape cancels (which OpenSSH treats as a refusal).
import { useEffect, useRef } from "react";

export interface SshPromptInfo {
  promptId: number;
  text: string;
  /** "confirm" (yes/no) or "none" (informational). */
  kind: string;
}

export interface SshPromptDialogProps {
  prompt: SshPromptInfo;
  /** null = cancelled. */
  onAnswer: (promptId: number, answer: string | null) => void;
}

export function SshPromptDialog(props: SshPromptDialogProps) {
  const { prompt, onAnswer } = props;
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    ref.current?.focus();
  }, [prompt.promptId]);
  const confirm = prompt.kind === "confirm";
  const answer = (value: string | null): void => onAnswer(prompt.promptId, value);

  return (
    <div
      ref={ref}
      className="rh-rdp-cert"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="rh-ssh-prompt-title"
      aria-describedby="rh-ssh-prompt-text"
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          answer(null);
        } else if (event.key === "Enter" && event.target === event.currentTarget) {
          event.preventDefault(); // Enter never answers
        }
      }}
    >
      <h3 id="rh-ssh-prompt-title">{confirm ? "SSH asks for a decision" : "SSH message"}</h3>
      <p id="rh-ssh-prompt-text" className="rh-ssh-prompt-text" data-testid="ssh-prompt-text">
        {prompt.text}
      </p>
      <div className="rh-rdp-cert-actions">
        {confirm ? (
          <>
            <button type="button" onClick={() => answer("yes")}>
              Yes
            </button>
            <button type="button" onClick={() => answer("no")}>
              No
            </button>
          </>
        ) : (
          <button type="button" onClick={() => answer("")}>
            OK
          </button>
        )}
        <button type="button" onClick={() => answer(null)}>
          Cancel
        </button>
      </div>
    </div>
  );
}
