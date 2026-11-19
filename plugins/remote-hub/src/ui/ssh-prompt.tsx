// A question OpenSSH asked that the helper must not answer itself: a host key
// confirmation ("yes"/"no") or an informational message. The user's answer is
// handed back once and never stored. Nothing is preselected, Enter on the dialog
// does nothing, "yes" to a host key needs a pointer click or the word typed, and
// Escape cancels (which OpenSSH treats as a refusal).
import { useEffect, useRef, useState } from "react";

export interface SshPromptInfo {
  promptId: number;
  text: string;
  /** "confirm" (yes/no), "secret" (a typed, masked answer, never saved) or "none" (informational). */
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
  const secret = prompt.kind === "secret";
  // Typed here only until it is sent; cleared at once and never stored.
  const [typed, setTyped] = useState("");
  const answer = (value: string | null): void => {
    setTyped("");
    onAnswer(prompt.promptId, value);
  };

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
      <h3 id="rh-ssh-prompt-title">{confirm ? "SSH ждёт решения" : secret ? "SSH ждёт ответа" : "Сообщение SSH"}</h3>
      <p id="rh-ssh-prompt-text" className="rh-ssh-prompt-text" data-testid="ssh-prompt-text">
        {prompt.text}
      </p>
      {confirm && (
        <label className="rh-ssh-prompt-type">
          Или введите yes и нажмите Enter
          <input
            type="text"
            autoComplete="off"
            aria-label="Введите yes, чтобы продолжить"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                e.stopPropagation();
                if (typed.trim().toLowerCase() === "yes") answer("yes");
              }
            }}
          />
        </label>
      )}
      {secret && (
        <input
          type="password"
          autoComplete="off"
          aria-label="Ответ"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              e.stopPropagation();
              answer(typed);
            }
          }}
        />
      )}
      <div className="rh-rdp-cert-actions">
        {secret ? (
          <button type="button" onClick={() => answer(typed)}>
            Отправить
          </button>
        ) : confirm ? (
          <>
            {/* A host-key "yes" needs a deliberate act: a pointer click, or typing yes. Enter or Space on a
                focused button (a click event with no pointer, detail 0) answers nothing. */}
            <button type="button" onClick={(e) => (e.detail > 0 ? answer("yes") : undefined)}>
              Да
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
          Отмена
        </button>
      </div>
    </div>
  );
}
