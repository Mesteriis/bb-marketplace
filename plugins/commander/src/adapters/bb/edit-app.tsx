import { useRpc, type PluginFileOpenerProps } from "@get-bb/plugin-sdk/app";
import { useEffect, useMemo } from "react";
import { EditId, writeBackCommand } from "../../core/edit-session.ts";
import { EDIT_CHUNK, EDIT_LIMIT } from "../../core/edit-source.ts";
import { CommanderError } from "../../core/errors.ts";
import { base64Of, bytesOf } from "../../core/preview.ts";
import { rpcSchemas } from "../../core/wire/rpc.ts";
import { EditBar, type EditBarActions } from "../../ui/edit-bar.tsx";
import { ru } from "../../ui/strings.ts";
import "../../ui/edit-bar.css";

type Rpc = ReturnType<typeof useRpc<typeof rpcSchemas>>;
const waiting = new Map<string, (ready: boolean) => void>();
const loaded = new Set<string>();

export function waitForEdit(sessionId: string, open: () => boolean): Promise<boolean> {
  return new Promise((resolve) => {
    waiting.get(sessionId)?.(false);
    const finish = (ready: boolean) => {
      clearTimeout(timer);
      waiting.delete(sessionId);
      resolve(ready);
    };
    const timer = setTimeout(() => finish(false), 3000);
    waiting.set(sessionId, finish);
    try {
      if (!open()) finish(false);
      else if (loaded.has(sessionId)) finish(true);
    }
    catch { finish(false); }
  });
}

function useEditBar(rpc: Rpc, sessionId: string | undefined, expectedHost: string | undefined): EditBarActions {
  return useMemo(() => {
    const id = () => {
      if (!sessionId) throw new CommanderError("not_found", ru.editFlow.closed);
      return sessionId;
    };
    let pending: { command: string; id: string } | undefined;
    return {
      async load() {
        const info = await rpc.call("edit_get", { sessionId: id() });
        if (expectedHost && info.hostId !== expectedHost) throw new CommanderError("not_found", ru.editFlow.closed);
        const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
        let text = "";
        for (let offset = 0;;) {
          const part = await rpc.call("edit_read", {
            sessionId: id(), revision: info.revision, offset, length: EDIT_CHUNK,
          });
          const bytes = bytesOf(part.bytes);
          text += decoder.decode(bytes, { stream: !part.eof });
          offset += bytes.length;
          if (part.eof) break;
          if (!bytes.length || offset > EDIT_LIMIT) throw new CommanderError("internal", ru.editFlow.closed);
        }
        loaded.add(info.sessionId);
        waiting.get(info.sessionId)?.(true);
        return { ref: info.ref, base: info.base, revision: info.revision, text };
      },
      async save(baseRevision, text) {
        if (!text.isWellFormed()) throw new CommanderError("unsupported", ru.editFlow.compareUnavailable);
        const bytes = new TextEncoder().encode(text);
        if (bytes.length > EDIT_LIMIT) throw new CommanderError("limit_exceeded", ru.editFlow.tooLarge);
        const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
          (byte) => byte.toString(16).padStart(2, "0")).join("");
        for (let offset = 0;; offset += EDIT_CHUNK) {
          const chunk = bytes.subarray(offset, offset + EDIT_CHUNK);
          const final = offset + chunk.length === bytes.length;
          const reply = await rpc.call("edit_save", {
            sessionId: id(), baseRevision, offset, bytes: base64Of(chunk), final, ...(final ? { sha256 } : {}),
          });
          if (final) return reply.revision;
        }
      },
      async writeBack(revision, choice, conflictId) {
        const command = writeBackCommand({ revision, choice, conflictId });
        if (pending?.command !== command) pending = { command, id: crypto.randomUUID() };
        const reply = await rpc.call("edit_writeback", {
          sessionId: id(), clientRequestId: pending.id, revision,
          ...(choice && conflictId ? { choice, conflictId } : {}),
        });
        pending = undefined;
        return reply;
      },
      async dismiss(conflictId) { await rpc.call("edit_dismiss", { sessionId: id(), conflictId }); },
      async compare(ref, { size, mtimeNs }) {
        const result = await rpc.call("file_read", { ref, mode: "text", expect: { size, mtimeNs } });
        if (result.view.kind !== "text") throw new CommanderError("unsupported", ru.editFlow.compareUnavailable);
        return result.view.text + (result.view.truncated ? "\n…" : "");
      },
      async close() { await rpc.call("edit_close", { sessionId: id() }); },
    };
  }, [rpc, sessionId, expectedHost]);
}

export function CommanderEditOpener({ path, source }: PluginFileOpenerProps) {
  const rpc = useRpc<typeof rpcSchemas>();
  const parts = path.split(/[\\/]/u);
  const suffix = parts.at(-1) ?? "";
  const sessionId = source.kind === "host" && parts.at(-3) === "commander-edits" && /^revision-[0-9]+$/.test(suffix)
    ? EditId.safeParse(parts.at(-2)).data : undefined;
  const api = useEditBar(rpc, sessionId, source.experimental_hostId);
  useEffect(() => () => { if (sessionId) loaded.delete(sessionId); }, [sessionId]);
  return <EditBar api={api} key={sessionId} />;
}
