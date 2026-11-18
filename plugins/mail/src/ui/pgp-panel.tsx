// OpenPGP in a message (slice 3k): Decrypt for an encrypted message, Check
// signature for a signed one. The decrypted text lives in this component's
// state only: it is shown as plain text, never stored, and gone when the
// message closes. Everything from the message is rendered as text.
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { htmlToPlainText } from "./sanitize.ts";
import { tx } from "./i18n/index.ts";

export type PgpSignatureShown = {
  state: "valid" | "invalid" | "no_cert";
  fingerprint: string | null;
  signer: string | null;
  fromSender: boolean;
};

export type PgpOpenedShown = {
  state: "opened" | "no_cert" | "not_pgp" | "failed";
  text: string | null;
  html: string | null;
  attachments: { fileName: string; size: number }[];
  signature: PgpSignatureShown | null;
};

export type PgpVerifiedShown = {
  state: "valid" | "invalid" | "no_cert" | "not_pgp" | "failed";
  fingerprint: string | null;
  signer: string | null;
  fromSender: boolean;
};

export interface PgpReadingPorts {
  open: (messageId: string) => Promise<PgpOpenedShown>;
  verify: (messageId: string) => Promise<PgpVerifiedShown>;
  /** Saves the public keys the message carries; returns how many were added. */
  importFromMessage: (messageId: string) => Promise<number>;
}

/** A fingerprint in groups of four, for reading aloud. */
export function fingerprintShown(fingerprint: string): string {
  return fingerprint.replace(/(.{4})(?=.)/g, "$1 ");
}

/** What a signature check means, in one sentence. */
export function signatureText(signature: PgpSignatureShown): string {
  if (signature.state === "valid") {
    return signature.fromSender
      ? tx("Signed by a key you saved for this sender.")
      : tx("Signed by a key you saved, but not for this sender's address.");
  }
  if (signature.state === "invalid") return tx("The signature does not match this message. It may have been changed.");
  return tx("Signed, but Mail has no key for the signer, so it cannot be checked.");
}

const failureText = (state: "no_cert" | "not_pgp" | "failed", what: "open" | "verify"): string => {
  if (state === "not_pgp") return tx("This message is not in a form Mail can read with OpenPGP.");
  if (state === "no_cert" && what === "open") return tx("None of your OpenPGP keys opens this message.");
  return what === "open" ? tx("The message could not be decrypted.") : tx("The signature could not be checked.");
};

function SignatureLine({ signature }: { signature: PgpSignatureShown }) {
  const good = signature.state === "valid" && signature.fromSender;
  return (
    <p role="status" className={signature.state === "invalid" ? "text-xs text-destructive" : "text-xs text-muted-foreground"}>
      <Icon name={good ? "ShieldCheck" : "Shield"} fallback="Info" className="mr-1 inline size-3.5" aria-hidden />
      {signatureText(signature)}
      {signature.fingerprint !== null ? (
        <span className="ml-1 font-mono">{fingerprintShown(signature.fingerprint)}</span>
      ) : signature.signer !== null ? (
        <span className="ml-1 font-mono">{signature.signer}</span>
      ) : null}
    </p>
  );
}

export function PgpPanel({
  messageId,
  mode,
  ports,
}: {
  messageId: string;
  /** `encrypted`: offer Decrypt; `signed`: offer Check signature. */
  mode: "encrypted" | "signed";
  ports: PgpReadingPorts;
}) {
  const [busy, setBusy] = useState(false);
  const [opened, setOpened] = useState<PgpOpenedShown | null>(null);
  const [verified, setVerified] = useState<PgpVerifiedShown | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  // Another message: nothing of the last one stays.
  useEffect(() => {
    setOpened(null);
    setVerified(null);
    setProblem(null);
    setNote(null);
    setBusy(false);
  }, [messageId]);

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setProblem(null);
    setNote(null);
    try {
      await work();
    } catch (error) {
      setProblem(tx(error instanceof Error && error.message !== "" ? error.message : "The request failed; try again"));
    } finally {
      setBusy(false);
    }
  };

  const decrypt = () =>
    run(async () => {
      const result = await ports.open(messageId);
      if (result.state === "opened") setOpened(result);
      else setProblem(failureText(result.state, "open"));
    });
  const check = () =>
    run(async () => {
      const result = await ports.verify(messageId);
      if (result.state === "not_pgp" || result.state === "failed") setProblem(failureText(result.state, "verify"));
      else setVerified(result);
    });
  const saveKey = () =>
    run(async () => {
      const added = await ports.importFromMessage(messageId);
      setNote(added > 0 ? tx("Saved the sender's key. Check the signature again.") : tx("This message carries no OpenPGP key."));
    });

  const text =
    opened === null ? null : (opened.text ?? (opened.html !== null ? htmlToPlainText(opened.html) : tx("This message has no text.")));
  const unknownSigner =
    (verified !== null && verified.state === "no_cert") || (opened?.signature != null && opened.signature.state === "no_cert");

  return (
    <div data-pgp-panel={mode} className="flex flex-col gap-2 rounded-md border border-border bg-muted px-2 py-2 text-sm">
      {mode === "encrypted" && opened === null ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="min-w-0 flex-1 text-muted-foreground">
            {tx("This message is encrypted with OpenPGP. Mail decrypts it on this computer and keeps no copy of the text.")}
          </span>
          <Button variant="outline" size="sm" disabled={busy} onClick={() => void decrypt()}>
            {busy ? tx("Decrypting…") : tx("Decrypt")}
          </Button>
        </div>
      ) : null}
      {mode === "signed" && verified === null ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="min-w-0 flex-1 text-muted-foreground">{tx("This message is signed with OpenPGP.")}</span>
          <Button variant="outline" size="sm" disabled={busy} onClick={() => void check()}>
            {busy ? tx("Checking…") : tx("Check signature")}
          </Button>
        </div>
      ) : null}
      {verified !== null && verified.state !== "not_pgp" && verified.state !== "failed" ? (
        <SignatureLine signature={{ ...verified, state: verified.state }} />
      ) : null}
      {opened !== null ? (
        <>
          <p className="text-xs text-muted-foreground">
            {tx("Decrypted for this view only. Agents, AI features and search never see this text.")}
          </p>
          {opened.signature !== null ? <SignatureLine signature={opened.signature} /> : null}
          <pre
            aria-label={tx("Decrypted message")}
            className="max-h-[60vh] overflow-auto whitespace-pre-wrap break-words rounded-md bg-background p-2 font-sans text-sm text-foreground"
          >
            {text}
          </pre>
          {opened.attachments.length > 0 ? (
            <p className="text-xs text-muted-foreground">
              {tx("Attachments inside (not available here yet): {names}", {
                names: opened.attachments.map((a) => a.fileName || tx("Unnamed attachment")).join(", "),
              })}
            </p>
          ) : null}
        </>
      ) : null}
      {unknownSigner ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="min-w-0 flex-1 text-xs text-muted-foreground">
            {tx("If the sender attached their key to this message, Mail can save it. Compare the fingerprint with the sender another way before you trust it.")}
          </span>
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => void saveKey()}>
            {tx("Save the key from this message")}
          </Button>
        </div>
      ) : null}
      {note !== null ? <p role="status" className="text-xs text-muted-foreground">{note}</p> : null}
      {problem !== null ? <p role="alert" className="text-xs text-destructive">{problem}</p> : null}
    </div>
  );
}
