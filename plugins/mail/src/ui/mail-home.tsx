import type { ReactNode } from "react";
import type { MailOverview } from "../core/index.ts";

export interface MailHomeProps {
  /** null while the first load is in flight. */
  overview: MailOverview | null;
  error: string | null;
}

function Notice({ children }: { children: ReactNode }) {
  return (
    <div
      role="status"
      className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground"
    >
      {children}
    </div>
  );
}

/**
 * The Mail page body. It takes data through props and knows nothing about
 * the host, so the same component renders in BB and in any other shell.
 */
export function MailHome({ overview, error }: MailHomeProps) {
  return (
    <div className="h-full min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto box-border w-full max-w-3xl px-4 pb-4 pt-3 md:px-5 md:pt-4">
        {error !== null ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : overview === null ? (
          <Notice>Loading mail accounts…</Notice>
        ) : overview.accounts.length === 0 ? (
          <Notice>
            No mail account is connected. This pre-release cannot connect one
            yet.
          </Notice>
        ) : (
          <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card px-4">
            {overview.accounts.map((account) => (
              <li key={account.id} className="flex items-baseline gap-3 py-2.5 text-sm">
                <span className="min-w-0 flex-1 truncate">
                  {account.displayName ?? account.address}
                </span>
                {account.displayName === undefined ? null : (
                  <span className="truncate text-xs text-muted-foreground">
                    {account.address}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
