// AI access (slice 3f): what agents and AI features may read. Per account
// all folders, chosen folders or none; Spam and Trash never. Senders and
// domains listed under "Never share mail from" are out over their whole
// correspondence, mail the owner sent them included. Saved on Save; the
// agent paths follow at once.
import { useEffect, useState, type FormEvent } from "react";
import type { AiScopeInput } from "../core/contract.ts";
import type { Account, AiScopeView, Folder } from "../core/model.ts";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { accountLabel } from "./folder-list.tsx";
import { tx } from "./i18n/index.ts";

type Mode = AiScopeView["accounts"][number]["mode"];
type Sender = AiScopeView["senders"][number];

export const SPAM_TRASH_LINE = "Spam and Trash are never shared, whatever you choose here.";
export const GMAIL_SCOPE_NOTE = "Gmail: a message is shared when any of its labels or All Mail is chosen.";
export const AI_SCOPE_SENDERS_MAX = 1_000;

const MODES: readonly { value: Mode; label: string }[] = [
  { value: "all", label: "All folders" },
  { value: "folders", label: "Chosen folders\u2026" },
  { value: "none", label: "None" },
];

/** A typed sender as a rule: an address with "@", else a domain. */
export function senderOf(text: string): Sender | null {
  const value = text.trim().toLowerCase();
  if (value === "" || /\s/.test(value)) return null;
  if (value.includes("@")) return /^[^@]+@[^@]+\.[^@]+$/.test(value) ? { kind: "address", value } : null;
  const domain = value.replace(/^\*?\.?/, "");
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain) ? { kind: "domain", value: domain } : null;
}

type AccountDraft = { accountId: string; mode: Mode; chosen: string[]; stale: string[] };

function draftOf(accounts: readonly Account[], view: AiScopeView): AccountDraft[] {
  return accounts.map((account) => {
    const entry = view.accounts.find((a) => a.accountId === account.id);
    return {
      accountId: account.id,
      mode: entry?.mode ?? "all",
      chosen: (entry?.folders ?? []).map((f) => f.path),
      stale: (entry?.folders ?? []).filter((f) => !f.found).map((f) => f.path),
    };
  });
}

/** What Save sends. */
export function scopeInput(drafts: readonly AccountDraft[], senders: readonly Sender[]): AiScopeInput {
  return {
    accounts: drafts.map((d) => ({ accountId: d.accountId, mode: d.mode, ...(d.mode === "folders" ? { folders: d.chosen } : {}) })),
    senders: senders.map((s) => ({ kind: s.kind, value: s.value })),
  };
}

export interface AiAccessSettingsProps {
  accounts: readonly Account[];
  load: () => Promise<AiScopeView>;
  save: (input: AiScopeInput) => Promise<AiScopeView>;
  /** An account's folders for the picker. */
  folders: (accountId: string) => Promise<readonly Folder[]>;
}

function FolderPicker({
  draft,
  folders,
  onChange,
}: {
  draft: AccountDraft;
  folders: (accountId: string) => Promise<readonly Folder[]>;
  onChange: (chosen: string[]) => void;
}) {
  const [list, setList] = useState<readonly Folder[] | null>(null);
  useEffect(() => {
    let live = true;
    folders(draft.accountId).then(
      (found) => {
        if (live) setList(found);
      },
      () => {
        if (live) setList([]);
      },
    );
    return () => {
      live = false;
    };
  }, [draft.accountId, folders]);
  if (list === null) return <p className="text-xs text-muted-foreground">{tx("Loading folders\u2026")}</p>;
  const shown = list.filter((f) => f.selectable && f.specialUse !== "junk" && f.specialUse !== "trash");
  return (
    <div className="flex flex-col gap-1 pl-1">
      <ul aria-label={tx("Folders shared with AI")} className="flex max-h-48 flex-col gap-1 overflow-y-auto">
        {shown.map((folder) => (
          <li key={folder.path}>
            <label className="flex items-center gap-2 text-sm text-foreground">
              <Checkbox
                checked={draft.chosen.includes(folder.path)}
                onCheckedChange={(checked) =>
                  onChange(checked === true ? [...draft.chosen, folder.path] : draft.chosen.filter((p) => p !== folder.path))
                }
              />
              {folder.name}
            </label>
          </li>
        ))}
      </ul>
      {draft.stale.map((path) => (
        <p key={path} className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="truncate">{path}</span>
          <span className="text-destructive">{tx("not found")}</span>
          <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={() => onChange(draft.chosen.filter((p) => p !== path))}>
            {tx("Remove")}
          </Button>
        </p>
      ))}
    </div>
  );
}

