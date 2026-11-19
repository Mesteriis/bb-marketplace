// Connects an IMAP account. The app password lives only in the input element:
// it is read when Test or Save runs, never kept in React state, and the field
// is cleared once the account is saved.
import { useId, useRef, useState, type ComponentType, type FormEvent, type ReactNode, useEffect } from "react";
import type { AccountPreset, NewAccountInput, SmtpSecurity } from "../core/index.ts";
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
import { defaultSmtpPort, smtpInput } from "./smtp-dialog.tsx";
import { tx } from "./i18n/index.ts";

const PRESET_ORDER: AccountPreset[] = ["icloud", "gmail", "other"];

export interface AccountFormInitial {
  preset: AccountPreset;
  email: string;
  host?: string;
  port?: number;
  /** "google": open on Google sign-in (a reconnect of a Google account, or a switch to it). */
  signIn?: "google";
}

/** How a Google sign-in ended, as a sentence for the form when it failed. */
export type GoogleSignInOutcome = { ok: true } | { ok: false; message: string };

export interface AccountFormProps {
  /** Prefills the form, e.g. to replace the app password of an account. */
  initial?: AccountFormInitial;
  title: string;
  onTest: (input: NewAccountInput) => Promise<{ ok: boolean; reason: string | null }>;
  /** Resolves once the account is saved; rejects with a message the owner can act on. */
  onSave: (input: NewAccountInput) => Promise<void>;
  onCancel?: () => void;
  /**
   * Signs in to Google in the browser for this address (null: any account)
   * and resolves when the account is saved or the sign-in failed; it gives
   * up when the signal aborts. Absent: only app passwords are offered.
   */
  onGoogleSignIn?: (email: string | null, signal: AbortSignal) => Promise<GoogleSignInOutcome>;
  /** Renders a link to a provider page, e.g. BB's UrlLink. */
  ExternalLink: ComponentType<{ href: string; className?: string; children?: ReactNode }>;
}

type Outcome = { kind: "ok" | "error"; message: string } | null;

function messageOf(error: unknown): string {
  return error instanceof Error && error.message ? error.message : tx("Something went wrong");
}

