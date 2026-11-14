import type { StatusView } from "../core/index.ts";

export interface MailPageProps {
  /** null while the first load is in flight. */
  status: StatusView | null;
  error: string | null;
}

/**
 * The Mail page body. It takes data through props and knows nothing about
 * the host, so the same component renders in BB and in any other shell.
 */
export function MailPage({ status, error }: MailPageProps) {
  return (
    <div className="h-full min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto box-border w-full max-w-3xl px-4 pb-4 pt-3 md:px-5 md:pt-4">
        {error !== null ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : (
          <div
            role="status"
            className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground"
          >
            {status === null ? "Loading mail…" : "Mail is being set up."}
          </div>
        )}
      </div>
    </div>
  );
}
