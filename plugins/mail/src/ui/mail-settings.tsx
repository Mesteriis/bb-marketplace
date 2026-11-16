// Mail settings (slice 3d), opened from the gear in the mail rail: per
// account the sending addresses (the own address first, then aliases with
// their name, signature and send state), Add address, the suggestions the
// server found in inbound mail, and a link to the account's SMTP dialog;
// and the templates. Nothing is added by itself: a suggestion only fills
// Add address. Every call is a host port; the texts it rejects with are the
// server's fixed refusals, shown where they happened. Slice 3e adds the
// Inbox tab: Blocked senders (Unblock asks first) and each account's
// Snoozed folder with Change…. Slice 3f adds AI access, Agent activity
// and AI features (categories, Today, reply reminders, AI settings).
import { useEffect, useId, useState, type FormEvent, type ReactNode } from "react";
import type { Editor } from "@tiptap/react";
import type { Account, BlockRuleView, CategoryRuleView, IdentityView } from "../core/model.ts";
import { AiAccessSettings, type AiAccessSettingsProps } from "./ai-access-settings.tsx";
import { AgentActivity, type AgentActivityProps } from "./agent-activity.tsx";
import { categoryLabel } from "./category-chips.tsx";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { ComposeEditor, type EditorDoc } from "./compose-editor.tsx";
import { ComposeToolbar, type ToolId } from "./compose-toolbar.tsx";
import { accountLabel } from "./folder-list.tsx";
import { editorDocEmpty, SignatureEditor } from "./signature-editor.tsx";
import { stopEscape } from "./shortcuts.ts";

export type TemplateView = { id: string; name: string; doc: EditorDoc; updatedAt: string };
export type SuggestionView = { address: string; count: number; lastDate: string };
export type IdentityKey = { accountId: string; address: string };
export type SettingsSection = "addresses" | "templates" | "inbox" | "ai_access" | "activity" | "ai";

/** Mail settings' AI tabs (slice 3f). */
export interface SettingsAiPorts {
  scope: Omit<AiAccessSettingsProps, "accounts">;
  activity: AgentActivityProps;
  /** The plugin settings as BB has them now. */
  categoriesOn: boolean;
  morningDigest: boolean;
  digestTime: string;
  reminderDays: number;
  loadRules: () => Promise<CategoryRuleView[]>;
  removeRule: (id: string) => Promise<void>;
  /** AI settings: provider, model and translation (the former Translation settings). */
  onOpenAiSettings: () => void;
}

/** Where the switches of plugin settings live: BB's own settings page. */
export const PLUGIN_SETTINGS_HINT = "Change it in BB Settings \u2192 Plugins \u2192 Makosh Mail.";

/** The template editor's tools: everything but the quote (templates cannot hold quotes). */
export const TEMPLATE_TOOLS: readonly ToolId[] = [
  "bold",
  "italic",
  "underline",
  "bulletList",
  "orderedList",
  "link",
  "clear",
];

export interface MailSettingsProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The section shown when the dialog opens. */
  section?: SettingsSection;
  accounts: readonly Account[];
  /** Every account's identities (identities_list with accountId null). */
  identities: readonly IdentityView[];
  templates: readonly TemplateView[];
  suggestions: (accountId: string) => Promise<SuggestionView[]>;
  onAdd: (input: IdentityKey & { displayName?: string }) => Promise<void>;
  onUpdate: (input: IdentityKey & { displayName?: string | null; signature?: EditorDoc | null }) => Promise<void>;
  onRemove: (input: IdentityKey) => Promise<void>;
  onDismiss: (input: IdentityKey) => Promise<void>;
  onSaveTemplate: (input: { id?: string; name: string; doc: EditorDoc }) => Promise<void>;
  onDeleteTemplate: (id: string) => Promise<void>;
  onOpenSmtp: (accountId: string) => void;
  /** Blocked senders (slice 3e); null while they load. Absent: no Inbox tab. */
  blockRules?: readonly BlockRuleView[] | null;
  onUnblock?: (id: string) => Promise<void>;
  /** Change… (or set up) an account's snooze folder. */
  onChangeSnoozeFolder?: (accountId: string) => void;
  /** AI access, Agent activity and AI features (slice 3f); absent: none of those tabs. */
  ai?: SettingsAiPorts;
}

