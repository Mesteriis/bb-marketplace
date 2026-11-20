import type { MediaChoice } from "../core/contract.ts";

export function MediaChoiceButtons<Choice extends MediaChoice>({ choices, selectedId, disabled, select }: {
  choices: readonly Choice[];
  selectedId?: number;
  disabled: boolean;
  select: (choice: Choice) => void;
}) {
  return choices.map((choice) => <button key={choice.id} type="button" className="mtg-action" aria-pressed={selectedId === choice.id}
    disabled={disabled} onClick={() => select(choice)}>
    {choice.preview && <img src={`data:${choice.preview.mime};base64,${choice.preview.base64}`} alt="" />}{choice.label}
  </button>);
}
