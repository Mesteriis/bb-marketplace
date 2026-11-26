import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { LoadState } from "./use-load";

export function Badge({ children, tone = "plain" }: { children: ReactNode; tone?: "plain" | "outline" | "danger" }) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded px-1.5 py-0.5 text-xs",
        tone === "plain" && "bg-secondary text-secondary-foreground",
        tone === "outline" && "border border-input text-muted-foreground",
        tone === "danger" && "bg-secondary text-destructive",
      )}
    >
      {children}
    </span>
  );
}

export function Notice({ children, danger = false }: { children: ReactNode; danger?: boolean }) {
  return (
    <p className={cn("rounded-md border border-border px-3 py-2 text-xs", danger ? "text-destructive" : "text-muted-foreground")}>
      {children}
    </p>
  );
}

export function Centered({ children }: { children: ReactNode }) {
  return <div className="flex flex-col items-center justify-center gap-2 p-8 text-center text-sm text-muted-foreground">{children}</div>;
}

/** Loading, error and ready states of one tab; `children` renders only with data. */
export function LoadView<T>({
  state,
  onRetry,
  children,
}: {
  state: LoadState<T>;
  onRetry: () => void;
  children: (data: T) => ReactNode;
}) {
  if (state.kind === "loading") return <Centered>Загрузка…</Centered>;
  if (state.kind === "error") {
    return (
      <Centered>
        <p className="text-destructive">{state.message}</p>
        <Button variant="outline" size="sm" onClick={onRetry}>
          Повторить
        </Button>
      </Centered>
    );
  }
  return <>{children(state.data)}</>;
}

export function Row({ children }: { children: ReactNode }) {
  return <li className="flex flex-col gap-1 border-b border-border px-4 py-2.5 last:border-b-0">{children}</li>;
}
