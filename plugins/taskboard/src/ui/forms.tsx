import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import type { BoardView, Column, Connection, ConnectionCreateInput, ConnectionUpdateInput } from "../core/index.ts";
import { messageOf, type Notify } from "./api.ts";

const selectClass =
  "rounded-md border border-input bg-transparent px-2 py-1.5 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

// ---- Task form ----

interface TaskFormProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initial: { title: string; description: string; status: string } | null;
  columns: Column[];
  notify: Notify;
  onSave: (input: { title: string; description: string; status?: string }) => Promise<void>;
}

export function TaskForm({ open, onOpenChange, initial, columns, notify, onSave }: TaskFormProps) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [status, setStatus] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setTitle(initial?.title ?? "");
      setDescription(initial?.description ?? "");
      setStatus(initial?.status ?? columns[0]?.id ?? "");
    }
  }, [open, initial, columns]);

  const submit = async () => {
    setSaving(true);
    try {
      await onSave({ title, description, status: status !== "" ? status : undefined });
      onOpenChange(false);
    } catch (error) {
      notify("error", messageOf(error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{initial === null ? "New task" : "Edit task"}</DialogTitle>
        </DialogHeader>
        <form className="flex flex-col gap-3" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
          <div className="flex flex-col gap-1">
            <label htmlFor="task-title" className="text-sm font-medium">Title</label>
            <Input id="task-title" value={title} onChange={(event) => setTitle(event.target.value)} autoFocus required />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="task-description" className="text-sm font-medium">Description</label>
            <textarea
              id="task-description"
              className="rounded-md border border-input bg-transparent px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              rows={5}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="task-status" className="text-sm font-medium">Status</label>
            <select id="task-status" className={selectClass} value={status} onChange={(event) => setStatus(event.target.value)}>
              {columns.map((column) => (
                <option key={column.id} value={column.id}>{column.name}</option>
              ))}
            </select>
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={saving || title.trim() === ""}>
              {saving ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ---- Connection form ----

function cloudBaseUrlOk(value: string): boolean {
  const v = value.trim();
  if (v === "" || !v.startsWith("https://")) return false;
  try {
    const u = new URL(v);
    if (u.username !== "" || u.password !== "" || u.search !== "" || u.hash !== "") return false;
    const host = u.hostname.toLowerCase();
    return host.endsWith(".atlassian.net") && host !== "atlassian.net" && (u.pathname === "" || u.pathname === "/");
  } catch {
    return false;
  }
}

function serverBaseUrlOk(value: string): boolean {
  const v = value.trim();
  if (v === "" || !v.startsWith("https://")) return false;
  try {
    const u = new URL(v);
    return u.username === "" && u.password === "" && u.search === "" && u.hash === "" && u.hostname.length > 0;
  } catch {
    return false;
  }
}

interface ConnectionFormProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initial: Connection | null;
  notify: Notify;
  onSave: (input: ConnectionCreateInput | ConnectionUpdateInput) => Promise<void>;
}

export function ConnectionForm({ open, onOpenChange, initial, notify, onSave }: ConnectionFormProps) {
  const [name, setName] = useState("");
  const [edition, setEdition] = useState<"cloud" | "server">("cloud");
  const [baseUrl, setBaseUrl] = useState("");
  const [email, setEmail] = useState("");
  const [credential, setCredential] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setName(initial?.name ?? "");
      setEdition(initial?.edition ?? "cloud");
      setBaseUrl(initial?.baseUrl ?? "");
      setEmail(initial?.email ?? "");
      setCredential("");
    }
  }, [open, initial]);

  const baseUrlOk = edition === "cloud" ? cloudBaseUrlOk(baseUrl) : serverBaseUrlOk(baseUrl);
  const emailInvalid = edition === "cloud" && email.trim() === "";
  const credentialMissing = initial === null && credential.trim() === "";

  const submit = async () => {
    setSaving(true);
    try {
      if (initial === null) {
        await onSave({ name, edition, baseUrl, email: edition === "cloud" ? email : undefined, projectKey: "", jql: "", credential });
      } else {
        const patch: ConnectionUpdateInput = { connectionId: initial.id, name, projectKey: "", jql: "" };
        if (edition === "cloud") patch.email = email;
        if (credential.trim() !== "") patch.credential = credential;
        await onSave(patch);
      }
      onOpenChange(false);
    } catch (error) {
      notify("error", messageOf(error));
    } finally {
      setSaving(false);
    }
  };

  const disabled = saving || name.trim() === "" || !baseUrlOk || emailInvalid || credentialMissing;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{initial === null ? "New Jira connection" : "Edit Jira connection"}</DialogTitle>
        </DialogHeader>
        <form className="flex flex-col gap-3" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
          <div className="flex flex-col gap-1">
            <label htmlFor="conn-name" className="text-sm font-medium">Name</label>
            <Input id="conn-name" value={name} onChange={(event) => setName(event.target.value)} autoFocus required />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="conn-edition" className="text-sm font-medium">Edition</label>
            <select id="conn-edition" className={selectClass} value={edition} onChange={(event) => setEdition(event.target.value as "cloud" | "server")} disabled={initial !== null}>
              <option value="cloud">Jira Cloud</option>
              <option value="server">Jira Server / Data Center</option>
            </select>
            {initial !== null && <span className="text-xs text-muted-foreground">Edition cannot be changed after create</span>}
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="conn-url" className="text-sm font-medium">HTTPS URL</label>
            <Input id="conn-url" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder={edition === "cloud" ? "https://example.atlassian.net" : "https://jira.example.com/jira"} disabled={initial !== null} />
            {!baseUrlOk && <span className="text-xs text-destructive">{edition === "cloud" ? "Cloud needs an https://<site>.atlassian.net URL without a path" : "Must be an HTTPS URL"}</span>}
            {initial !== null && baseUrlOk && <span className="text-xs text-muted-foreground">Base URL cannot be changed after create</span>}
          </div>
          {edition === "cloud" && (
            <div className="flex flex-col gap-1">
              <label htmlFor="conn-email" className="text-sm font-medium">Account email</label>
              <Input id="conn-email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} />
              {emailInvalid && <span className="text-xs text-destructive">Email is required for Cloud</span>}
            </div>
          )}
          <p className="text-sm text-muted-foreground">All tasks assigned to you are fetched across Jira projects, then grouped by project.</p>
          <div className="flex flex-col gap-1">
            <label htmlFor="conn-credential" className="text-sm font-medium">
              {edition === "cloud" ? "API token" : "Personal access token"}
            </label>
            <Input
              id="conn-credential"
              type="password"
              value={credential}
              onChange={(event) => setCredential(event.target.value)}
              placeholder={initial === null ? "Required" : "Leave blank to keep the current credential"}
            />
            {credentialMissing && <span className="text-xs text-destructive">Credential is required</span>}
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={disabled}>
              {saving ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ---- Connections manager ----

interface ConnectionsManagerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  connections: Connection[];
  busyConnectionId: string | null;
  onNew: () => void;
  onEdit: (connection: Connection) => void;
  onDelete: (connectionId: string) => void;
  onTest: (connectionId: string) => void;
  onFetch: (connectionId: string) => void;
}

export function ConnectionsManager({ open, onOpenChange, connections, busyConnectionId, onNew, onEdit, onDelete, onTest, onFetch }: ConnectionsManagerProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Jira connections</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-2">
          {connections.length === 0 && <p className="text-sm text-muted-foreground">No connections yet.</p>}
          {connections.map((connection) => (
            <div key={connection.id} className="flex flex-wrap items-center gap-2 rounded-md border border-border px-3 py-2">
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{connection.name}</div>
                <div className="truncate text-xs text-muted-foreground">
                  {connection.edition === "cloud" ? "Jira Cloud" : "Jira Server"} · {connection.baseUrl}
                </div>
              </div>
              <Button variant="outline" size="sm" disabled={busyConnectionId === connection.id} onClick={() => onFetch(connection.id)}>
                {busyConnectionId === connection.id ? "Fetching…" : "Fetch"}
              </Button>
              <Button variant="outline" size="sm" onClick={() => onTest(connection.id)}>Test</Button>
              <Button variant="ghost" size="sm" onClick={() => onEdit(connection)}>Edit</Button>
              <Button variant="ghost" size="sm" onClick={() => onDelete(connection.id)}>Delete</Button>
            </div>
          ))}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onNew}>New connection</Button>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---- Board settings ----

interface BoardSettingsProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  board: BoardView;
  /** Connected / cached-Jira boards keep their columns managed by Jira. */
  readonlyColumns: boolean;
  notify: Notify;
  onSave: (input: { name: string; columns: { id?: string; name: string; order: number }[] }) => Promise<void>;
}

export function BoardSettings({ open, onOpenChange, board, readonlyColumns, notify, onSave }: BoardSettingsProps) {
  const [name, setName] = useState("");
  const [columns, setColumns] = useState<{ id?: string; name: string }[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setName(board.name);
      setColumns(board.columns.map((column) => ({ id: column.id, name: column.name })));
    }
  }, [open, board]);

  const move = (index: number, delta: number) => {
    setColumns((previous) => {
      const next = [...previous];
      const target = index + delta;
      if (target < 0 || target >= next.length) return previous;
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  };

  const submit = async () => {
    setSaving(true);
    try {
      await onSave({ name, columns: columns.map((column, order) => ({ id: column.id, name: column.name, order })) });
      onOpenChange(false);
    } catch (error) {
      notify("error", messageOf(error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Board settings</DialogTitle>
        </DialogHeader>
        <form className="flex flex-col gap-3" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
          <div className="flex flex-col gap-1">
            <label htmlFor="board-name" className="text-sm font-medium">Board name</label>
            <Input id="board-name" value={name} onChange={(event) => setName(event.target.value)} required />
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">Columns</span>
            {readonlyColumns ? (
              <span className="text-xs text-muted-foreground">Columns are managed by Jira; you can reorder them here.</span>
            ) : (
              <span className="text-xs text-muted-foreground">Removing a column moves its tasks to the first remaining column.</span>
            )}
            {columns.map((column, index) => (
              <div key={column.id ?? "new-" + index} className="flex items-center gap-1">
                <Input
                  aria-label={"Column " + (index + 1) + " name"}
                  value={column.name}
                  disabled={readonlyColumns}
                  onChange={(event) => setColumns((previous) => previous.map((entry, i) => (i === index ? { ...entry, name: event.target.value } : entry)))}
                />
                <Button type="button" variant="ghost" size="icon" aria-label="Move column up" disabled={index === 0} onClick={() => move(index, -1)}>↑</Button>
                <Button type="button" variant="ghost" size="icon" aria-label="Move column down" disabled={index === columns.length - 1} onClick={() => move(index, 1)}>↓</Button>
                {!readonlyColumns && (
                  <Button type="button" variant="ghost" size="icon" aria-label="Remove column" disabled={columns.length <= 1} onClick={() => setColumns((previous) => previous.filter((_, i) => i !== index))}>×</Button>
                )}
              </div>
            ))}
            {!readonlyColumns && (
              <Button type="button" variant="outline" size="sm" onClick={() => setColumns((previous) => [...previous, { name: "New column" }])}>Add column</Button>
            )}
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={saving || name.trim() === "" || columns.some((column) => column.name.trim() === "")}>
              {saving ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
