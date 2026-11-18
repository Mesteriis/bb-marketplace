// Mail settings -> Filters (slice 3m, #65): what happens to new Inbox mail
// without an agent. A filter matches a sender, a sender domain, a mailing
// list or subject words, and moves the message, marks it read or flags it.
// The first matching filter in the list applies. Filters look at mail that
// arrives after they are saved, never at mail already in the Inbox.
import { useCallback, useEffect, useId, useState } from "react";
import type { FilterInput, FilterView } from "../core/contract.ts";
import type { Account, Folder } from "../core/model.ts";
import { filterActionParts, validateFilter, type FilterMove } from "../core/mail-filters.ts";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { FIELD_CLASS } from "./bb-ports.ts";
import { msg, tx } from "./i18n/index.ts";

export interface SettingsFilterPorts {
  list: () => Promise<FilterView[]>;
  save: (input: FilterInput) => Promise<void>;
  remove: (id: string) => Promise<void>;
  /** The account's folders, for "Move to a folder". */
  folders: (accountId: string) => Promise<Folder[]>;
}

const split = (text: string) =>
  text
    .split(/[,\s]+/)
    .map((part) => part.trim())
    .filter((part) => part !== "");

const messageOf = (error: unknown, fallback: string) => tx(error instanceof Error && error.message !== "" ? error.message : fallback);

const PART: Record<ReturnType<typeof filterActionParts>[number], string> = {
  archive: msg("archive"),
  trash: msg("move to Trash"),
  folder: msg("move to {folder}"),
  read: msg("mark read"),
  flag: msg("flag"),
};

/** What a filter does, in words: "move to Lists, mark read". */
export function filterActionsText(actions: FilterView["actions"]): string {
  return filterActionParts(actions)
    .map((part) => tx(PART[part], { folder: actions.folder ?? "" }))
    .join(", ");
}

/** What a filter matches, in words. */
export function filterMatchText(match: FilterView["match"], accounts: readonly Account[]): string {
  const parts: string[] = [];
  if ((match.from ?? []).length > 0) parts.push(tx("from {list}", { list: match.from!.join(", ") }));
  if ((match.domains ?? []).length > 0) parts.push(tx("from the domain {list}", { list: match.domains!.join(", ") }));
  if (match.list != null && match.list !== "") parts.push(tx("list {list}", { list: match.list }));
  if ((match.subjectWords ?? []).length > 0) parts.push(tx("subject has {list}", { list: match.subjectWords!.join(" ") }));
  const names = (match.accounts ?? []).map((id) => accounts.find((account) => account.id === id)?.email ?? null).filter((email) => email !== null);
  if (names.length > 0) parts.push(tx("in {list}", { list: names.join(", ") }));
  return parts.join("; ");
}

