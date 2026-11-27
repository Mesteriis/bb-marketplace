import type { KeyboardEvent } from "react";
import { ru } from "./strings.ts";

export const shortcuts = {
  preview: ["F3"], edit: ["F4"], copy: ["F5", "Meta+c", "Meta+v"], move: ["F6"],
  mkdir: ["F7"], remove: ["F8", "Meta+Backspace"], rename: ["Shift+F6"],
  switchPane: ["Tab"], toggle: ["Insert", "Space"], mark: ["+"], unmark: ["-"], invert: ["*"],
  up: ["Meta+ArrowUp", "Backspace"],
} as const;
export type Shortcut = keyof typeof shortcuts;
export type KeyBindings = Partial<Record<Shortcut, string>>;
export const shortcutText: Record<Shortcut, string> = {
  preview: ru.preview, edit: ru.edit, copy: ru.copy, move: ru.move, mkdir: ru.mkdir, remove: ru.remove,
  rename: ru.rename, switchPane: ru.shortcut, toggle: ru.selection, mark: ru.mark, unmark: ru.unmark, invert: ru.invert, up: ru.up,
};
export function chord(event: KeyboardEvent): string {
  const { key, metaKey, ctrlKey, altKey, shiftKey } = event;
  const shift = shiftKey && !["+", "*"].includes(key);
  return [metaKey && "Meta", ctrlKey && "Ctrl", altKey && "Alt", shift && "Shift",
    key === " " ? "Space" : key.length === 1 ? key.toLowerCase() : key].filter(Boolean).join("+");
}
export function findShortcut(event: KeyboardEvent, bindings: KeyBindings): Shortcut | undefined {
  const pressed = chord(event);
  return (Object.keys(shortcuts) as Shortcut[]).find((action) => bindings[action] === pressed)
    ?? (Object.keys(shortcuts) as Shortcut[]).find((action) => {
      const keys: readonly string[] = shortcuts[action];
      return !bindings[action] && keys.includes(pressed);
    });
}
