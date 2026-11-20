import { useEffect, useId, useState, type FormEvent } from "react";
import type { Account, IdentityView } from "../../core/model.ts";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { type EditorDoc } from "../compose-editor.tsx";
import { accountLabel } from "../folder-list.tsx";
import { SignatureEditor } from "../signature-editor.tsx";
import { tx } from "../i18n/index.ts";
import { type SuggestionView, type MailSettingsProps, messageOf, docPreview, sendCheckText, formatDay } from "./shared.ts";
import { SectionHeading } from "./primitives.tsx";

export function AddressesSection(
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
            <SelectTrigger aria-label={tx("Account")} className="h-8 w-auto max-w-72">
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
      </div>

      <ul aria-label={tx("Sending addresses")} className="flex flex-col divide-y divide-border rounded-md border border-border">
        {own.map((identity) => (
          <IdentityRow key={identity.address} identity={identity} {...props} />
        ))}
      </ul>

      <SectionHeading>{tx("Add address")}</SectionHeading>
      <form onSubmit={(event) => void add(event)} className="flex flex-wrap items-end gap-2" aria-label={tx("Add address")}>
        <div className="flex min-w-48 flex-1 flex-col gap-1">
          <label htmlFor={`${id}-address`} className="text-xs text-muted-foreground">
            {tx("Address")}
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
            {tx("Name (optional)")}
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
          {tx("Add address")}
        </Button>
        {addProblem !== null ? (
          <p role="alert" className="w-full text-xs text-destructive">
            {addProblem}
          </p>
        ) : null}
      </form>
      <p className="text-xs text-muted-foreground">
        {tx("The plugin cannot check that the provider lets this account send from an address; after the first send it says so here.")}
      </p>

      <SectionHeading>{tx("Suggestions")}</SectionHeading>
      {suggested === "loading" ? <p className="text-xs text-muted-foreground">{tx("Looking for suggestions\u2026")}</p> : null}
      {suggested === "error" ? <p className="text-xs text-muted-foreground">{tx("Could not load suggestions.")}</p> : null}
      {Array.isArray(suggested) && suggested.length === 0 ? (
        <p className="text-xs text-muted-foreground">{tx("No suggestions.")}</p>
      ) : null}
      {Array.isArray(suggested) && suggested.length > 0 ? (
        <ul aria-label={tx("Suggestions")} className="flex flex-col divide-y divide-border rounded-md border border-border">
          {suggested.map((suggestion) => (
            <li key={suggestion.address} className="flex flex-wrap items-center gap-2 px-3 py-2">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm text-foreground">{suggestion.address}</p>
                <p className="text-xs text-muted-foreground">
                  {suggestion.count === 1 ? tx("1 message") : `${suggestion.count} messages`} {tx("\u00b7 last")}{" "}
                  {formatDay(suggestion.lastDate)}
                </p>
              </div>
              <Button
                variant="outline"
                size="sm"
                className="h-7"
                aria-label={tx("Add {address}", { address: suggestion.address })}
                onClick={() => {
                  setAddress(suggestion.address);
                  setAddProblem(null);
                  document.getElementById(`${id}-name`)?.focus();
                }}
              >
                {tx("Add")}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-7"
                aria-label={`${suggestion.address} is not mine`}
                onClick={() => void dismiss(suggestion)}
              >
                {tx("Not mine")}
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
          {identity.primary ? tx("Own address") : tx("Alias")}
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
          {signature === "" ? tx("No signature") : signature}
        </p>
      ) : null}

      {mode === "view" ? (
        <div className="flex flex-wrap gap-1">
          <Button variant="outline" size="sm" className="h-7" onClick={() => setMode("signature")}>
            {signature === "" ? tx("Add signature") : tx("Edit signature")}
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
                {tx("Rename")}
              </Button>
              <Button variant="ghost" size="sm" className="h-7" onClick={() => setMode("remove")}>
                {tx("Remove")}
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
            {tx("Name for")} {identity.address}
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
            {tx("Save name")}
          </Button>
          <Button type="button" variant="ghost" size="sm" className="h-7" onClick={() => setMode("view")}>
            {tx("Cancel")}
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
        <div role="alertdialog" aria-label={tx("Remove {address}", { address: identity.address })} className="flex flex-wrap items-center gap-2">
          <p className="min-w-0 flex-1 text-xs text-foreground">
            {tx("Remove this address? New mail can no longer be sent from it; sends already queued keep it.")}
          </p>
          <Button
            variant="destructive"
            size="sm"
            className="h-7"
            disabled={busy}
            onClick={() => void run(() => onRemove(key), "Could not remove the address.")}
          >
            {tx("Remove")}
          </Button>
          <Button variant="ghost" size="sm" className="h-7" onClick={() => setMode("view")}>
            {tx("Cancel")}
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
