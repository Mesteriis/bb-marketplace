// What the Mail page shows when there is nothing to list or read yet.
import type { ReactNode } from "react";
import { Icon } from "@/components/ui/icon";

/** The command that sets the credential key (the server's needs-configuration message names the same). */
export const CONFIGURE_VAULT_COMMAND =
  "bb plugin config makosh-mail set vaultKey <32-byte base64 key>";
export const RELOAD_COMMAND = "bb plugin reload makosh-mail";

interface EmptyStateProps {
  icon?: string;
  title: string;
  children?: ReactNode;
  role?: "status" | "alert";
}

export function EmptyState({ icon, title, children, role = "status" }: EmptyStateProps) {
  return (
    <div
      role={role}
      className="mx-auto flex max-w-md flex-col items-center gap-2 px-4 py-10 text-center"
    >
      {icon !== undefined ? (
        <Icon name={icon} className="size-6 text-muted-foreground" aria-hidden />
      ) : null}
      <p className="text-sm font-medium text-foreground">{title}</p>
      {children !== undefined ? (
        <div className="text-sm text-muted-foreground">{children}</div>
      ) : null}
    </div>
  );
}

export function LoadingState({ label }: { label: string }) {
  return (
    <p role="status" className="py-2 text-sm text-muted-foreground">
      {label}
    </p>
  );
}

function Command({ children }: { children: string }) {
  return (
    <code className="block select-all whitespace-pre-wrap break-all rounded-md border border-border bg-card px-3 py-2 text-left font-mono text-xs text-foreground">
      {children}
    </code>
  );
}

export function VaultNotReady() {
  return (
    <EmptyState icon="Lock" title="Mail needs a credential key">
      <div className="flex flex-col gap-2">
        <p>Account passwords are encrypted with a key that is not set. Run:</p>
        <Command>{CONFIGURE_VAULT_COMMAND}</Command>
        <p>then:</p>
        <Command>{RELOAD_COMMAND}</Command>
      </div>
    </EmptyState>
  );
}

export function SyncingState() {
  return (
    <EmptyState icon="Mail" title="Syncing your mail…">
      Messages appear here as they arrive.
    </EmptyState>
  );
}

export function SyncErrorState({ message }: { message: string }) {
  return (
    <EmptyState icon="CloudOff" title="Mail could not sync" role="alert">
      {message}
    </EmptyState>
  );
}

export function EmptyFolder({ name }: { name: string }) {
  return (
    <EmptyState icon="MailOpen" title="No mail">
      Nothing in {name} for the period Mail syncs.
    </EmptyState>
  );
}

export function NoSearchResults({ query }: { query: string }) {
  return <EmptyState icon="Search" title={`No messages match “${query}”`} />;
}

export function NothingSelected() {
  return <EmptyState icon="Mail" title="Select a conversation to read it" />;
}
