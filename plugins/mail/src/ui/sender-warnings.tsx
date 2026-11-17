// Sender warnings (slice 3i, #39): the strip for a failed sender check and
// the quieter lines for a disguised sender. Fixed words; the domains and
// addresses are the sender's, shown as data in code-like spans, never links.
// A pass is never shown here (decision 6): Details carries the results.
import type { ReactNode } from "react";
import { Icon } from "@/components/ui/icon";
import type { DisguiseWarning, MessageHeader, SenderCheckView } from "../core/index.ts";
import { addressDomain, autoImagesAllowed } from "../core/sender-basics.ts";
import { shownText } from "./agent-send-card.tsx";
import { msg, tx } from "./i18n/index.ts";

/** The header's 3i fields with their defaults (MessageHeader keeps them optional). */
export function securityOf(message: Pick<MessageHeader, "senderCheck" | "warnings" | "receiptRequested" | "crypto">): {
  check: SenderCheckView;
  warnings: DisguiseWarning[];
  receiptRequested: boolean;
  crypto: NonNullable<MessageHeader["crypto"]> | null;
} {
  return {
    check: message.senderCheck ?? { state: "unknown", summary: null },
    warnings: message.warnings ?? [],
    receiptRequested: message.receiptRequested ?? false,
    crypto: message.crypto ?? null,
  };
}

/** A failed check or any disguise warning (the stack's "sender warning" marker, I6). */
export function hasSenderWarning(message: Pick<MessageHeader, "senderCheck" | "warnings">): boolean {
  const { check, warnings } = securityOf(message);
  return check.state === "failed" || warnings.length > 0;
}

/**
 * Why an always-show sender's images wait (part A resolution 5), or null when
 * they may load by themselves. The first reason that applies.
 */
export function imagesHeldReason(message: Pick<MessageHeader, "senderCheck" | "warnings">): string | null {
  const { check, warnings } = securityOf(message);
  if (autoImagesAllowed(check, warnings)) return null;
  if (check.state === "failed") return "the sender check failed";
  if (warnings.some((w) => w.kind === "lookalike")) return "the domain looks like another";
  if (warnings.some((w) => w.kind === "name_shows_address")) return "the name shows another address";
  return "the sender check has not run yet";
}

function Value({ children }: { children: string }) {
  return <span className="break-all rounded-sm bg-muted px-1 font-mono text-foreground">{shownText(children)}</span>;
}

function warningLine(warning: DisguiseWarning, fromDomain: string | null): ReactNode {
  switch (warning.kind) {
    case "reply_to_elsewhere":
      return (
        <>
          {tx("Replies go to ")}
          {warning.addresses.map((address, index) => (
            <span key={address}>
              {index > 0 ? ", " : null}
              <Value>{address}</Value>
            </span>
          ))}
          {fromDomain !== null ? (
            <>
              {tx(", not to ")}
              <Value>{fromDomain}</Value>
              {"."}
            </>
          ) : (
            tx(", not to the sender.")
          )}
        </>
      );
    case "lookalike":
      return (
        <>
          <Value>{warning.domain}</Value>
          {tx(" looks like ")}
          <Value>{warning.like}</Value>
          {tx(", which you write to.")}
        </>
      );
    case "mixed_script":
      return (
        <>
          {tx("This domain mixes alphabets: ")}
          <Value>{warning.domain}</Value>
          {tx(" (shown as it really is).")}
        </>
      );
    case "name_shows_address":
      return (
        <>
          {tx("The name shows ")}
          <Value>{warning.shown}</Value>
          {tx(" but the address is ")}
          <Value>{warning.actual}</Value>
          {"."}
        </>
      );
  }
}

/** The strip (failed check) and the warning lines of one expanded message; nothing when there is neither. */
export function SenderWarnings({ message }: { message: Pick<MessageHeader, "from" | "senderCheck" | "warnings"> }) {
  const { check, warnings } = securityOf(message);
  const fromDomain = addressDomain(message.from.address);
  if (check.state !== "failed" && warnings.length === 0) return null;
  return (
    <div className="flex flex-col gap-1">
      {check.state === "failed" ? (
        <div
          role="note"
          aria-label={tx("Sender not verified")}
          className="flex items-start gap-2 rounded-md border border-destructive/60 bg-destructive/10 px-2 py-1.5 text-xs text-foreground"
        >
          <Icon name="AlertTriangle" className="mt-0.5 size-3.5 shrink-0 text-destructive" aria-hidden />
          <span className="min-w-0">
            <strong className="font-semibold">{tx("Sender not verified.")}</strong>
            {/* The words end before the space: a quote after "from" and a space reads as an import to tests/architecture. */}
            {tx(" Your mail provider could not confirm this came from")}
            {" "}
            {fromDomain !== null ? <Value>{fromDomain}</Value> : tx("this sender")}
            {check.summary !== null ? ` (${check.summary})` : ""}
            {tx(". Don't trust links or requests in it.")}
          </span>
        </div>
      ) : null}
      {warnings.length > 0 ? (
        <ul aria-label={tx("Sender warnings")} className="flex flex-col gap-0.5 text-xs text-foreground">
          {warnings.map((warning, index) => (
            <li key={`${warning.kind}-${index}`} className="flex items-start gap-1.5">
              <Icon name="AlertTriangle" className="mt-0.5 size-3.5 shrink-0 text-destructive" aria-hidden />
              <span className="min-w-0">{warningLine(warning, fromDomain)}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

const CRYPTO_LABELS: Record<NonNullable<MessageHeader["crypto"]>["kind"], { label: string; title: string }> = {
  pgp_signed: { label: msg("Signed (PGP)"), title: msg("Mail does not check signatures") },
  smime_signed: { label: msg("Signed (S/MIME)"), title: msg("Mail does not check signatures") },
  pgp_encrypted: { label: msg("Encrypted (PGP)"), title: msg("Mail cannot read it") },
  smime_encrypted: { label: msg("Encrypted (S/MIME)"), title: msg("Mail cannot read it") },
};

/** The neutral chip for signed or encrypted mail (#92, #97 partial). */
export function CryptoChip({ crypto }: { crypto: NonNullable<MessageHeader["crypto"]> }) {
  const { label, title } = CRYPTO_LABELS[crypto.kind];
  return (
    <span title={title} aria-label={`${label}: ${title}`} className="shrink-0 rounded-sm border border-border px-1 text-xs text-muted-foreground">
      {label}
    </span>
  );
}

export const ENCRYPTED_BODY_TEXT = "This message is encrypted. Open it in a mail client that has your key.";
export const OPAQUE_SIGNED_BODY_TEXT = "This signed message's text is inside the signature. Open it in a mail client that reads S/MIME.";
export const RECEIPT_TEXT = "The sender asked for a read receipt. Makosh Mail does not send receipts.";

/** The body placeholder for encrypted and opaque-signed mail; null when the body shows. */
export function cryptoPlaceholder(crypto: MessageHeader["crypto"] | null | undefined): string | null {
  if (crypto == null) return null;
  if (crypto.kind === "pgp_encrypted" || crypto.kind === "smime_encrypted") return ENCRYPTED_BODY_TEXT;
  if (crypto.kind === "smime_signed" && crypto.opaque) return OPAQUE_SIGNED_BODY_TEXT;
  return null;
}
