import { Check, Sparkles } from "lucide-react";
import { createContext, useContext, useEffect, useRef, useState } from "react";
import { useTelegramLocale } from "./i18n/index.tsx";

export type AiChoice = { id: string; name: string };
export type AiThread = AiChoice & { projectId: string };
export type AiFile = AiChoice & { chatId: string };
export type AiDestination = { kind: "existing"; thread: AiThread } | { kind: "new"; projectId: string };
export type AiTransferActions = {
  threads: readonly AiThread[];
  chats: readonly AiChoice[];
  findChats(query: string): Promise<readonly AiChoice[]>;
  projects(): Promise<readonly AiChoice[]>;
  prepare(files: readonly AiFile[], chats: readonly AiChoice[], prompt: string): Promise<(destination: AiDestination) => Promise<void>>;
};
export const TelegramAiTransfer = createContext<AiTransferActions | undefined>(undefined);

export function AiTransferButton({ files, iconOnly }: { files: readonly AiFile[]; iconOnly?: boolean }) {
  const actions = useContext(TelegramAiTransfer);
  const { t: tr } = useTelegramLocale();
  const [open, setOpen] = useState(false);
  const [selectedFiles, setSelectedFiles] = useState(files);
  const button = useRef<HTMLButtonElement>(null);
  const label = tr(files.length ? "Send to AI" : "Send chat history to AI");
  if (!actions) return null;
  return <>
    <button ref={button} type="button" className={iconOnly ? "mtg-file-tool" : "mtg-action mtg-ai-transfer-action"}
      aria-label={iconOnly ? label : undefined} title={iconOnly ? label : undefined} onClick={() => {
      setSelectedFiles(files);
      setOpen(true);
    }}><Sparkles size={16} aria-hidden="true" />{!iconOnly && label}</button>
    {open && <AiTransferDialog actions={actions} files={selectedFiles} close={() => {
      setOpen(false);
      button.current?.focus({ preventScroll: true });
    }} />}
  </>;
}

