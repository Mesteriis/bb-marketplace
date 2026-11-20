// Mail settings → AI access: assistants outside BB (the local MCP server).
// The switch is read-only here, like the agent switches; the page only saves
// the server file and shows what to put into the assistant's configuration.
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { MCP_SERVER_FILE_NAME } from "../../core/mcp-server-source.ts";
import { tx } from "../i18n/index.ts";
import { SettingsGroup } from "./primitives.tsx";
import { ReadOnlySetting, type PageSettingsPort } from "./setting-controls.tsx";

const TURN_ON = "bb plugin config makosh-mail set mcpAccess true";
const CONFIG = `{
  "mcpServers": {
    "makosh-mail": { "command": "node", "args": ["/path/to/${MCP_SERVER_FILE_NAME}"] }
  }
}`;

export function OutsideAssistants({ port, saveServerFile }: { port: PageSettingsPort; saveServerFile?: () => Promise<boolean> }) {
  const [said, setSaid] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (saveServerFile === undefined || busy) return;
    setBusy(true);
    setSaid(null);
    const ok = await saveServerFile().catch(() => false);
    setBusy(false);
    setSaid(ok ? tx("Saved. Put the file's path into the assistant's configuration below.") : tx("The file could not be saved."));
  };
  return (
    <SettingsGroup title={tx("Assistants outside BB")}>
      <div className="flex flex-col">
        <ReadOnlySetting
          label={tx("Search and read mail through the local MCP server")}
          hint={tx("Only mail inside AI access, with secrets hidden; every call is in Agent activity. It cannot send or change anything.")}
          on={port.values === null ? null : port.values.mcpAccess}
        />
      </div>
      <p className="text-xs text-muted-foreground">
        {tx("Turned on only by you, in BB's plugin settings or with the command: {command}", { command: TURN_ON })}
      </p>
      {saveServerFile !== undefined ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" className="h-7" disabled={busy} onClick={() => void save()}>
            {tx("Save the server file…")}
          </Button>
          <span role="status" className="text-xs text-muted-foreground">
            {said ?? ""}
          </span>
        </div>
      ) : null}
      <p className="text-xs text-muted-foreground">
        {tx("The assistant's configuration (Claude Desktop, Cursor and others); Node.js and the bb command must be available to it:")}
      </p>
      <pre className="overflow-x-auto rounded-md border border-border bg-muted/40 p-2 text-xs text-foreground">{CONFIG}</pre>
    </SettingsGroup>
  );
}
