import { useTelegramLocale } from "./i18n/index.tsx";
import { useLayoutEffect, useRef } from "react";

const groups = [
  { title: "Navigation", shortcuts: [
    ["Search in the current view", ["⌘/Ctrl+F"]],
    ["Previous or next chat", ["Alt+↑/↓", "⌘/Ctrl+Page Up/Down"]],
    ["Previous or next folder", ["⌘/Ctrl+Shift+↑/↓"]],
    ["Move within the folder tree or expand and collapse a branch", ["↑/↓", "←/→", "Home/End"]],
    ["First or last chat in the current list", ["⌘/Ctrl+Alt+Home/End"]],
    ["Open a pinned chat by position", ["Ctrl+1–8"]],
    ["Saved Messages", ["Ctrl+0"]],
    ["Archive", ["Ctrl+9"]],
    ["Contacts", ["Ctrl+J"]],
    ["Preview a chat", ["Ctrl+]"]],
    ["Chat details", ["Ctrl+\\", "Alt+Shift+I"]],
  ] },
  { title: "Messages and drafts", shortcuts: [
    ["Send from the text composer", ["Enter"]],
    ["Insert a new line", ["Shift+Enter"]],
    ["Send a new formatted message or save an edit", ["⌘/Ctrl+Enter"]],
    ["Choose a message to reply to", ["Ctrl+↑/↓"]],
    ["Edit your latest message from an empty composer", ["↑"]],
    ["Set aside or exchange a draft", ["Ctrl+S"]],
    ["Apply the selected quote", ["⌘/Ctrl+Enter"]],
    ["Close the current search, editor or reply", ["Esc"]],
  ] },
  { title: "Text formatting", shortcuts: [
    ["Bold, italic or underline", ["⌘/Ctrl+B/I/U"]],
    ["Monospace", ["⌘/Ctrl+Shift+M"]],
    ["Clear formatting", ["⌘/Ctrl+Shift+N"]],
    ["Format a selection as a quote in the text composer", ["⌘/Ctrl+Shift+."]],
    ["Add or edit a link", ["⌘/Ctrl+K"]],
  ] },
  { title: "Media", shortcuts: [
    ["Previous or next photo in the viewer", ["←/→"]],
    ["Save an eligible photo from the viewer", ["⌘/Ctrl+S"]],
    ["Save a downloadable file from its focused player", ["⌘/Ctrl+S"]],
    ["Play or pause focused media", ["Space"]],
    ["Seek five seconds in focused media", ["←/→"]],
    ["Seek back, pause or seek forward in focused video", ["J", "K", "L"]],
    ["Temporarily play focused video at 2×", ["Hold Space"]],
    ["Step backward or forward in paused video", [",", "."]],
    ["Toggle fullscreen for a focused video", ["⌘/Ctrl/Alt+Enter"]],
    ["Seek to 0–90% in fullscreen video", ["0–9"]],
    ["Close the focused player outside fullscreen", ["Esc"]],
    ["Go to the previous or next chapter, when available", ["Alt+←/→"]],
  ] },
] as const;

export function KeyboardShortcutList() {
  const { t: tr } = useTelegramLocale();
  return <div className="mtg-shortcut-list">
    {groups.map(({ title, shortcuts }) => <section key={title} aria-label={tr(title)}>
      <h3>{tr(title)}</h3>
      <dl>{shortcuts.map(([action, keys]) => <div key={action}>
        <dt>{tr(action)}</dt>
        <dd>{keys.map((key) => <kbd key={key}>{tr(key)}</kbd>)}</dd>
      </div>)}</dl>
    </section>)}
  </div>;
}

export function KeyboardShortcutsDialog({ close }: { close: () => void }) {
  const { t: tr } = useTelegramLocale();
  const dialog = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => { dialog.current?.showModal(); }, []);
  return <dialog ref={dialog} className="mtg-agent-settings mtg-shortcut-dialog" aria-label={tr("Keyboard shortcuts")} onClose={close}>
    <header>
      <h2>{tr("Keyboard shortcuts")}</h2>
      <button autoFocus type="button" className="mtg-action" onClick={() => dialog.current?.close()}>{tr("Close shortcuts")}</button>
    </header>
    <KeyboardShortcutList />
  </dialog>;
}