function AiTransferDialog({ actions, files, close }: { actions: AiTransferActions; files: readonly AiFile[]; close: () => void }) {
  const { t: tr } = useTelegramLocale();
  const dialog = useRef<HTMLDialogElement>(null);
  const lock = useRef(false);
  const prepared = useRef<Awaited<ReturnType<AiTransferActions["prepare"]>> | undefined>(undefined);
  const [threadQuery, setThreadQuery] = useState("");
  const [chatQuery, setChatQuery] = useState("");
  const [found, setFound] = useState<readonly AiChoice[]>();
  const [searchError, setSearchError] = useState(false);
  const [threads, setThreads] = useState<AiThread[]>([]);
  const [chats, setChats] = useState<AiChoice[]>([]);
  const [create, setCreate] = useState(false);
  const [projects, setProjects] = useState<readonly AiChoice[]>();
  const [projectId, setProjectId] = useState("");
  const [projectError, setProjectError] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [completed, setCompleted] = useState<string[]>([]);
  useEffect(() => { if (dialog.current && !dialog.current.open) dialog.current.showModal(); }, []);

  const targets: { key: string; destination: AiDestination }[] =
    threads.map((thread) => ({ key: thread.id, destination: { kind: "existing", thread } }));
  if (create && projectId) targets.push({ key: "new", destination: { kind: "new", projectId } });
  const pending = targets.filter(({ key }) => !completed.includes(key));
  const alreadySent = completed.length > 0;
  const visibleThreads = [...new Map([...threads, ...actions.threads].map((thread) => [thread.id, thread])).values()]
    .filter((thread) => threads.some(({ id }) => thread.id === id) || thread.name.toLocaleLowerCase().includes(threadQuery.trim().toLocaleLowerCase()));
  const visibleChats = [...new Map([...chats, ...(found ?? actions.chats)].map((chat) => [chat.id, chat])).values()];

  async function loadProjects() {
    setProjectError(false);
    try {
      const options = await actions.projects();
      setProjects(options);
      if (options.length === 1) setProjectId(options[0]!.id);
    } catch { setProjectError(true); }
  }

  async function findChats() {
    setSearchError(false);
    try { setFound(chatQuery.trim() ? await actions.findChats(chatQuery.trim()) : undefined); }
    catch { setSearchError(true); }
  }

  async function send() {
    if (lock.current || !pending.length || (!files.length && !chats.length) || create && !projectId) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      const delivery = prepared.current ?? await actions.prepare(files, chats, prompt);
      prepared.current = delivery;
      let failures = 0;
      for (const { key, destination } of pending) {
        try {
          await delivery(destination);
          setCompleted((current) => [...current, key]);
        } catch { failures++; }
      }
      if (!alreadySent && failures === pending.length) prepared.current = undefined;
      if (failures) setError(tr("Could not send to {0} selected AI chats.", [failures]));
    } catch { setError(tr("Could not prepare the selected Telegram files or history.")); }
    finally { lock.current = false; setBusy(false); }
  }

  return <dialog ref={dialog} className="mtg-ai-transfer-dialog" aria-label={tr("Send to AI")} onCancel={(event) => {
    event.preventDefault();
    if (!lock.current) close();
  }}>
    <header><h2>{tr("Send to AI")}</h2></header>
    {!!files.length && <details><summary>{tr("Files")} · {files.length}</summary>
      <ul>{files.map((file) => <li key={`${file.chatId}:${file.id}`}><bdi>{file.name}</bdi></li>)}</ul>
    </details>}
    <details open={!files.length || undefined}>
      <summary>{tr("Include Telegram chat history")}{chats.length > 0 && ` · ${chats.length}`}</summary>
      <p>{tr("Up to 20 recent text messages per selected Telegram chat.")}</p>
      <form className="mtg-ai-transfer-search" onSubmit={(event) => { event.preventDefault(); void findChats(); }}>
        <input type="search" aria-label={tr("Search Telegram chats")} value={chatQuery} disabled={busy || alreadySent}
          onChange={(event) => setChatQuery(event.currentTarget.value)} />
        <button className="mtg-action" disabled={busy || alreadySent}>{tr("Find")}</button>
      </form>
      {searchError && <p role="alert">{tr("Could not search Telegram chats.")}</p>}
      <div className="mtg-ai-transfer-choices">
        {visibleChats.map((chat) => <label key={chat.id}><input type="checkbox" disabled={busy || alreadySent}
          checked={chats.some(({ id }) => id === chat.id)} onChange={(event) => {
            setChats(event.currentTarget.checked ? [...chats, chat] : chats.filter(({ id }) => id !== chat.id));
          }} /><bdi>{chat.name}</bdi></label>)}
      </div>
    </details>
    <fieldset disabled={busy}>
      <legend>{tr("AI chats")}</legend>
      <label><input type="checkbox" checked={create} disabled={alreadySent} onChange={(event) => {
        setCreate(event.currentTarget.checked);
        if (event.currentTarget.checked && !projects) void loadProjects();
      }} />{tr("New AI chat")}{completed.includes("new") && <Check size={16} aria-label={tr("Sent")} />}</label>
      {create && <label>{tr("Project")}<select value={projectId} disabled={alreadySent} onChange={(event) => setProjectId(event.currentTarget.value)}>
        <option value="">{tr("Select a project")}</option>
        {projects?.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
      </select></label>}
      {create && projectError && <button type="button" className="mtg-action" onClick={() => void loadProjects()}>{tr("Retry")}</button>}
      <input type="search" aria-label={tr("Search AI chats")} placeholder={tr("Search AI chats")} value={threadQuery}
        onChange={(event) => setThreadQuery(event.currentTarget.value)} />
      <div className="mtg-ai-transfer-choices">
        {visibleThreads.map((thread) => <label key={thread.id}><input type="checkbox" disabled={alreadySent}
          checked={threads.some(({ id }) => id === thread.id)} onChange={(event) => {
            setThreads(event.currentTarget.checked ? [...threads, thread] : threads.filter(({ id }) => id !== thread.id));
          }} /><bdi>{thread.name}</bdi>{completed.includes(thread.id) && <Check size={16} aria-label={tr("Sent")} />}</label>)}
      </div>
    </fieldset>
    <label className="mtg-ai-transfer-copy">{tr("Optional instruction")}<textarea rows={2} maxLength={4000}
      disabled={busy || alreadySent} value={prompt} onChange={(event) => setPrompt(event.currentTarget.value)} /></label>
    {error && <p role="alert">{error}</p>}
    {!!completed.length && <p role="status">{tr("Sent to {0} AI chats.", [completed.length])}</p>}
    <footer><button type="button" className="mtg-action" disabled={busy} onClick={close}>{tr(alreadySent ? "Close" : "Cancel")}</button>
      <button type="button" className="mtg-primary-action" disabled={busy || !pending.length || (!files.length && !chats.length) || create && !projectId}
        onClick={() => void send()}>{tr(busy ? "Sending…" : "Send")}</button></footer>
  </dialog>;
}
