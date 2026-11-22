import type { ChooseKind } from "../../core/panels/choose.ts";

const labels: Record<ChooseKind, [string, string]> = {
  "bb-thread": ["Выберите тред для этого тайла.", "Выбрать тред"],
  "bb-file-preview": ["Выберите файл для предпросмотра.", "Выбрать файл"],
  "bb-diff": ["Выберите файл и ревизии для сравнения.", "Выбрать изменения"],
  "bb-terminal": ["Выберите существующий терминал.", "Выбрать терминал"],
  any: ["Выберите, что открыть рядом.", "Выбрать"],
};

export function ChoosePanel({ kind, onChoose }: { kind: ChooseKind; onChoose(kind: ChooseKind): void }) {
  const [hint, action] = labels[kind];
  return <section className="min-h-0 overflow-auto p-4 text-sm text-foreground">
    <p>{hint}</p>
    <button type="button" className="mt-3 rounded-md border border-border px-3 py-1.5 hover:bg-muted focus-visible:outline"
      onClick={() => onChoose(kind)}>{action}</button>
  </section>;
}