export function FiltersSettings({ ports, accounts }: { ports: SettingsFilterPorts; accounts: readonly Account[] }) {
  const [filters, setFilters] = useState<FilterView[] | null>(null);
  const [editing, setEditing] = useState<FilterView | "new" | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setFilters(await ports.list());
    } catch (error) {
      setFilters([]);
      setProblem(messageOf(error, "The filters could not be loaded"));
    }
  }, [ports]);
  useEffect(() => {
    void load();
  }, [load]);
  const save = async (input: FilterInput) => {
    await ports.save(input);
    setEditing(null);
    await load();
  };
  const change = async (work: () => Promise<void>, fallback: string) => {
    setProblem(null);
    try {
      await work();
      await load();
    } catch (error) {
      setProblem(messageOf(error, fallback));
    }
  };

  return (
    <section aria-label={tx("Filters")} className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <h3 className="min-w-0 flex-1 text-sm font-semibold text-foreground">{tx("Filters")}</h3>
        <Button variant="outline" size="sm" className="h-7 px-2" disabled={editing !== null} onClick={() => setEditing("new")}>
          {tx("New filter")}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        {tx(
          "Filters sort new Inbox mail as it arrives: the first one in the list that matches a message applies. Mail already in the Inbox stays where it is. Blocked senders go to Spam before any filter, and a message whose sender check failed is never sorted.",
        )}
      </p>
      {problem !== null ? (
        <p role="alert" className="text-sm text-destructive">
          {problem}
        </p>
      ) : null}
      {editing !== null ? (
        <FilterForm filter={editing === "new" ? null : editing} accounts={accounts} folders={ports.folders} onSave={save} onCancel={() => setEditing(null)} />
      ) : null}
      {filters === null ? null : filters.length === 0 ? (
        <p className="text-xs text-muted-foreground">{tx("No filters yet.")}</p>
      ) : (
        <ol aria-label={tx("Mail filters")} className="flex flex-col divide-y divide-border rounded-md border border-border">
          {filters.map((filter) => (
            <li key={filter.id} className="flex flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2 text-sm">
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-foreground">{filter.name}</span>
                <span className="break-words text-xs text-muted-foreground">
                  {filterMatchText(filter.match, accounts)} {"\u2192"} {filterActionsText(filter.actions)}
                </span>
              </span>
              {!filter.enabled ? <span className="text-xs text-muted-foreground">{tx("Off")}</span> : null}
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-xs"
                onClick={() =>
                  void change(
                    () => ports.save({ id: filter.id, name: filter.name, enabled: !filter.enabled, match: filter.match, actions: filter.actions }),
                    "The filter could not be saved",
                  )
                }
              >
                {filter.enabled ? tx("Turn off") : tx("Turn on")}
              </Button>
              <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" disabled={editing !== null} onClick={() => setEditing(filter)}>
                {tx("Edit")}
              </Button>
              <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={() => void change(() => ports.remove(filter.id), "The filter could not be deleted")}>
                {tx("Delete")}
              </Button>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

interface FilterFormProps {
  filter: FilterView | null;
  accounts: readonly Account[];
  folders: SettingsFilterPorts["folders"];
  onSave: (input: FilterInput) => Promise<void>;
  onCancel: () => void;
}

function FilterForm({ filter, accounts, folders, onSave, onCancel }: FilterFormProps) {
  const ids = { name: useId(), from: useId(), domains: useId(), list: useId(), words: useId(), account: useId(), move: useId(), folder: useId() };
  const match = filter?.match ?? {};
  const [name, setName] = useState(filter?.name ?? "");
  const [from, setFrom] = useState((match.from ?? []).join(", "));
  const [domains, setDomains] = useState((match.domains ?? []).join(", "));
  const [list, setList] = useState(match.list ?? "");
  const [words, setWords] = useState((match.subjectWords ?? []).join(" "));
  // One account or all of them; a filter saved for several keeps them unless the choice changes.
  const [accountId, setAccountId] = useState((match.accounts ?? []).length === 1 ? match.accounts![0]! : "");
  const [accountTouched, setAccountTouched] = useState(false);
  const [move, setMove] = useState<FilterMove>(filter?.actions.move ?? "none");
  const [folder, setFolder] = useState(filter?.actions.folder ?? "");
  const [markRead, setMarkRead] = useState(filter?.actions.markRead ?? false);
  const [flag, setFlag] = useState(filter?.actions.flag ?? false);
  const [choices, setChoices] = useState<Folder[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let live = true;
    setChoices(null);
    if (move !== "folder" || accountId === "") return;
    folders(accountId).then(
      (found) => {
        if (live) setChoices(found.filter((entry) => entry.selectable && entry.specialUse !== "inbox"));
      },
      () => {
        if (live) setChoices([]);
      },
    );
    return () => {
      live = false;
    };
  }, [accountId, move, folders]);

  const input = (): FilterInput => {
    const kept = !accountTouched && (match.accounts ?? []).length > 1 ? match.accounts! : accountId === "" ? [] : [accountId];
    return {
      ...(filter !== null ? { id: filter.id } : {}),
      name: name.trim(),
      enabled: filter?.enabled ?? true,
      match: {
        from: split(from),
        domains: split(domains).map((domain) => domain.toLowerCase()),
        list: list.trim() === "" ? null : list.trim().toLowerCase(),
        subjectWords: split(words),
        ...(kept.length > 0 ? { accounts: kept } : {}),
      },
      actions: { move, folder: move === "folder" && folder !== "" ? folder : null, markRead, flag },
    };
  };
  const save = async () => {
    const next = input();
    const checked = validateFilter({ name: next.name, match: next.match, actions: next.actions });
    if (!checked.ok) {
      setProblem(tx(checked.reason));
      return;
    }
    setSaving(true);
    setProblem(null);
    try {
      await onSave(next);
    } catch (error) {
      setProblem(messageOf(error, "The filter could not be saved"));
    } finally {
      setSaving(false);
    }
  };

  const field = (id: string, label: string, value: string, onChange: (v: string) => void, hint?: string) => (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-xs font-medium text-muted-foreground">
        {label}
      </label>
      <Input id={id} value={value} onChange={(event) => onChange(event.target.value)} />
      {hint !== undefined ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );

  return (
    <form
      aria-label={filter === null ? tx("New filter") : tx("Edit {name}", { name: filter.name })}
      className="flex flex-col gap-3 rounded-md border border-border p-3"
      onSubmit={(event) => {
        event.preventDefault();
        event.stopPropagation();
        void save();
      }}
    >
      {field(ids.name, tx("Name"), name, setName)}
      <fieldset className="flex flex-col gap-2">
        <legend className="text-xs font-semibold text-foreground">{tx("When new Inbox mail matches all of")}</legend>
        {field(ids.from, tx("From addresses"), from, setFrom, tx("Separated by commas"))}
        {field(ids.domains, tx("Sender domains"), domains, setDomains)}
        {field(ids.list, tx("Mailing list id"), list, setList)}
        {field(ids.words, tx("Subject words"), words, setWords, tx("Whole words, any case"))}
        <div className="flex flex-col gap-1">
          <label htmlFor={ids.account} className="text-xs font-medium text-muted-foreground">
            {tx("Account")}
          </label>
          <select
            id={ids.account}
            className={cn(FIELD_CLASS, "h-8")}
            value={accountId}
            onChange={(event) => {
              setAccountId(event.target.value);
              setAccountTouched(true);
              setFolder("");
            }}
          >
            <option value="">{tx("Every account")}</option>
            {accounts.map((account) => (
              <option key={account.id} value={account.id}>
                {account.email}
              </option>
            ))}
          </select>
        </div>
      </fieldset>
      <fieldset className="flex flex-col gap-2">
        <legend className="text-xs font-semibold text-foreground">{tx("Then")}</legend>
        <div className="flex flex-col gap-1">
          <label htmlFor={ids.move} className="text-xs font-medium text-muted-foreground">
            {tx("Move")}
          </label>
          <select id={ids.move} className={cn(FIELD_CLASS, "h-8")} value={move} onChange={(event) => setMove(event.target.value as FilterMove)}>
            <option value="none">{tx("Leave in the Inbox")}</option>
            <option value="archive">{tx("Archive|filter")}</option>
            <option value="trash">{tx("Move to Trash")}</option>
            <option value="folder">{tx("Move to a folder")}</option>
          </select>
        </div>
        {move === "folder" ? (
          accountId === "" ? (
            <p className="text-xs text-muted-foreground">{tx("Choose one account above: folders belong to an account.")}</p>
          ) : (
            <div className="flex flex-col gap-1">
              <label htmlFor={ids.folder} className="text-xs font-medium text-muted-foreground">
                {tx("Folder")}
              </label>
              <select id={ids.folder} className={cn(FIELD_CLASS, "h-8")} value={folder} onChange={(event) => setFolder(event.target.value)}>
                <option value="">{choices === null ? tx("Loading\u2026") : tx("Choose a folder")}</option>
                {/* A saved folder that is gone from the server stays visible, so the form says what is wrong. */}
                {folder !== "" && choices !== null && !choices.some((entry) => entry.path === folder) ? <option value={folder}>{folder}</option> : null}
                {(choices ?? []).map((entry) => (
                  <option key={entry.path} value={entry.path}>
                    {entry.path}
                  </option>
                ))}
              </select>
            </div>
          )
        ) : null}
        <label className="flex items-center gap-2 text-sm">
          <Checkbox checked={markRead} onCheckedChange={(checked) => setMarkRead(checked === true)} />
          {tx("Mark as read")}
        </label>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox checked={flag} onCheckedChange={(checked) => setFlag(checked === true)} />
          {tx("Flag|filter")}
        </label>
      </fieldset>
      {problem !== null ? (
        <p role="alert" className="text-sm text-destructive">
          {problem}
        </p>
      ) : null}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          {tx("Cancel")}
        </Button>
        <Button type="submit" size="sm" disabled={saving}>
          {tx("Save filter")}
        </Button>
      </div>
    </form>
  );
}
