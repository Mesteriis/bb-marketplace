// SMTP settings of a connected account (host, port, security, username):
// Test checks the login with the account's stored password; Save tests and
// stores them. The password never passes through this dialog.
import { useId, useState, type FormEvent } from "react";
import type { Account, SmtpSecurity } from "../core/model.ts";
// presets.ts directly: the core index would pull its zod schemas into the app bundle.
import { PRESETS } from "../core/presets.ts";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { accountLabel } from "./folder-list.tsx";
import { stopEscape } from "./shortcuts.ts";

export interface SmtpSettingsInput {
  accountId: string;
  host: string;
  port: number;
  security: SmtpSecurity;
  username?: string;
}

export type SmtpResult = { ok: boolean; reason: string | null };

/** The usual port for a security mode. */
export function defaultSmtpPort(security: SmtpSecurity): number {
  return security === "tls" ? 465 : 587;
}

const HOST = /^[A-Za-z0-9.-]{1,253}$/;

/** The form's fields as RPC input, or the problem to show. */
export function smtpInput(
  accountId: string,
  fields: { host: string; port: string; security: SmtpSecurity; username: string },
): SmtpSettingsInput | string {
  const host = fields.host.trim();
  if (host === "") return "Enter the SMTP server.";
  if (!HOST.test(host)) return "The SMTP server is a host name like smtp.example.org.";
  const port = Number(fields.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return "Enter a port between 1 and 65535.";
  const username = fields.username.trim();
  if (/[\r\n\u0000]/.test(username) || username.length > 320) return "The username cannot be used.";
  return { accountId, host, port, security: fields.security, ...(username !== "" ? { username } : {}) };
}

export interface SmtpDialogProps {
  /** The account to set up; null closes the dialog. */
  account: Account | null;
  onClose: () => void;
  onTest: (input: SmtpSettingsInput) => Promise<SmtpResult>;
  /** Tests, then stores; resolves with the outcome. */
  onSave: (input: SmtpSettingsInput) => Promise<SmtpResult>;
}

export function SmtpDialog({ account, onClose, onTest, onSave }: SmtpDialogProps) {
  return (
    <Dialog
      open={account !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-w-md" onEscapeKeyDown={stopEscape}>
        {account !== null ? (
          <SmtpForm key={account.id} account={account} onClose={onClose} onTest={onTest} onSave={onSave} />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

type Outcome = { kind: "ok" | "error"; message: string } | null;

function SmtpForm({ account, onClose, onTest, onSave }: SmtpDialogProps & { account: Account }) {
  const id = useId();
  const preset = PRESETS[account.preset].smtp;
  const [host, setHost] = useState(preset?.host ?? "");
  const [security, setSecurity] = useState<SmtpSecurity>(preset?.security ?? "tls");
  const [port, setPort] = useState(String(preset?.port ?? defaultSmtpPort("tls")));
  const [username, setUsername] = useState("");
  const [busy, setBusy] = useState<"test" | "save" | null>(null);
  const [outcome, setOutcome] = useState<Outcome>(null);

  const read = (): SmtpSettingsInput | null => {
    const input = smtpInput(account.id, { host, port, security, username });
    if (typeof input === "string") {
      setOutcome({ kind: "error", message: input });
      return null;
    }
    return input;
  };

  const run = async (kind: "test" | "save") => {
    const input = read();
    if (input === null) return;
    setBusy(kind);
    setOutcome(null);
    try {
      const result = await (kind === "test" ? onTest(input) : onSave(input));
      if (!result.ok) {
        setOutcome({ kind: "error", message: result.reason ?? "The SMTP server refused the login." });
      } else if (kind === "test") {
        setOutcome({ kind: "ok", message: "SMTP works." });
      } else {
        onClose();
      }
    } catch (error) {
      setOutcome({ kind: "error", message: error instanceof Error && error.message ? error.message : "Something went wrong" });
    } finally {
      setBusy(null);
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void run("save");
  };

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-4">
      <DialogHeader>
        <DialogTitle>SMTP for {accountLabel(account)}</DialogTitle>
        <DialogDescription>
          Mail sends through this server with the account&apos;s app password.
        </DialogDescription>
      </DialogHeader>
      <div className="flex gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <label htmlFor={`${id}-host`} className="text-sm font-medium text-foreground">
            SMTP server
          </label>
          <Input id={`${id}-host`} value={host} placeholder="smtp.example.org" onChange={(e) => setHost(e.target.value)} />
        </div>
        <div className="flex w-24 flex-col gap-1.5">
          <label htmlFor={`${id}-port`} className="text-sm font-medium text-foreground">
            Port
          </label>
          <Input id={`${id}-port`} inputMode="numeric" value={port} onChange={(e) => setPort(e.target.value)} />
        </div>
      </div>
      <div className="flex flex-col gap-1.5">
        <label id={`${id}-security`} className="text-sm font-medium text-foreground">
          Security
        </label>
        <Select
          value={security}
          onValueChange={(next) => {
            const value = next as SmtpSecurity;
            if (port === String(defaultSmtpPort(security))) setPort(String(defaultSmtpPort(value)));
            setSecurity(value);
          }}
        >
          <SelectTrigger aria-labelledby={`${id}-security`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="tls">TLS (usually port 465)</SelectItem>
            <SelectItem value="starttls">STARTTLS (usually port 587)</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor={`${id}-username`} className="text-sm font-medium text-foreground">
          Username
        </label>
        <Input
          id={`${id}-username`}
          value={username}
          placeholder={account.username}
          onChange={(e) => setUsername(e.target.value)}
        />
        <p className="text-xs text-muted-foreground">Leave empty to use the IMAP username.</p>
      </div>
      {outcome !== null ? (
        <p
          role={outcome.kind === "error" ? "alert" : "status"}
          className={outcome.kind === "error" ? "text-sm text-destructive" : "text-sm text-muted-foreground"}
        >
          {outcome.message}
        </p>
      ) : null}
      <DialogFooter>
        <Button type="button" variant="ghost" size="sm" onClick={onClose} disabled={busy !== null}>
          Cancel
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={() => void run("test")} disabled={busy !== null}>
          {busy === "test" ? "Testing…" : "Test"}
        </Button>
        <Button type="submit" size="sm" disabled={busy !== null}>
          {busy === "save" ? "Saving…" : "Save"}
        </Button>
      </DialogFooter>
    </form>
  );
}