export function AiAccessSettings({ accounts, load, save, folders }: AiAccessSettingsProps) {
  const [drafts, setDrafts] = useState<AccountDraft[] | null>(null);
  const [senders, setSenders] = useState<Sender[]>([]);
  const [typed, setTyped] = useState("");
  const [state, setState] = useState<{ kind: "idle" | "saving" | "saved" } | { kind: "error"; text: string }>({ kind: "idle" });
  useEffect(() => {
    let live = true;
    load().then(
      (view) => {
        if (!live) return;
        setDrafts(draftOf(accounts, view));
        setSenders(view.senders);
      },
      (error: unknown) => {
        if (live) setState({ kind: "error", text: error instanceof Error ? error.message : "AI access could not be loaded" });
      },
    );
    return () => {
      live = false;
    };
    // Loaded once per opening; accounts come with it.
  }, [load]);

  if (drafts === null) {
    return state.kind === "error" ? (
      <p role="alert" className="text-sm text-destructive">
        {state.text}
      </p>
    ) : (
      <p className="text-sm text-muted-foreground">{tx("Loading\u2026")}</p>
    );
  }
  const patch = (accountId: string, change: Partial<AccountDraft>) => {
    setDrafts((prev) => prev?.map((d) => (d.accountId === accountId ? { ...d, ...change } : d)) ?? null);
    setState({ kind: "idle" });
  };
  const candidate = senderOf(typed);
  const addSender = (event: FormEvent) => {
    event.preventDefault();
    if (candidate === null || senders.length >= AI_SCOPE_SENDERS_MAX) return;
    if (!senders.some((s) => s.kind === candidate.kind && s.value === candidate.value)) setSenders([...senders, candidate]);
    setTyped("");
    setState({ kind: "idle" });
  };
  const submit = async () => {
    setState({ kind: "saving" });
    try {
      const view = await save(scopeInput(drafts, senders));
      setDrafts(draftOf(accounts, view));
      setSenders(view.senders);
      setState({ kind: "saved" });
    } catch (error) {
      setState({ kind: "error", text: error instanceof Error && error.message !== "" ? error.message : "AI access could not be saved" });
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        {tx("What agents in BB threads and the AI features (summaries, Ask, tasks, categories, Today, Improve, translation) may read. Mail outside it does not exist for them.")}
      </p>
      <p className="text-xs text-muted-foreground">{SPAM_TRASH_LINE}</p>
      {accounts.map((account) => {
        const draft = drafts.find((d) => d.accountId === account.id);
        if (draft === undefined) return null;
        return (
          <section key={account.id} aria-label={accountLabel(account)} className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <h4 className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{accountLabel(account)}</h4>
              <Select value={draft.mode} onValueChange={(mode) => patch(account.id, { mode: mode as Mode })}>
                <SelectTrigger aria-label={`AI access for ${accountLabel(account)}`} className="h-8 w-auto">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {MODES.map((m) => (
                    <SelectItem key={m.value} value={m.value}>
                      {m.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {draft.mode === "folders" ? (
              <FolderPicker draft={draft} folders={folders} onChange={(chosen) => patch(account.id, { chosen, stale: draft.stale.filter((p) => chosen.includes(p)) })} />
            ) : null}
            {account.preset === "gmail" ? <p className="text-xs text-muted-foreground">{GMAIL_SCOPE_NOTE}</p> : null}
          </section>
        );
      })}
      <section aria-label={tx("Never share mail from")} className="flex flex-col gap-2">
        <h4 className="text-sm font-medium text-foreground">{tx("Never share mail from")}</h4>
        <p className="text-xs text-muted-foreground">
          {tx("Addresses and domains, including mail you sent them and whole conversations with them.")}
        </p>
        {senders.length > 0 ? (
          <ul className="flex flex-col gap-1">
            {senders.map((sender) => (
              <li key={`${sender.kind}:${sender.value}`} className="flex items-center gap-2 text-sm">
                <span className="min-w-0 flex-1 truncate text-foreground">{sender.value}</span>
                <span className="text-xs text-muted-foreground">{sender.kind === "domain" ? "domain" : "address"}</span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 px-2 text-xs"
                  onClick={() => {
                    setSenders(senders.filter((s) => s !== sender));
                    setState({ kind: "idle" });
                  }}
                >
                  {tx("Remove")}
                </Button>
              </li>
            ))}
          </ul>
        ) : null}
        <form onSubmit={addSender} className="flex items-center gap-2">
          <Input
            aria-label={tx("Address or domain")}
            placeholder={tx("name@example.com or example.com")}
            value={typed}
            maxLength={320}
            onChange={(event) => setTyped(event.target.value)}
            className="h-8 flex-1"
          />
          <Button type="submit" variant="outline" size="sm" disabled={candidate === null || senders.length >= AI_SCOPE_SENDERS_MAX}>
            {tx("Add")}
          </Button>
        </form>
        {senders.length >= AI_SCOPE_SENDERS_MAX ? (
          <p className="text-xs text-muted-foreground">{tx("This list is full; remove some first.")}</p>
        ) : null}
      </section>
      <div className="flex items-center gap-2">
        <Button size="sm" disabled={state.kind === "saving"} onClick={() => void submit()}>
          {tx("Save")}
        </Button>
        {state.kind === "saved" ? <span className="text-xs text-muted-foreground">{tx("Saved")}</span> : null}
        {state.kind === "error" ? (
          <span role="alert" className="text-xs text-destructive">
            {state.text}
          </span>
        ) : null}
      </div>
    </div>
  );
}
