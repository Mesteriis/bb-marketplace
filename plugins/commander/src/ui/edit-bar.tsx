import { useEffect, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import type { EditChoice, WriteBackResult } from "../core/edit-session.ts";
import { entryName } from "../core/preview.ts";
import type { Fingerprint, ResourceRef } from "../core/model.ts";
import { Modal } from "./dialogs.tsx";
import { problemOf } from "./model.ts";
import { ru } from "./strings.ts";

const editMessages = new Set<string>([
  ru.editFlow.closed, ru.editFlow.tooLarge, ru.editFlow.editorHostUnavailable, ru.editFlow.nonText,
  ru.editFlow.waitForSave, ru.editFlow.quota, ru.editFlow.remoteChanged, ru.editFlow.revisionChanged, ru.editFlow.previousWrite,
]);

export function editProblem(error: unknown) {
  const fallback = problemOf(error);
  if (!(error instanceof Error)) return fallback;
  let message = error.message.replace(/^HTTP [0-9]+: /, "");
  if (message.startsWith("{")) {
    try { message = JSON.parse(message)?.message; } catch { return fallback; }
  }
  return editMessages.has(message) ? { ...fallback, message } : fallback;
}

type Conflict = Extract<WriteBackResult, { kind: "conflict" }>;
export interface EditBarActions {
  load(): Promise<{ ref: ResourceRef; revision: number; base: Fingerprint; text: string }>;
  save(baseRevision: number, text: string): Promise<number>;
  writeBack(revision: number, choice?: EditChoice, conflictId?: string): Promise<WriteBackResult>;
  compare(conflictId: string): Promise<Conflict | { kind: "text"; text: string }>;
  dismiss(conflictId: string): Promise<void>;
  close(): Promise<void>;
}

export function EditBar({ api }: { api: EditBarActions }) {
  const editorId = useId();
  const [file, setFile] = useState<Awaited<ReturnType<EditBarActions["load"]>>>();
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [closed, setClosed] = useState(false);
  const [conflict, setConflict] = useState<Conflict>();
  const [comparison, setComparison] = useState<{ copy: string; original: string }>();

  function load() {
    return api.load().then((next) => { setFile(next); setText(next.text); return next; });
  }

  useEffect(() => {
    let current = true;
    void api.load().then((next) => {
      if (current) { setFile(next); setText(next.text); }
    }).catch((cause) => { if (current) setError(editProblem(cause).message); });
    return () => { current = false; };
  }, [api]);

  async function run(action: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true);
    setError("");
    try { await action(); }
    catch (cause) { setError(editProblem(cause).message); }
    finally { setBusy(false); }
  }

  async function writeBack(choice?: EditChoice) {
    if (!file) return;
    await run(async () => {
      const result = await api.writeBack(choice ? conflict!.revision : file.revision, choice, choice ? conflict!.conflictId : undefined);
      if (result.kind === "conflict") {
        if (result.revision !== file.revision) await load();
        setComparison(undefined);
        setConflict(result);
      } else {
        setConflict(undefined);
        setComparison(undefined);
        setStatus(ru.editFlow.queued);
      }
    });
  }

  function dismiss() {
    if (!conflict) return;
    void run(async () => {
      await api.dismiss(conflict.conflictId);
      setConflict(undefined);
      setComparison(undefined);
    });
  }

  function versionTime(version: Fingerprint) {
    if (version.mtimeNs === null) return null;
    const date = new Date(Number(BigInt(version.mtimeNs) / 1_000_000n));
    return Number.isNaN(date.getTime()) ? null : date.toLocaleString("ru-RU");
  }

  if (closed) return <p role="status">{ru.editFlow.closed}</p>;
  return <section className="commander cm-edit">
    {file && <>
      <label className="cm-edit-label" htmlFor={editorId}>{entryName(file.ref.path)}</label>
      <textarea id={editorId} value={text} spellCheck={false} disabled={busy} onChange={(event) => setText(event.target.value)} />
      <div className="cm-actions">
        <Button size="sm" disabled={busy || text === file.text} onClick={() => void run(async () => {
          const revision = await api.save(file.revision, text);
          setFile({ ...file, revision, text });
          setStatus(ru.editFlow.saved);
        })}>{ru.editFlow.save}</Button>
        <Button size="sm" variant="outline" disabled={busy || text !== file.text} onClick={() => void writeBack()}>{ru.editFlow.writeBack}</Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void run(async () => {
          await api.close();
          setClosed(true);
        })}>{ru.editFlow.close}</Button>
      </div>
    </>}
    {error && !conflict && <p role="alert">{error}</p>}
    {status && <p role="status">{status}</p>}
    {file && conflict && <Modal title={conflict.reason === "deleted" ? ru.editFlow.deleted : ru.editFlow.changed}
      close={dismiss} busy={busy} description={ru.editFlow.recheck}>
      <div className="cm-pair">
        <div className="cm-detail">
          <strong>{ru.editFlow.copy}</strong>
          <p>{entryName(file.ref.path)} · {new TextEncoder().encode(file.text).length} {ru.bytes}</p>
          {versionTime(file.base) && <p>{ru.editFlow.base} · {versionTime(file.base)}</p>}
          {comparison && <pre>{comparison.copy}</pre>}
        </div>
        <div className="cm-detail">
          <strong>{ru.editFlow.original}</strong>
          <p>{conflict.current ? conflict.current.size + " " + ru.bytes : ru.editFlow.deleted}</p>
          {conflict.current && versionTime(conflict.current) && <p>{versionTime(conflict.current)}</p>}
          {conflict.current?.sha256 && <p>SHA-256 <code>{conflict.current.sha256.slice(0, 8)}…{conflict.current.sha256.slice(-8)}</code></p>}
          {comparison && <pre>{comparison.original}</pre>}
        </div>
      </div>
      {error && <p role="alert">{error}</p>}
      <div className="cm-actions">
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void run(async () => {
          const result = await api.compare(conflict.conflictId);
          if (result.kind === "conflict") {
            if (result.revision !== file.revision) await load();
            setConflict(result);
            setComparison(undefined);
          } else setComparison({ copy: file.text, original: result.text });
        })}>{ru.editFlow.compare}</Button>
        <Button size="sm" variant="destructive" disabled={busy} onClick={() => void writeBack("overwrite")}>{ru.editFlow.overwrite}</Button>
        <Button size="sm" disabled={busy} onClick={() => void writeBack("save-beside")}>{ru.editFlow.beside}</Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={dismiss}>{ru.editFlow.defer}</Button>
      </div>
    </Modal>}
  </section>;
}
