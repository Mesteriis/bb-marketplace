// Local data: where Mail keeps what it has, whether the credential key is in
// place, and the two terminal commands that check and copy the database.
import { Button } from "@/components/ui/button";
import { tx } from "../i18n/index.ts";
import { SettingsGroup } from "./primitives.tsx";

const COMMANDS: readonly { command: string; text: string }[] = [
  { command: "bb makosh-mail doctor", text: "Checks every account, the outgoing servers and the database." },
  { command: "bb makosh-mail backup /absolute/path/mail-backup.db", text: "Writes a copy of the database to a new file only you can read." },
];

export function LocalDataSection({ vaultReady, onCopy }: { vaultReady: boolean; onCopy?: (text: string) => void }) {
  return (
    <div className="flex flex-col gap-4">
      <SettingsGroup title={tx("Where it is kept")}>
        <p className="text-sm text-muted-foreground">
          {tx("Mail, drafts, keys and encrypted passwords stay on the computer that runs BB. Nothing is copied to a Makosh server.")}
        </p>
      </SettingsGroup>

      <SettingsGroup title={tx("Credential key")}>
        {vaultReady ? (
          <p className="text-sm text-foreground">{tx("The credential key is set. Passwords and Google grants are encrypted with it.")}</p>
        ) : (
          <p role="alert" className="text-sm text-destructive">
            {tx("The credential key is not set, so saved passwords cannot be read. Set vaultKey in BB's plugin settings.")}
          </p>
        )}
      </SettingsGroup>

      <SettingsGroup title={tx("Checks and copies")}>
        <ul aria-label={tx("Terminal commands")} className="flex flex-col divide-y divide-border rounded-md border border-border">
          {COMMANDS.map(({ command, text }) => (
            <li key={command} className="flex flex-wrap items-center gap-2 px-3 py-2">
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <code className="truncate text-sm text-foreground">{command}</code>
                <span className="text-xs text-muted-foreground">{tx(text)}</span>
              </div>
              {onCopy !== undefined ? (
                <Button variant="outline" size="sm" className="h-7" aria-label={tx("Copy {p1}", { p1: command })} onClick={() => onCopy(command)}>
                  {tx("Copy")}
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
        <p className="text-xs text-muted-foreground">{tx("These commands work only in your own terminal, not inside an agent thread.")}</p>
      </SettingsGroup>
    </div>
  );
}
