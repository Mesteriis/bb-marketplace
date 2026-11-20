import { useTelegramLocale } from "./i18n/index.tsx";
import { SquareTerminal } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import type { BotCommand } from "../core/contract.ts";
import { isPlainKey } from "./composer-keys.ts";

export type LoadBotCommands = (chatId: string) => Promise<BotCommand[]>;

function draftWithCommand(draft: string, command: string): string {
  const current = /^\/[a-z0-9_]*(?:@[a-z0-9_]*)?(?=\s|$)/i.exec(draft)?.[0];
  if (current) {
    const args = draft.slice(current.length);
    return command + (args || " ");
  }
  return `${command} ${draft}`;
}

export function BotCommandMenu({ chatId, load, draft, apply, disabled, menu }: {
  chatId: string;
  load: LoadBotCommands;
  draft: string;
  apply: (value: string) => void;
  disabled: boolean;
  menu?: boolean;
}) {
  const { t: tr } = useTelegramLocale();
  const controls = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [commands, setCommands] = useState<BotCommand[] | null>();
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    if (!open) return;
    let current = true;
    setCommands(undefined);
    void load(chatId).then((result) => { if (current) setCommands(result); },
      () => { if (current) setCommands(null); });
    return () => { current = false; };
  }, [chatId, load, open, revision]);

  return <div onKeyDown={(event) => {
    if (!open || !isPlainKey(event, "Escape")) return;
    event.preventDefault();
    setOpen(false);
    trigger.current?.focus();
  }}>
    <button ref={trigger} type="button" aria-label={tr("Bot commands")} title={tr("Bot commands")}
      aria-expanded={open} aria-controls={controls} disabled={disabled} onClick={() => {
        if (!open) setCommands(undefined);
        setOpen(!open);
      }}>{menu ? <><SquareTerminal size={16} aria-hidden="true" />{tr("Bot commands")}</> : "/"}</button>
    <div id={controls} className="mtg-bot-command-menu" role="group" aria-label={tr("Available bot commands")} hidden={!open}>
      {open && (commands === undefined ? <p role="status">{tr("Loading bot commands…")}</p>
        : commands === null ? <>
          <p role="status">{tr("Could not load bot commands.")}</p>
          <button type="button" className="mtg-action" onClick={() => setRevision((value) => value + 1)}>{tr("Retry")}</button>
        </> : commands.length === 0 ? <p role="status">{tr("No bot commands available.")}</p>
        : <ul>{commands.map(({ command, description }) => {
          const value = draftWithCommand(draft, command);
          return <li key={command}><button type="button" className="mtg-action" disabled={disabled || value.length > 4096} onClick={() => {
            apply(value);
            setOpen(false);
          }}>
            <span>{command}</span>
            {description && <small>{description}</small>}
          </button></li>;
        })}</ul>)}
    </div>
  </div>;
}
