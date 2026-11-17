// OpenPGP keys in Mail settings (slice 3k): a key for each sending address
// (made here, on this computer), the keys of people the owner writes to,
// and a backup of an own key locked by a passphrase the owner types. The
// page never receives a private key that is not locked by that passphrase.
import { useCallback, useEffect, useState } from "react";
import type { IdentityView } from "../core/index.ts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { fingerprintShown } from "./pgp-panel.tsx";
import { dateLocale, tx } from "./i18n/index.ts";

export type PgpCertShown = {
  id: string;
  kind: "own" | "contact";
  fingerprint: string;
  addresses: string[];
  userIds: string[];
  createdAt: string;
  expiresAt: string | null;
  addedAt: string;
  source: "generated" | "imported" | "message";
  expired: boolean;
};

export type PgpImportShown = "added" | "exists" | "full" | "unreadable" | "locked" | "wrong_phrase" | "revoked";

export interface SettingsPgpPorts {
  list: () => Promise<{ certs: PgpCertShown[]; vaultReady: boolean }>;
  generate: (accountId: string, address: string) => Promise<void>;
  importArmor: (armor: string, phrase?: string) => Promise<{ result: PgpImportShown; added: PgpCertShown[] }>;
  remove: (id: string) => Promise<void>;
  /** The public key; with a passphrase, the private key locked by it. */
  exportArmor: (id: string, phrase?: string) => Promise<{ armor: string; fileName: string }>;
}

/** What an import ended with, in words. */
export function importResultText(result: PgpImportShown, added: number): string {
  switch (result) {
    case "added":
      return added === 1 ? tx("Saved 1 key.") : tx("Saved {added} keys.", { added });
    case "exists":
      return tx("Mail already has this key.");
    case "full":
      return tx("Mail keeps at most 500 keys; remove some first.");
    case "locked":
      return tx("This is a private key locked by a passphrase. Type the passphrase and import again.");
    case "wrong_phrase":
      return tx("The passphrase does not open this key.");
    case "revoked":
      return tx("This key was revoked by its owner and was not saved.");
    case "unreadable":
      return tx("This is not an OpenPGP key Mail can read, or it names no email address.");
  }
}

const BACKUP_PHRASE_MIN = 8;

function day(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString(dateLocale(), { dateStyle: "medium" });
}