export function AccountForm({ initial, title, onTest, onSave, onCancel, onGoogleSignIn, ExternalLink }: AccountFormProps) {
  const id = useId();
  const passwordRef = useRef<HTMLInputElement | null>(null);
  const [preset, setPreset] = useState<AccountPreset>(initial?.preset ?? "icloud");
  const [email, setEmail] = useState(initial?.email ?? "");
  const [host, setHost] = useState(initial?.host ?? "");
  const [port, setPort] = useState(String(initial?.port ?? PRESETS.other.port));
  const [smtpHost, setSmtpHost] = useState("");
  const [smtpSecurity, setSmtpSecurity] = useState<SmtpSecurity>("tls");
  const [smtpPort, setSmtpPort] = useState(String(defaultSmtpPort("tls")));
  const [smtpUsername, setSmtpUsername] = useState("");
  const [busy, setBusy] = useState<"test" | "save" | "google" | null>(null);
  // Replacing an app password opens on the password; everything else Gmail opens on Google.
  const [byPassword, setByPassword] = useState(
    initial !== undefined && initial.email !== "" && initial.signIn !== "google",
  );
  const google = onGoogleSignIn !== undefined && preset === "gmail";
  const withGoogle = google && !byPassword;
  const waiting = useRef<AbortController | null>(null);
  useEffect(() => () => waiting.current?.abort(), []);
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
    const smtp = smtpInput("", { host: smtpHost, port: smtpPort, security: smtpSecurity, username: smtpUsername });
    if (typeof smtp === "string") return fail(smtp);
    return {
      preset,
      email: address,
      host: server,
      port: portNumber,
      password,
      smtpHost: smtp.host,
      smtpPort: smtp.port,
      smtpSecurity: smtp.security,
      ...(smtp.username !== undefined ? { smtpUsername: smtp.username } : {}),
    };
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
          ? { kind: "ok", message: tx("Connection works.") }
          : { kind: "error", message: result.reason ?? tx("Connection failed.") },
      );
    } catch (error) {
      setOutcome({ kind: "error", message: messageOf(error) });
    } finally {
      setBusy(null);
    }
  }

  async function signInWithGoogle() {
    if (onGoogleSignIn === undefined) return;
    const controller = new AbortController();
    waiting.current?.abort();
    waiting.current = controller;
    setBusy("google");
    setOutcome(null);
    try {
      const result = await onGoogleSignIn(email.trim() === "" ? null : email.trim(), controller.signal);
      if (controller.signal.aborted) return;
      setOutcome(result.ok ? { kind: "ok", message: tx("Signed in with Google.") } : { kind: "error", message: result.message });
    } catch (error) {
      if (!controller.signal.aborted) setOutcome({ kind: "error", message: messageOf(error) });
    } finally {
      if (!controller.signal.aborted) setBusy(null);
    }
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (withGoogle) return;
    const input = readInput();
    if (input === null) return;
    setBusy("save");
    setOutcome(null);
    try {
      await onSave(input);
      if (passwordRef.current) passwordRef.current.value = "";
      setOutcome({ kind: "ok", message: tx("Account saved.") });
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
          {withGoogle
            ? tx("Google opens in your browser and asks to let Makosh Mail read and send your mail. No password is typed here.")
            : tx("Mail signs in over IMAP with an app password, not your account password.")}
        </p>
      </div>

      <div className="flex flex-col gap-1.5">
        <label id={`${id}-preset`} className="text-sm font-medium text-foreground">
          {tx("Provider")}
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
          {tx("Email")}
        </label>
        <Input
          id={`${id}-email`}
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          placeholder="you@example.org"
        />
      </div>

      {withGoogle ? (
        <div className="flex flex-col items-start gap-1.5">
          <Button type="button" onClick={() => void signInWithGoogle()} disabled={busy !== null}>
            {busy === "google" ? tx("Waiting for Google\u2026") : tx("Sign in with Google")}
          </Button>
          <Button
            type="button"
            variant="link"
            size="sm"
            className="h-auto px-0 text-xs"
            onClick={() => {
              waiting.current?.abort();
              setBusy(null);
              setOutcome(null);
              setByPassword(true);
            }}
          >
            {tx("Use an app password instead")}
          </Button>
        </div>
      ) : (
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${id}-password`} className="text-sm font-medium text-foreground">
            {tx("App password")}
          </label>
          <Input id={`${id}-password`} ref={passwordRef} type="password" autoComplete="off" />
          {appPasswordUrl !== null ? (
            <ExternalLink href={appPasswordUrl} className="text-xs text-primary underline-offset-4 hover:underline">
              {tx("Create an app password for")} {PRESETS[preset].label}
            </ExternalLink>
          ) : null}
          {google ? (
            <Button
              type="button"
              variant="link"
              size="sm"
              className="h-auto self-start px-0 text-xs"
              onClick={() => {
                setOutcome(null);
                setByPassword(false);
              }}
            >
              {tx("Sign in with Google instead")}
            </Button>
          ) : null}
        </div>
      )}

      {preset === "other" ? (
        <div className="flex gap-3">
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <label htmlFor={`${id}-host`} className="text-sm font-medium text-foreground">
              {tx("Server")}
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
              {tx("Port")}
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

      {preset === "other" ? (
        <fieldset className="flex flex-col gap-3">
          <legend className="pb-1.5 text-sm font-medium text-foreground">{tx("Sending (SMTP)")}</legend>
          <div className="flex gap-3">
            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
              <label htmlFor={`${id}-smtp-host`} className="text-sm font-medium text-foreground">
                {tx("SMTP server")}
              </label>
              <Input
                id={`${id}-smtp-host`}
                value={smtpHost}
                onChange={(event) => setSmtpHost(event.target.value)}
                placeholder="smtp.example.org"
              />
            </div>
            <div className="flex w-24 flex-col gap-1.5">
              <label htmlFor={`${id}-smtp-port`} className="text-sm font-medium text-foreground">
                {tx("SMTP port")}
              </label>
              <Input
                id={`${id}-smtp-port`}
                inputMode="numeric"
                value={smtpPort}
                onChange={(event) => setSmtpPort(event.target.value)}
              />
            </div>
          </div>
          <div className="flex gap-3">
            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
              <label id={`${id}-smtp-security`} className="text-sm font-medium text-foreground">
                {tx("Security")}
              </label>
              <Select
                value={smtpSecurity}
                onValueChange={(next) => {
                  const value = next as SmtpSecurity;
                  if (smtpPort === String(defaultSmtpPort(smtpSecurity))) setSmtpPort(String(defaultSmtpPort(value)));
                  setSmtpSecurity(value);
                }}
              >
                <SelectTrigger aria-labelledby={`${id}-smtp-security`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="tls">{tx("TLS")}</SelectItem>
                  <SelectItem value="starttls">{tx("STARTTLS")}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
              <label htmlFor={`${id}-smtp-username`} className="text-sm font-medium text-foreground">
                {tx("SMTP username")}
              </label>
              <Input
                id={`${id}-smtp-username`}
                value={smtpUsername}
                onChange={(event) => setSmtpUsername(event.target.value)}
                placeholder={tx("Same as the email")}
              />
            </div>
          </div>
        </fieldset>
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
            {tx("Cancel")}
          </Button>
        ) : null}
        {withGoogle ? null : (
          <>
            <Button type="button" variant="outline" onClick={test} disabled={busy !== null}>
              {busy === "test" ? tx("Testing\u2026") : tx("Test")}
            </Button>
            <Button type="submit" disabled={busy !== null}>
              {busy === "save" ? tx("Saving\u2026") : tx("Save")}
            </Button>
          </>
        )}
      </div>
    </form>
  );
}
