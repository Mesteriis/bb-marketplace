// The third way out of a conflict: hand the merge to an agent in a bb thread.
//
// The other two ways out are "keep mine" (do nothing) and "replace with
// upstream" (destroys the edit, with a backup). This one asks an agent to
// combine both sides, and the agent works in a real thread the user can read
// and answer, because a merge that hits a genuine collision has to ask.
//
// The safety property this whole component is arranged around: the merge is
// staged outside the skills folder, so until the user presses Accept nothing
// on disk has changed. Every state below says so in words.
import type { ReactNode } from "react";
import { ThreadChat } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { SkillDiff, type DiffState } from "./skill-diff";
import type { Merge } from "./model";

/** Height of the embedded conversation; `contained` scrolls inside it. */
const CHAT_HEIGHT = "h-[24rem]";

export function ConflictMerge({
  name,
  merge,
  diff,
  busy,
  onStart,
  onAccept,
  onCancel,
  onDiscard,
  onRetryDiff,
  onDismissFailure,
}: {
  name: string;
  /** Undefined until the first `mergeState` answer arrives; read as "none". */
  merge: Merge | undefined;
  /** The staged merge against what is installed, fetched once it is ready. */
  diff: DiffState | undefined;
  busy: boolean;
  onStart: () => void;
  onAccept: () => void;
  /** Stop the agent and throw its work away, back to an unresolved conflict. */
  onCancel: () => void;
  onDiscard: () => void;
  onRetryDiff: () => void;
  /** Clear a failed merge and go back to the two original choices. */
  onDismissFailure: () => void;
}) {
  const state = merge?.state ?? "none";

  if (state === "none") {
    return (
      <div className="space-y-2">
        <p className="text-xs text-muted-foreground">
          An agent can merge both sides for you, in a thread you can read and
          reply to. It stops and asks when the two versions really collide.
          Nothing is written to your skills folder until you accept the result.
        </p>
        <Button variant="outline" size="sm" onClick={onStart} disabled={busy}>
          {busy ? (
            <Icon name="Spinner" className="size-4 animate-spin" aria-hidden />
          ) : (
            <Icon name="GitMerge" className="size-4" aria-hidden />
          )}
          Merge {name} with an agent
        </Button>
      </div>
    );
  }

  return (
    <section
      aria-label={`Agent merge for ${name}`}
      className="space-y-2 rounded-md border border-border p-3"
    >
      {state === "running" ? (
        <Header
          icon={<Icon name="Spinner" className="size-4 animate-spin" aria-hidden />}
          title={`An agent is merging ${name}.`}
        >
          It may stop and ask you a question. Answer it in the conversation
          below. Your {name} folder has not been touched.
        </Header>
      ) : null}

      {state === "ready" ? (
        <Header
          icon={<Icon name="GitMerge" className="size-4" aria-hidden />}
          title={`The agent finished merging ${name}.`}
        >
          Below is what accepting would change in your installed {name}. Nothing
          has been written yet.
        </Header>
      ) : null}

      {state === "failed" ? (
        <Header
          icon={<Icon name="AlertTriangle" className="size-4" aria-hidden />}
          title={`The agent could not merge ${name}.`}
        >
          Nothing was written. Your {name} is exactly as it was, so the two
          choices you had before are still open.
        </Header>
      ) : null}

      {state === "failed" && merge?.error !== null && merge?.error !== undefined ? (
        <p
          role="alert"
          className="rounded-md bg-muted/40 px-2 py-1.5 text-xs text-destructive"
        >
          {merge.error}
        </p>
      ) : null}

      {state === "ready" ? (
        <SkillDiff
          label="The merge, against what you have installed"
          state={diff}
          onRetry={onRetryDiff}
        />
      ) : null}

      {merge?.threadId === null || merge?.threadId === undefined ? null : (
        <div className="space-y-1">
          <h4 className="text-xs font-medium text-muted-foreground">
            {state === "running"
              ? "The agent's thread — reply here"
              : "The agent's thread"}
          </h4>
          <div
            className={`${CHAT_HEIGHT} min-h-0 overflow-hidden rounded-md border border-border`}
          >
            <ThreadChat
              threadId={merge.threadId}
              variant="compact"
              layout="contained"
            />
          </div>
        </div>
      )}

      {state === "running" ? (
        <div className="space-y-1.5">
          <p className="text-xs text-muted-foreground">
            Cancelling asks the agent to stop and throws away what it has
            written so far. Your {name} is untouched either way, so you simply
            get this conflict back to decide again. If the agent cannot be
            stopped you are told, and its thread stays here so you can stop it
            yourself.
          </p>
          <Button
            variant="secondary"
            size="sm"
            onClick={onCancel}
            disabled={busy}
          >
            {busy ? (
              <Icon name="Spinner" className="size-4 animate-spin" aria-hidden />
            ) : null}
            Cancel the merge
          </Button>
        </div>
      ) : null}

      {state === "ready" ? (
        <div className="space-y-1.5">
          <p className="text-xs text-muted-foreground">
            Accepting replaces your installed {name} with the merge. Your
            current version is saved first, and you are told where.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={onAccept} disabled={busy}>
              {busy ? (
                <Icon name="Spinner" className="size-4 animate-spin" aria-hidden />
              ) : null}
              Accept the merge
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={onDiscard}
              disabled={busy}
            >
              Discard it
            </Button>
          </div>
        </div>
      ) : null}

      {state === "failed" ? (
        <Button variant="secondary" size="sm" onClick={onDismissFailure}>
          Keep my version
        </Button>
      ) : null}
    </section>
  );
}

function Header({
  icon,
  title,
  children,
}: {
  icon: ReactNode;
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="flex items-start gap-2">
      <span className="mt-0.5 shrink-0 text-muted-foreground">{icon}</span>
      <div className="min-w-0">
        <p className="text-xs font-medium">{title}</p>
        <p className="text-xs text-muted-foreground">{children}</p>
      </div>
    </div>
  );
}
