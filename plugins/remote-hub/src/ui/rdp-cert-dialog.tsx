// The certificate decision dialog. The decision always names the certificate
// that was PRESENTED: the dialog binds `prompt.fingerprint` itself, so the
// callback has no way to be given another one. Nothing is preselected, focus
// starts on the dialog (not on a button that accepts), Enter on the dialog does
// nothing, and Escape is Reject.
import { useEffect, useRef } from "react";
import type { RdpCertPromptInfo, RdpDecision } from "../core/rpc.ts";
import { formatCertTime, promptReasonText } from "../core/rdp-texts.ts";

export interface RdpCertDialogProps {
  prompt: RdpCertPromptInfo;
  /** Called with the presented fingerprint and the user's choice. */
  onDecide: (fingerprint: string, accept: RdpDecision) => void;
  disabled?: boolean;
}

export function RdpCertDialog(props: RdpCertDialogProps) {
  const { prompt, onDecide, disabled = false } = props;
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    ref.current?.focus();
  }, [prompt.fingerprint]);

  const decide = (accept: RdpDecision): void => {
    if (!disabled) onDecide(prompt.fingerprint, accept);
  };

  return (
    <div
      ref={ref}
      className="rh-rdp-cert"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="rh-rdp-cert-title"
      aria-describedby="rh-rdp-cert-reason"
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          decide("reject");
        } else if (event.key === "Enter" && event.target === event.currentTarget) {
          event.preventDefault(); // Enter never accepts
        }
      }}
    >
      <h3 id="rh-rdp-cert-title">Trust this server certificate?</h3>
      <p id="rh-rdp-cert-reason" className={prompt.reason === "cert_changed" ? "rh-error" : undefined}>
        {promptReasonText(prompt.reason)}
      </p>
      <dl className="rh-rdp-cert-fields">
        <dt>server</dt>
        <dd>
          {prompt.host}:{prompt.port}
        </dd>
        <dt>fingerprint (SHA-256)</dt>
        <dd data-testid="rdp-cert-fingerprint" className="rh-rdp-fingerprint">
          {prompt.fingerprint}
        </dd>
        <dt>subject</dt>
        <dd data-testid="rdp-cert-subject">{prompt.subject}</dd>
        <dt>issuer</dt>
        <dd data-testid="rdp-cert-issuer">{prompt.issuer === "" ? "(empty issuer)" : prompt.issuer}</dd>
        <dt>valid</dt>
        <dd data-testid="rdp-cert-valid">
          {formatCertTime(prompt.notBefore)} to {formatCertTime(prompt.notAfter)}
        </dd>
      </dl>
      <div className="rh-rdp-cert-actions">
        <button type="button" onClick={() => decide("once")} disabled={disabled}>
          Accept once
        </button>
        <button type="button" onClick={() => decide("session_trust")} disabled={disabled}>
          Trust for this BB run
        </button>
        <button type="button" onClick={() => decide("reject")} disabled={disabled}>
          Reject
        </button>
      </div>
    </div>
  );
}