function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

/** A document as plain lines (hard breaks end a line), for previews. */
export function docPreview(doc: EditorDoc | null): string {
  if (doc === null) return "";
  const lines: string[] = [];
  let line = "";
  const walk = (node: EditorDoc) => {
    if (node.type === "text") line += node.text ?? "";
    else if (node.type === "hardBreak") {
      lines.push(line);
      line = "";
    }
    for (const child of node.content ?? []) walk(child);
    if (node.type === "paragraph") {
      lines.push(line);
      line = "";
    }
  };
  walk(doc);
  if (line !== "") lines.push(line);
  return lines.map((l) => l.trim()).filter((l) => l !== "").join("\n");
}

/** What the owner sees about an address's sends; null when there is nothing to warn about. */
export function sendCheckText(check: IdentityView["sendCheck"]): string | null {
  if (check === "rewritten") {
    return "The last message from this address went out from the account's own address: the provider does not let this account send as it.";
  }
  if (check === "refused") {
    return "The server refused to send from this address. Set it up with your provider, or remove it.";
  }
  return null;
}

function formatDay(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

export function MailSettings(props: MailSettingsProps) {
  const { open, onOpenChange, accounts } = props;
  const [section, setSection] = useState<SettingsSection>(props.section ?? "addresses");
  const [accountId, setAccountId] = useState<string | null>(accounts[0]?.id ?? null);

  useEffect(() => {
    if (open) setSection(props.section ?? "addresses");
  }, [open, props.section]);
  useEffect(() => {
    if (accountId === null || !accounts.some((a) => a.id === accountId)) setAccountId(accounts[0]?.id ?? null);
  }, [accountId, accounts]);

  const account = accounts.find((a) => a.id === accountId) ?? null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] max-w-2xl flex-col gap-3" onEscapeKeyDown={stopEscape}>
        <DialogHeader>
          <DialogTitle>Mail settings</DialogTitle>
          <DialogDescription>
            Sending addresses, signatures and templates. They are kept on this computer.
          </DialogDescription>
        </DialogHeader>
        <div role="tablist" aria-label="Settings" className="flex shrink-0 gap-1 border-b border-border">
          {(
            [
              ["addresses", "Sending addresses"],
              ["templates", "Templates"],
              ...(props.onUnblock !== undefined ? ([["inbox", "Inbox"]] as const) : []),
              ...(props.ai !== undefined
                ? ([
                    ["ai_access", "AI access"],
                    ["activity", "Agent activity"],
                    ["ai", "AI features"],
                  ] as const)
                : []),
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={section === id}
              onClick={() => setSection(id)}
              className={cn(
                "-mb-px border-b-2 px-2 py-1.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                section === id
                  ? "border-primary font-medium text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              {label}
            </button>
          ))}
        </div>
        <div role="tabpanel" className="min-h-0 flex-1 overflow-y-auto pr-1">
          {section === "addresses" ? (
            account === null ? (
              <p className="text-sm text-muted-foreground">No mail account yet.</p>
            ) : (
              <AddressesSection
                key={account.id}
                {...props}
                account={account}
                onSelectAccount={setAccountId}
              />
            )
          ) : section === "ai_access" && props.ai !== undefined ? (
            <AiAccessSettings accounts={accounts} {...props.ai.scope} />
          ) : section === "activity" && props.ai !== undefined ? (
            <AgentActivity {...props.ai.activity} />
          ) : section === "ai" && props.ai !== undefined ? (
            <AiFeaturesSection ai={props.ai} />
          ) : section === "inbox" && props.onUnblock !== undefined ? (
            <InboxSection
              accounts={accounts}
              rules={props.blockRules ?? null}
              onUnblock={props.onUnblock}
              onChangeSnoozeFolder={props.onChangeSnoozeFolder}
            />
          ) : (
            <TemplatesSection
              templates={props.templates}
              onSave={props.onSaveTemplate}
              onDelete={props.onDeleteTemplate}
            />
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function SectionHeading({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex items-center gap-2 pb-1 pt-2">
      <h3 className="min-w-0 flex-1 text-sm font-semibold text-foreground">{children}</h3>
      {action}
    </div>
  );
}

function AddressesSection(
  props: MailSettingsProps & { account: Account; onSelectAccount: (accountId: string) => void },
) {
  const { account, accounts } = props;
  const id = useId();
  const own = props.identities
    .filter((identity) => identity.accountId === account.id)
    .sort((a, b) => Number(b.primary) - Number(a.primary));
  const [address, setAddress] = useState("");
  const [name, setName] = useState("");
  const [adding, setAdding] = useState(false);
  const [addProblem, setAddProblem] = useState<string | null>(null);
  const [suggested, setSuggested] = useState<SuggestionView[] | "loading" | "error">("loading");

  useEffect(() => {
    let live = true;
    setSuggested("loading");
    props.suggestions(account.id).then(
      (rows) => {
        if (live) setSuggested(rows);
      },
      () => {
        if (live) setSuggested("error");
      },
    );
    return () => {
      live = false;
    };
    // One load per account shown.
  }, [account.id]);

  const add = async (event: FormEvent) => {
    event.preventDefault();
    const typed = address.trim();
    if (typed === "") return;
    setAdding(true);
    setAddProblem(null);
    try {
      await props.onAdd({
        accountId: account.id,
        address: typed,
        ...(name.trim() !== "" ? { displayName: name.trim() } : {}),
      });
      setAddress("");
      setName("");
      setSuggested((prev) =>
        Array.isArray(prev) ? prev.filter((s) => s.address.toLowerCase() !== typed.toLowerCase()) : prev,
      );
    } catch (error) {
      setAddProblem(messageOf(error, "Could not add the address."));
    } finally {
      setAdding(false);
    }
  };

  const dismiss = async (suggestion: SuggestionView) => {
    try {
      await props.onDismiss({ accountId: account.id, address: suggestion.address });
      setSuggested((prev) => (Array.isArray(prev) ? prev.filter((s) => s.address !== suggestion.address) : prev));
    } catch (error) {
      setAddProblem(messageOf(error, "Could not dismiss the suggestion."));
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        {accounts.length > 1 ? (
          <Select value={account.id} onValueChange={props.onSelectAccount}>
            <SelectTrigger aria-label="Account" className="h-8 w-auto max-w-72">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {accounts.map((item) => (
                <SelectItem key={item.id} value={item.id}>
                  {accountLabel(item)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <span className="truncate text-sm font-medium text-foreground">{accountLabel(account)}</span>
        )}
        <span className="flex-1" />
        <Button variant="link" size="sm" className="h-7 px-1" onClick={() => props.onOpenSmtp(account.id)}>
          SMTP settings…
        </Button>
      </div>

      <ul aria-label="Sending addresses" className="flex flex-col divide-y divide-border rounded-md border border-border">
        {own.map((identity) => (
          <IdentityRow key={identity.address} identity={identity} {...props} />
        ))}
      </ul>

      <SectionHeading>Add address</SectionHeading>
      <form onSubmit={(event) => void add(event)} className="flex flex-wrap items-end gap-2" aria-label="Add address">
        <div className="flex min-w-48 flex-1 flex-col gap-1">
          <label htmlFor={`${id}-address`} className="text-xs text-muted-foreground">
            Address
          </label>
          <Input
            id={`${id}-address`}
            type="email"
            autoComplete="off"
            value={address}
            maxLength={320}
            onChange={(event) => {
              setAddress(event.target.value);
              setAddProblem(null);
            }}
            className="h-8"
          />
        </div>
        <div className="flex min-w-40 flex-1 flex-col gap-1">
          <label htmlFor={`${id}-name`} className="text-xs text-muted-foreground">
            Name (optional)
          </label>
          <Input
            id={`${id}-name`}
            autoComplete="off"
            value={name}
            maxLength={200}
            onChange={(event) => setName(event.target.value)}
            className="h-8"
          />
        </div>
        <Button type="submit" size="sm" disabled={adding || address.trim() === ""}>
          Add address
        </Button>
        {addProblem !== null ? (
          <p role="alert" className="w-full text-xs text-destructive">
            {addProblem}
          </p>
        ) : null}
      </form>
      <p className="text-xs text-muted-foreground">
        The plugin cannot check that the provider lets this account send from an address; after the first send
        it says so here.
      </p>

      <SectionHeading>Suggestions</SectionHeading>
      {suggested === "loading" ? <p className="text-xs text-muted-foreground">Looking for suggestions…</p> : null}
      {suggested === "error" ? <p className="text-xs text-muted-foreground">Could not load suggestions.</p> : null}
      {Array.isArray(suggested) && suggested.length === 0 ? (
        <p className="text-xs text-muted-foreground">No suggestions.</p>
      ) : null}
      {Array.isArray(suggested) && suggested.length > 0 ? (
        <ul aria-label="Suggestions" className="flex flex-col divide-y divide-border rounded-md border border-border">
          {suggested.map((suggestion) => (
            <li key={suggestion.address} className="flex flex-wrap items-center gap-2 px-3 py-2">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm text-foreground">{suggestion.address}</p>
                <p className="text-xs text-muted-foreground">
                  {suggestion.count === 1 ? "1 message" : `${suggestion.count} messages`} · last{" "}
                  {formatDay(suggestion.lastDate)}
                </p>
              </div>
              <Button
                variant="outline"
                size="sm"
                className="h-7"
                aria-label={`Add ${suggestion.address}`}
                onClick={() => {
                  setAddress(suggestion.address);
                  setAddProblem(null);
                  document.getElementById(`${id}-name`)?.focus();
                }}
              >
                Add
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-7"
                aria-label={`${suggestion.address} is not mine`}
                onClick={() => void dismiss(suggestion)}
              >
                Not mine
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function IdentityRow({ identity, onUpdate, onRemove }: { identity: IdentityView } & MailSettingsProps) {
  const id = useId();
  const key = { accountId: identity.accountId, address: identity.address };
  const [mode, setMode] = useState<"view" | "rename" | "signature" | "remove">("view");
  const [name, setName] = useState(identity.displayName ?? "");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const warning = sendCheckText(identity.sendCheck);
  const signature = docPreview((identity.signature as EditorDoc | null) ?? null);

  const run = async (work: () => Promise<void>, fallback: string) => {
    setBusy(true);
    setProblem(null);
    try {
      await work();
      setMode("view");
    } catch (error) {
      setProblem(messageOf(error, fallback));
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="flex flex-col gap-1.5 px-3 py-2" aria-label={identity.address}>
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm text-foreground">
            {identity.displayName !== null && identity.displayName !== "" ? (
              <>
                {identity.displayName} <span className="text-muted-foreground">&lt;{identity.address}&gt;</span>
              </>
            ) : (
              identity.address
            )}
          </p>
        </div>
        <span className="shrink-0 rounded-sm bg-secondary px-1.5 py-0.5 text-xs text-secondary-foreground">
          {identity.primary ? "Own address" : "Alias"}
        </span>
      </div>
      {warning !== null ? (
        <p role="status" className="flex items-start gap-1 text-xs text-destructive">
          <Icon name="TriangleAlert" fallback="CircleAlert" className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          {warning}
        </p>
      ) : null}
      {mode !== "signature" ? (
        <p className={cn("whitespace-pre-line text-xs", signature === "" ? "text-muted-foreground" : "text-foreground")}>
          {signature === "" ? "No signature" : signature}
        </p>
      ) : null}

      {mode === "view" ? (
        <div className="flex flex-wrap gap-1">
          <Button variant="outline" size="sm" className="h-7" onClick={() => setMode("signature")}>
            {signature === "" ? "Add signature" : "Edit signature"}
          </Button>
          {!identity.primary ? (
            <>
              <Button
                variant="ghost"
                size="sm"
                className="h-7"
                onClick={() => {
                  setName(identity.displayName ?? "");
                  setMode("rename");
                }}
              >
                Rename
              </Button>
              <Button variant="ghost" size="sm" className="h-7" onClick={() => setMode("remove")}>
                Remove
              </Button>
            </>
          ) : null}
        </div>
      ) : null}

      {mode === "rename" ? (
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void run(
              () => onUpdate({ ...key, displayName: name.trim() === "" ? null : name.trim() }),
              "Could not rename the address.",
            );
          }}
        >
          <label htmlFor={`${id}-rename`} className="sr-only">
            Name for {identity.address}
          </label>
          <Input
            id={`${id}-rename`}
            autoFocus
            value={name}
            maxLength={200}
            onChange={(event) => setName(event.target.value)}
            className="h-7 min-w-40 flex-1 text-sm"
          />
          <Button type="submit" size="sm" className="h-7" disabled={busy}>
            Save name
          </Button>
          <Button type="button" variant="ghost" size="sm" className="h-7" onClick={() => setMode("view")}>
            Cancel
          </Button>
        </form>
      ) : null}

      {mode === "signature" ? (
        <SignatureEditor
          address={identity.address}
          initial={(identity.signature as EditorDoc | null) ?? null}
          onSave={async (doc) => {
            await onUpdate({ ...key, signature: doc });
            setMode("view");
          }}
          onCancel={() => setMode("view")}
        />
      ) : null}

      {mode === "remove" ? (
        <div role="alertdialog" aria-label={`Remove ${identity.address}`} className="flex flex-wrap items-center gap-2">
          <p className="min-w-0 flex-1 text-xs text-foreground">
            Remove this address? New mail can no longer be sent from it; sends already queued keep it.
          </p>
          <Button
            variant="destructive"
            size="sm"
            className="h-7"
            disabled={busy}
            onClick={() => void run(() => onRemove(key), "Could not remove the address.")}
          >
            Remove
          </Button>
          <Button variant="ghost" size="sm" className="h-7" onClick={() => setMode("view")}>
            Cancel
          </Button>
        </div>
      ) : null}
      {problem !== null ? (
        <p role="alert" className="text-xs text-destructive">
          {problem}
        </p>
      ) : null}
    </li>
  );
}

type TemplateEdit = { id: string | null; name: string; doc: EditorDoc };

/** The Inbox tab (slice 3e): Blocked senders, and where each account's snoozed mail waits. */
function InboxSection({
  accounts,
  rules,
  onUnblock,
  onChangeSnoozeFolder,
}: {
  accounts: readonly Account[];
  rules: readonly BlockRuleView[] | null;
  onUnblock: (id: string) => Promise<void>;
  onChangeSnoozeFolder: ((accountId: string) => void) | undefined;
}) {
  const [removing, setRemoving] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  return (
    <div className="flex flex-col gap-2">
      <SectionHeading>Blocked senders</SectionHeading>
      <p className="text-xs text-muted-foreground">
        New mail from them moves to Spam in every account while BB runs. Mail already in Spam stays there.
      </p>
      {rules === null ? <p className="text-sm text-muted-foreground">Loading…</p> : null}
      {rules !== null && rules.length === 0 ? (
        <p className="text-sm text-muted-foreground">No blocked senders. Block one from a message's toolbar.</p>
      ) : null}
      {rules !== null && rules.length > 0 ? (
        <ul aria-label="Blocked senders" className="flex flex-col divide-y divide-border rounded-md border border-border">
          {rules.map((rule) => (
            <li key={rule.id} aria-label={rule.value} className="flex flex-col gap-1 px-3 py-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="shrink-0 rounded-sm border border-border px-1 text-xs text-muted-foreground">
                  {rule.kind === "address" ? "Address" : "Domain"}
                </span>
                <span className="min-w-0 flex-1 break-all text-sm text-foreground">{rule.value}</span>
                <span className="shrink-0 text-xs text-muted-foreground">{formatDay(rule.createdAt)}</span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7"
                  aria-label={`Unblock ${rule.value}`}
                  onClick={() => {
                    setProblem(null);
                    setRemoving(rule.id);
                  }}
                >
                  Unblock
                </Button>
              </div>
              {removing === rule.id ? (
                <div role="alertdialog" aria-label={`Unblock ${rule.value}`} className="flex flex-wrap items-center gap-2">
                  <p className="min-w-0 flex-1 text-xs text-foreground">
                    Unblock {rule.value}? Mail already in Spam stays there.
                  </p>
                  <Button
                    variant="destructive"
                    size="sm"
                    className="h-7"
                    onClick={() => {
                      onUnblock(rule.id).then(
                        () => setRemoving(null),
                        (error: unknown) => setProblem(messageOf(error, "Could not unblock.")),
                      );
                    }}
                  >
                    Unblock
                  </Button>
                  <Button variant="ghost" size="sm" className="h-7" onClick={() => setRemoving(null)}>
                    Cancel
                  </Button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {problem !== null ? (
        <p role="alert" className="text-xs text-destructive">
          {problem}
        </p>
      ) : null}
      <SectionHeading>Snoozed folder</SectionHeading>
      <p className="text-xs text-muted-foreground">
        Snoozed mail waits in this folder and comes back while BB runs. Renaming it elsewhere ends those snoozes.
      </p>
      <ul aria-label="Snoozed folders" className="flex flex-col divide-y divide-border rounded-md border border-border">
        {accounts.map((account) => (
          <li key={account.id} aria-label={accountLabel(account)} className="flex flex-wrap items-center gap-2 px-3 py-2">
            <span className="min-w-0 flex-1 truncate text-sm text-foreground">{accountLabel(account)}</span>
            <span className="min-w-0 truncate text-xs text-muted-foreground">
              {account.snoozeFolder ?? "None yet; the first snooze asks"}
            </span>
            {onChangeSnoozeFolder !== undefined ? (
              <Button
                variant="outline"
                size="sm"
                className="h-7"
                aria-label={`Change the snoozed folder of ${accountLabel(account)}`}
                onClick={() => onChangeSnoozeFolder(account.id)}
              >
                Change…
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

function TemplatesSection({
  templates,
  onSave,
  onDelete,
}: {
  templates: readonly TemplateView[];
  onSave: MailSettingsProps["onSaveTemplate"];
  onDelete: MailSettingsProps["onDeleteTemplate"];
}) {
  const [editing, setEditing] = useState<TemplateEdit | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  return (
    <div className="flex flex-col gap-2">
      <SectionHeading
        action={
          editing === null ? (
            <Button
              variant="outline"
              size="sm"
              className="h-7"
              onClick={() => {
                setProblem(null);
                setEditing({ id: null, name: "", doc: { type: "doc", content: [{ type: "paragraph" }] } });
              }}
            >
              <Icon name="Plus" aria-hidden />
              New template
            </Button>
          ) : null
        }
      >
        Templates
      </SectionHeading>
      {editing !== null ? (
        <TemplateEditor
          key={editing.id ?? "new"}
          edit={editing}
          onSave={async (input) => {
            await onSave(input);
            setEditing(null);
          }}
          onCancel={() => setEditing(null)}
        />
      ) : null}
      {templates.length === 0 && editing === null ? (
        <p className="text-sm text-muted-foreground">No templates yet. A template is inserted at the cursor.</p>
      ) : null}
      {templates.length > 0 ? (
        <ul aria-label="Templates" className="flex flex-col divide-y divide-border rounded-md border border-border">
          {templates.map((template) => (
            <li key={template.id} aria-label={template.name} className="flex flex-col gap-1 px-3 py-2">
              <div className="flex flex-wrap items-center gap-2">
                <p className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{template.name}</p>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7"
                  aria-label={`Edit ${template.name}`}
                  onClick={() => {
                    setProblem(null);
                    setEditing({ id: template.id, name: template.name, doc: template.doc });
                  }}
                >
                  Edit
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7"
                  aria-label={`Delete ${template.name}`}
                  onClick={() => setRemoving(template.id)}
                >
                  Delete
                </Button>
              </div>
              <p className="line-clamp-2 whitespace-pre-line text-xs text-muted-foreground">{docPreview(template.doc)}</p>
              {removing === template.id ? (
                <div role="alertdialog" aria-label={`Delete ${template.name}`} className="flex flex-wrap items-center gap-2">
                  <p className="min-w-0 flex-1 text-xs text-foreground">Delete this template?</p>
                  <Button
                    variant="destructive"
                    size="sm"
                    className="h-7"
                    onClick={() => {
                      setProblem(null);
                      onDelete(template.id).then(
                        () => setRemoving(null),
                        (error: unknown) => setProblem(messageOf(error, "Could not delete the template.")),
                      );
                    }}
                  >
                    Delete
                  </Button>
                  <Button variant="ghost" size="sm" className="h-7" onClick={() => setRemoving(null)}>
                    Cancel
                  </Button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {problem !== null ? (
        <p role="alert" className="text-xs text-destructive">
          {problem}
        </p>
      ) : null}
    </div>
  );
}

function TemplateEditor({
  edit,
  onSave,
  onCancel,
}: {
  edit: TemplateEdit;
  onSave: MailSettingsProps["onSaveTemplate"];
  onCancel: () => void;
}) {
  const id = useId();
  const [editor, setEditor] = useState<Editor | null>(null);
  const [linkOpen, setLinkOpen] = useState(false);
  const [name, setName] = useState(edit.name);
  const [doc, setDoc] = useState<EditorDoc>(edit.doc);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (name.trim() === "") return setProblem("Give the template a name.");
    if (editorDocEmpty(doc)) return setProblem("Write the template's text.");
    setBusy(true);
    setProblem(null);
    try {
      await onSave({ ...(edit.id !== null ? { id: edit.id } : {}), name: name.trim(), doc });
    } catch (error) {
      setProblem(messageOf(error, "Could not save the template."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      onSubmit={(event) => void save(event)}
      aria-label={edit.id === null ? "New template" : `Edit ${edit.name}`}
      className="flex flex-col gap-2 rounded-md border border-border p-2"
    >
      <div className="flex flex-col gap-1">
        <label htmlFor={`${id}-name`} className="text-xs text-muted-foreground">
          Name
        </label>
        <Input
          id={`${id}-name`}
          autoFocus
          value={name}
          maxLength={80}
          onChange={(event) => {
            setName(event.target.value.replace(/[\r\n]+/g, " "));
            setProblem(null);
          }}
          className="h-8"
        />
      </div>
      <div className="rounded-md border border-border">
        <div className="border-b border-border px-2 py-1">
          <ComposeToolbar editor={editor} linkOpen={linkOpen} onLinkOpenChange={setLinkOpen} tools={TEMPLATE_TOOLS} />
        </div>
        <ComposeEditor
          label="Template text"
          initialDoc={edit.doc}
          importFrom={null}
          features={{ quotes: false }}
          onChange={(next) => {
            setDoc(next);
            setProblem(null);
          }}
          onFiles={() => setProblem("A template cannot hold files.")}
          onReady={setEditor}
          onLinkShortcut={() => setLinkOpen(true)}
        />
      </div>
      {problem !== null ? (
        <p role="alert" className="text-xs text-destructive">
          {problem}
        </p>
      ) : null}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={busy}>
          Save template
        </Button>
      </div>
    </form>
  );
}

/** Categories, Today, reply reminders and AI settings (slice 3f). */
function AiFeaturesSection({ ai }: { ai: SettingsAiPorts }) {
  const [rules, setRules] = useState<CategoryRuleView[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const { loadRules } = ai;
  useEffect(() => {
    if (!ai.categoriesOn) return;
    let live = true;
    loadRules().then(
      (found) => {
        if (live) setRules(found);
      },
      () => {
        if (live) setRules([]);
      },
    );
    return () => {
      live = false;
    };
  }, [ai.categoriesOn, loadRules]);
  const remove = async (id: string) => {
    try {
      await ai.removeRule(id);
      setRules((prev) => prev?.filter((rule) => rule.id !== id) ?? null);
    } catch (error) {
      setProblem(messageOf(error, "The rule could not be removed"));
    }
  };
  return (
    <div className="flex flex-col gap-4">
      <section aria-label="Categories" className="flex flex-col gap-1">
        <SectionHeading>Categories</SectionHeading>
        <p className="text-sm text-foreground">{ai.categoriesOn ? "On: mail is sorted into local labels." : "Off."}</p>
        <p className="text-xs text-muted-foreground">
          Bills, Notifications, Personal and Newsletters live only in Makosh Mail; nothing is written to the mail server.{" "}
          {PLUGIN_SETTINGS_HINT}
        </p>
        {ai.categoriesOn ? (
          rules === null ? null : rules.length === 0 ? (
            <p className="text-xs text-muted-foreground">No sender rules. Always for this sender in a conversation adds one.</p>
          ) : (
            <ul aria-label="Category rules" className="flex flex-col gap-1">
              {rules.map((rule) => (
                <li key={rule.id} className="flex items-center gap-2 text-sm">
                  <span className="min-w-0 flex-1 truncate text-foreground">{rule.value}</span>
                  <span className="text-xs text-muted-foreground">{categoryLabel(rule.category)}</span>
                  <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={() => void remove(rule.id)}>
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
          )
        ) : null}
        {problem !== null ? (
          <p role="alert" className="text-xs text-destructive">
            {problem}
          </p>
        ) : null}
      </section>
      <section aria-label="Today" className="flex flex-col gap-1">
        <SectionHeading>Today</SectionHeading>
        <p className="text-sm text-foreground">
          {ai.morningDigest ? `On: the Today digest is ready at ${ai.digestTime}.` : "Off: the Today view still works when you open it."}
        </p>
        <p className="text-xs text-muted-foreground">{PLUGIN_SETTINGS_HINT}</p>
      </section>
      <section aria-label="Reply reminders" className="flex flex-col gap-1">
        <SectionHeading>Reply reminders</SectionHeading>
        <p className="text-sm text-foreground">{`Remind me after ${ai.reminderDays === 1 ? "1 day" : `${ai.reminderDays} days`} by default.`}</p>
        <p className="text-xs text-muted-foreground">
          A reminder turns due when no message answering yours (by In-Reply-To or References) arrives in time. {PLUGIN_SETTINGS_HINT}
        </p>
      </section>
      <section aria-label="AI settings" className="flex flex-col items-start gap-1">
        <SectionHeading>AI settings</SectionHeading>
        <p className="text-xs text-muted-foreground">The Makosh AI provider and model every AI feature and translation uses.</p>
        <Button variant="outline" size="sm" onClick={ai.onOpenAiSettings}>
          {"AI settings\u2026"}
        </Button>
      </section>
    </div>
  );
}