function KeyRow({
  cert,
  busy,
  onExport,
  onBackup,
  onRemove,
}: {
  cert: PgpCertShown;
  busy: boolean;
  onExport: () => void;
  onBackup?: () => void;
  onRemove: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const label = cert.addresses.join(", ");
  return (
    <li aria-label={label} className="flex flex-col gap-1 rounded-md border border-border px-2 py-1.5">
      <span className="truncate text-sm text-foreground">{label}</span>
      <span className="break-all font-mono text-xs text-muted-foreground">{fingerprintShown(cert.fingerprint)}</span>
      <span className="text-xs text-muted-foreground">
        {tx("Made {made}", { made: day(cert.createdAt) })}
        {cert.expiresAt !== null ? ` · ${cert.expired ? tx("expired {when}", { when: day(cert.expiresAt) }) : tx("expires {when}", { when: day(cert.expiresAt) })}` : ""}
      </span>
      <div className="flex flex-wrap gap-1">
        <Button variant="outline" size="sm" className="h-7 px-2" disabled={busy} onClick={onExport}>
          {tx("Show public key")}
        </Button>
        {onBackup !== undefined ? (
          <Button variant="outline" size="sm" className="h-7 px-2" disabled={busy} onClick={onBackup}>
            {tx("Back up…")}
          </Button>
        ) : null}
        {confirming ? (
          <>
            <Button variant="outline" size="sm" className="h-7 px-2 text-destructive" disabled={busy} onClick={onRemove}>
              {cert.kind === "own" ? tx("Yes, remove my key") : tx("Yes, remove")}
            </Button>
            <Button variant="ghost" size="sm" className="h-7 px-2" onClick={() => setConfirming(false)}>
              {tx("Cancel")}
            </Button>
          </>
        ) : (
          <Button variant="ghost" size="sm" className="h-7 px-2" disabled={busy} onClick={() => setConfirming(true)}>
            {tx("Remove")}
          </Button>
        )}
      </div>
      {confirming && cert.kind === "own" ? (
        <p className="text-xs text-destructive">
          {tx("Without this key and without a backup, mail encrypted to it can never be read again.")}
        </p>
      ) : null}
    </li>
  );
}

export function PgpSettings({ ports, identities }: { ports: SettingsPgpPorts; identities: readonly IdentityView[] }) {
  const [certs, setCerts] = useState<PgpCertShown[] | null>(null);
  const [vaultReady, setVaultReady] = useState(true);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [armor, setArmor] = useState("");
  const [phrase, setPhrase] = useState("");
  const [shown, setShown] = useState<{ title: string; armor: string; fileName: string } | null>(null);
  const [backup, setBackup] = useState<{ id: string; phrase: string } | null>(null);

  const load = useCallback(async () => {
    const listed = await ports.list();
    setCerts(listed.certs);
    setVaultReady(listed.vaultReady);
  }, [ports]);

  useEffect(() => {
    load().catch((error: unknown) =>
      setProblem(tx(error instanceof Error && error.message !== "" ? error.message : "The keys could not be loaded")),
    );
  }, [load]);

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setProblem(null);
    setNote(null);
    try {
      await work();
      await load();
    } catch (error) {
      setProblem(tx(error instanceof Error && error.message !== "" ? error.message : "The request failed; try again"));
    } finally {
      setBusy(false);
    }
  };

  const own = (certs ?? []).filter((cert) => cert.kind === "own");
  const contacts = (certs ?? []).filter((cert) => cert.kind === "contact");
  const without = identities.filter(
    (identity) => !own.some((cert) => !cert.expired && cert.addresses.includes(identity.address.toLowerCase())),
  );

  return (
    <div className="flex flex-col gap-4 text-sm">
      <p className="text-muted-foreground">
        {tx("OpenPGP signs and encrypts mail between people who exchanged keys. Your private keys are made and kept on this computer, sealed with the same key as your passwords; agents and AI features never get them or the text of encrypted mail.")}
      </p>
      {!vaultReady ? (
        <p role="alert" className="text-destructive">{tx("Mail needs a credential key before it can keep OpenPGP keys.")}</p>
      ) : null}

      <section aria-label={tx("Your keys")} className="flex flex-col gap-2">
        <h3 className="text-sm font-medium text-foreground">{tx("Your keys")}</h3>
        {certs === null ? <p className="text-muted-foreground">{tx("Loading…")}</p> : null}
        {own.length > 0 ? (
          <ul className="flex flex-col gap-1">
            {own.map((cert) => (
              <KeyRow
                key={cert.id}
                cert={cert}
                busy={busy}
                onExport={() =>
                  void run(async () => {
                    const exported = await ports.exportArmor(cert.id);
                    setShown({ title: tx("Public key: send it to people who should write to you encrypted"), ...exported });
                  })
                }
                onBackup={() => setBackup({ id: cert.id, phrase: "" })}
                onRemove={() => void run(() => ports.remove(cert.id))}
              />
            ))}
          </ul>
        ) : null}
        {without.map((identity) => (
          <div key={`${identity.accountId}:${identity.address}`} className="flex flex-wrap items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-muted-foreground">
              {tx("{address} has no key", { address: identity.address })}
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={busy || !vaultReady}
              onClick={() =>
                void run(async () => {
                  await ports.generate(identity.accountId, identity.address);
                  setNote(tx("The key is made. Back it up: without a backup, losing this computer loses the key."));
                })
              }
            >
              {busy ? tx("Working…") : tx("Make a key")}
            </Button>
          </div>
        ))}
      </section>

      {backup !== null ? (
        <section aria-label={tx("Back up a key")} className="flex flex-col gap-2 rounded-md border border-border p-2">
          <h3 className="text-sm font-medium text-foreground">{tx("Back up a key")}</h3>
          <p className="text-xs text-muted-foreground">
            {tx("Type a passphrase of at least 8 characters. The backup is your private key locked by it; keep the file and the passphrase apart. Mail does not keep the passphrase.")}
          </p>
          <Input
            type="password"
            autoComplete="new-password"
            aria-label={tx("Backup passphrase")}
            value={backup.phrase}
            onChange={(event) => setBackup({ id: backup.id, phrase: event.target.value })}
            className="h-8"
          />
          <div className="flex gap-1">
            <Button
              variant="outline"
              size="sm"
              disabled={busy || backup.phrase.length < BACKUP_PHRASE_MIN}
              onClick={() =>
                void run(async () => {
                  const exported = await ports.exportArmor(backup.id, backup.phrase);
                  setBackup(null);
                  setShown({ title: tx("Private key backup, locked by your passphrase"), ...exported });
                })
              }
            >
              {tx("Make the backup")}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setBackup(null)}>
              {tx("Cancel")}
            </Button>
          </div>
        </section>
      ) : null}

      {shown !== null ? (
        <section aria-label={shown.title} className="flex flex-col gap-2 rounded-md border border-border p-2">
          <h3 className="text-sm font-medium text-foreground">{shown.title}</h3>
          <textarea
            readOnly
            aria-label={shown.fileName}
            value={shown.armor}
            rows={8}
            className="w-full rounded-md border border-input bg-background p-2 font-mono text-xs text-foreground"
            onFocus={(event) => event.currentTarget.select()}
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard;
                if (clipboard === undefined) return setNote(tx("Select the text and copy it."));
                clipboard.writeText(shown.armor).then(
                  () => setNote(tx("Copied")),
                  () => setNote(tx("Select the text and copy it.")),
                );
              }}
            >
              {tx("Copy")}
            </Button>
            <span className="text-xs text-muted-foreground">{tx("Save it as {fileName}", { fileName: shown.fileName })}</span>
            <Button variant="ghost" size="sm" onClick={() => setShown(null)}>
              {tx("Close")}
            </Button>
          </div>
        </section>
      ) : null}

      <section aria-label={tx("Keys of people you write to")} className="flex flex-col gap-2">
        <h3 className="text-sm font-medium text-foreground">{tx("Keys of people you write to")}</h3>
        {certs !== null && contacts.length === 0 ? (
          <p className="text-muted-foreground">{tx("None yet. Paste a public key below, or save one from a signed message.")}</p>
        ) : null}
        <ul className="flex flex-col gap-1">
          {contacts.map((cert) => (
            <KeyRow
              key={cert.id}
              cert={cert}
              busy={busy}
              onExport={() =>
                void run(async () => {
                  const exported = await ports.exportArmor(cert.id);
                  setShown({ title: tx("Public key"), ...exported });
                })
              }
              onRemove={() => void run(() => ports.remove(cert.id))}
            />
          ))}
        </ul>
      </section>

      <section aria-label={tx("Add a key")} className="flex flex-col gap-2">
        <h3 className="text-sm font-medium text-foreground">{tx("Add a key")}</h3>
        <p className="text-xs text-muted-foreground">
          {tx("Paste a public key someone gave you. Compare its fingerprint with them another way (a call, in person) before you rely on it. To restore your own key, paste its backup and type the passphrase.")}
        </p>
        <textarea
          aria-label={tx("Key text")}
          value={armor}
          onChange={(event) => setArmor(event.target.value)}
          rows={5}
          spellCheck={false}
          placeholder="-----BEGIN PGP PUBLIC KEY BLOCK-----"
          className="w-full rounded-md border border-input bg-background p-2 font-mono text-xs text-foreground"
        />
        <Input
          type="password"
          autoComplete="off"
          aria-label={tx("Passphrase (only for a backup of your own key)")}
          placeholder={tx("Passphrase (only for a backup of your own key)")}
          value={phrase}
          onChange={(event) => setPhrase(event.target.value)}
          className="h-8"
        />
        <div>
          <Button
            variant="outline"
            size="sm"
            disabled={busy || armor.trim() === ""}
            onClick={() =>
              void run(async () => {
                const outcome = await ports.importArmor(armor, phrase === "" ? undefined : phrase);
                if (outcome.result === "added") {
                  setArmor("");
                  setPhrase("");
                  setNote(importResultText("added", outcome.added.length));
                } else {
                  setProblem(importResultText(outcome.result, 0));
                }
              })
            }
          >
            {tx("Add key")}
          </Button>
        </div>
      </section>

      {note !== null ? <p role="status" className="text-muted-foreground">{note}</p> : null}
      {problem !== null ? <p role="alert" className="text-destructive">{problem}</p> : null}
    </div>
  );
}
