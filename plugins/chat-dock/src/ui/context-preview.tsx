// The exact text that will be handed over, where it came from, and a field
// to change it. What this field shows is what gets copied or inserted.
import { useId } from "react";
import { describeSource, type Staging } from "../core/staging.ts";
import { MAX_TEXT_LENGTH } from "../core/transfer.ts";
import { useStaged } from "./use-store.ts";

interface ContextPreviewProps {
  staging: Staging;
  disabled?: boolean;
  rows?: number;
}

export function ContextPreview({ staging, disabled = false, rows = 8 }: ContextPreviewProps) {
  const staged = useStaged(staging);
  const fieldId = useId();
  const noteId = useId();
  const text = staged?.text ?? "";

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={fieldId} className="text-xs font-medium">
        Текст для передачи
      </label>
      <textarea
        id={fieldId}
        aria-describedby={noteId}
        className="w-full resize-y rounded-md border border-input bg-transparent px-2 py-1.5 font-mono text-xs leading-relaxed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
        rows={rows}
        value={text}
        disabled={disabled}
        maxLength={MAX_TEXT_LENGTH}
        spellCheck={false}
        placeholder="Выделите текст в сообщении ассистента и выберите «Вставить в ChatGPT…», либо введите текст здесь."
        onChange={(event) => staging.edit(event.target.value)}
      />
      <p id={noteId} className="text-xs text-muted-foreground">
        {staged === null
          ? "Ничего не подготовлено."
          : "Источник: " + describeSource(staged.source) + ". Знаков: " + String(text.length) + "."}
      </p>
    </div>
  );
}
