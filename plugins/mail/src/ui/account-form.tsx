// Connects an IMAP account. The app password lives only in the input element:
// it is read when Test or Save runs, never kept in React state, and the field
// is cleared once the account is saved.
import { useId, useRef, useState, type ComponentType, type FormEvent, type ReactNode } from "react";
import type { AccountPreset, NewAccountInput } from "../core/index.ts";
// presets.ts directly: the core index would pull its zod schemas into the app bundle.
import { PRESETS } from "../core/presets.ts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const PRESET_ORDER: AccountPreset[] = ["icloud", "gmail", "other"];

export interface AccountFormInitial {
  preset: AccountPreset;
  email: string;
  host?: string;
  port?: number;
}

export interface AccountFormProps {
  /** Prefills the form, e.g. to replace the app password of an account. */
  initial?: AccountFormInitial;
  title: string;
  onTest: (input: NewAccountInput) => Promise<{ ok: boolean; reason: string | null }>;
  /** Resolves once the account is saved; rejects with a message the owner can act on. */
  onSave: (input: NewAccountInput) => Promise<void>;
  onCancel?: () => void;
  /** Renders a link to a provider page, e.g. BB's UrlLink. */
  ExternalLink: ComponentType<{ href: string; className?: string; children?: ReactNode }>;
}

type Outcome = { kind: "ok" | "error"; message: string } | null;

function messageOf(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "Something went wrong";
}

export function AccountForm({ initial, title, onTest, onSave, onCancel, ExternalLink }: AccountFormProps) {
  const id = useId();
  const passwordRef = useRef<HTMLInputElement | null>(null);
  const [preset, setPreset] = useState<AccountPreset>(initial?.preset ?? "icloud");
  const [email, setEmail] = useState(initial?.email ?? "");
  const [host, setHost] = useState(initial?.host ?? "");
  const [port, setPort] = useState(String(initial?.port ?? PRESETS.other.port));
  const [busy, setBusy] = useState<"test" | "save" | null>(null);
  const [outcome, setOutcome] = useState<Outcome>(null);
  const appPasswordUrl = PRESETS[preset].appPasswordUrl;

  /** Builds the input from the fields; the password is read here and nowhere else. */
  function readInput(): NewAccountInput | null {
    const password = passwordRef.current?.value ?? "";
    const address = email.trim();
    if (address === "") return fail("Enter the email address.");
    if (password === "") return fail("Enter the app password.");
    if (preset !== "other") return { preset, email: address, password };
    const server = host.trim();
    const portNumber = Number(port);
    if (server === "") return fail("Enter the IMAP server.");
    if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535) {
      return fail("Enter a port between 1 and 65535.");
    }
    return { preset, email: address, host: server, port: portNumber, password };
  }

  function fail(message: string): null {
    setOutcome({ kind: "error", message });
    return null;
  }

  async function test() {
    const input = readInput();
    if (input === null) return;
    setBusy("test");
    setOutcome(null);
    try {
      const result = await onTest(input);
      setOutcome(
        result.ok
          ? { kind: "ok", message: "Connection works." }
          : { kind: "error", message: result.reason ?? "Connection failed." },
      );
    } catch (error) {
      setOutcome({ kind: "error", message: messageOf(error) });
    } finally {
      setBusy(null);
    }
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    const input = readInput();
    if (input === null) return;
    setBusy("save");
    setOutcome(null);
    try {
      await onSave(input);
      if (passwordRef.current) passwordRef.current.value = "";
      setOutcome({ kind: "ok", message: "Account saved." });
    } catch (error) {
      setOutcome({ kind: "error", message: messageOf(error) });
    } finally {
      setBusy(null);
    }
  }

  return (
    <form
      onSubmit={save}
      noValidate
      aria-labelledby={`${id}-title`}
      className="flex flex-col gap-4 rounded-lg border border-border bg-card p-4"
    >
      <div className="flex flex-col gap-1">
        <h2 id={`${id}-title`} className="text-base font-semibold text-foreground">
          {title}
        </h2>
        <p className="text-sm text-muted-foreground">
          Mail signs in over IMAP with an app password, not your account password.
        </p>
      </div>

      <div className="flex flex-col gap-1.5">
        <label id={`${id}-preset`} className="text-sm font-medium text-foreground">
          Provider
        </label>
        <Select value={preset} onValueChange={(next) => setPreset(next as AccountPreset)}>
          <SelectTrigger aria-labelledby={`${id}-preset`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PRESET_ORDER.map((key) => (
              <SelectItem key={key} value={key}>
                {PRESETS[key].label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor={`${id}-email`} className="text-sm font-medium text-foreground">
          Email
        </label>
        <Input
          id={`${id}-email`}
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          placeholder="you@example.org"
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor={`${id}-password`} className="text-sm font-medium text-foreground">
          App password
        </label>
        <Input id={`${id}-password`} ref={passwordRef} type="password" autoComplete="off" />
        {appPasswordUrl !== null ? (
          <ExternalLink href={appPasswordUrl} className="text-xs text-primary underline-offset-4 hover:underline">
            Create an app password for {PRESETS[preset].label}
          </ExternalLink>
        ) : null}
      </div>

      {preset === "other" ? (
        <div className="flex gap-3">
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <label htmlFor={`${id}-host`} className="text-sm font-medium text-foreground">
              Server
            </label>
            <Input
              id={`${id}-host`}
              value={host}
              onChange={(event) => setHost(event.target.value)}
              placeholder="imap.example.org"
            />
          </div>
          <div className="flex w-24 flex-col gap-1.5">
            <label htmlFor={`${id}-port`} className="text-sm font-medium text-foreground">
              Port
            </label>
            <Input
              id={`${id}-port`}
              inputMode="numeric"
              value={port}
              onChange={(event) => setPort(event.target.value)}
            />
          </div>
        </div>
      ) : null}

      {outcome !== null ? (
        <p
          role={outcome.kind === "error" ? "alert" : "status"}
          className={outcome.kind === "error" ? "text-sm text-destructive" : "text-sm text-muted-foreground"}
        >
          {outcome.message}
        </p>
      ) : null}

      <div className="flex justify-end gap-2">
        {onCancel !== undefined ? (
          <Button type="button" variant="ghost" onClick={onCancel} disabled={busy !== null}>
            Cancel
          </Button>
        ) : null}
        <Button type="button" variant="outline" onClick={test} disabled={busy !== null}>
          {busy === "test" ? "Testing…" : "Test"}
        </Button>
        <Button type="submit" disabled={busy !== null}>
          {busy === "save" ? "Saving…" : "Save"}
        </Button>
      </div>
    </form>
  );
}
