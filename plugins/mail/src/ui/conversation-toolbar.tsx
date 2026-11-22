import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import type { MessageAction, MessageHeader, SpecialUse } from "../core/index.ts";
import { tx } from "./i18n/index.ts";
import type { ReadingPaneProps, ReadingAi } from "./reading-pane.tsx";

export const OUTSIDE_AI_ACCESS = "Outside AI access (Mail settings)";

/** The message Hand to agent (and Reply, r, a, f) takes: the newest one open, else the newest. */
export function messageToHand(messages: MessageHeader[], expandedIds: ReadonlySet<string>) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (expandedIds.has(messages[i]!.id)) return messages[i]!;
  }
  return messages.at(-1) ?? null;
}

/** Why Summarize and Find tasks are off for a conversation, or null. */
export function conversationAiReason(messages: readonly MessageHeader[], disabledReason: string | null): string | null {
  if (!messages.some((m) => m.inAiScope)) return OUTSIDE_AI_ACCESS;
  return disabledReason;
}

interface ToolbarAction {
  action: MessageAction;
  label: string;
  icon: string;
}

/**
 * The moves that make sense from a folder: Spam except in Spam, Not spam only
 * there, Archive where the server allows it, Delete except in Trash.
 */
export function actionsFor(use: SpecialUse | null, archiveAllowed: boolean): ToolbarAction[] {
  const actions: ToolbarAction[] = [];
  if (use === "junk") actions.push({ action: "not_spam", label: tx("Not spam"), icon: "SecurityCheck" });
  if (archiveAllowed) {
    actions.push({ action: "archive", label: tx("Archive"), icon: "Archive" });
  }
  if (use !== "junk") actions.push({ action: "spam", label: tx("Spam"), icon: "AlertTriangle" });
  if (use !== "trash") actions.push({ action: "delete", label: tx("Delete"), icon: "Trash2" });
  return actions;
}

type ToolbarProps = Pick<
  ReadingPaneProps,
  | "inbox"
  | "folderUse"
  | "archiveAllowed"
  | "actionPending"
  | "onAction"
  | "onEditDraft"
  | "onCompose"
  | "onMoveTo"
  | "onMarkUnread"
  | "translation"
  | "onLabels"
  | "ai"
  | "bb"
  | "onHandToAgent"
> & {
  messages: readonly MessageHeader[];
  inFolder: boolean;
  handed: MessageHeader | null;
  handedDraft: boolean;
};

export function ConversationToolbar(props: ToolbarProps) {
  const { handed, handedDraft, messages, inFolder, inbox, folderUse, archiveAllowed } = props;
  // Block takes the sender of a received message: not in Sent or Drafts, not a draft.
  const blockable =
    handed !== null &&
    !handedDraft &&
    folderUse !== "sent" &&
    folderUse !== "drafts" &&
    handed.from.address.trim() !== ""
      ? handed
      : null;
  const moves = inFolder ? actionsFor(folderUse, archiveAllowed) : [];
  const moveButton = ({ action, label, icon }: ToolbarAction) => (
    <Button
      key={action}
      variant="ghost"
      size="sm"
      disabled={props.actionPending}
      onClick={() => props.onAction(action)}
    >
      <Icon name={icon} aria-hidden />
      {label}
    </Button>
  );
  return (
    <div
      role="toolbar"
      aria-label={tx("Conversation actions")}
      className="relative flex flex-wrap items-center gap-1 border-b border-border pb-2 [&_button]:h-7 [&_button]:gap-1 [&_button]:px-2"
    >
      {handed !== null && handedDraft ? (
        <Button variant="ghost" size="sm" onClick={() => props.onEditDraft(handed)}>
          <Icon name="Pencil" fallback="Mail" aria-hidden />
          {tx("Edit draft")}
        </Button>
      ) : null}
      {handed !== null && !handedDraft ? (
        <>
          <Button variant="ghost" size="sm" onClick={() => props.onCompose("forward", handed)}>
            <Icon name="Forward" fallback="Send" aria-hidden />
            {tx("Forward")}
          </Button>
        </>
      ) : null}
      {moves.filter(({ action }) => action === "archive").map(moveButton)}
      {inFolder ? (
        <>
          <Button variant="ghost" size="sm" disabled={props.actionPending} onClick={props.onMoveTo}>
            <Icon name="Folder" aria-hidden />
            {tx("Move to\u2026")}
          </Button>
          {inbox !== undefined && folderUse === "inbox" ? (
            <Button variant="ghost" size="sm" disabled={props.actionPending} onClick={inbox.onSnooze}>
              <Icon name="Clock" fallback="Info" aria-hidden />
              {tx("Snooze")}
            </Button>
          ) : null}
        </>
      ) : null}
      <details className="group/actions">
        <summary className="cursor-pointer rounded-md border border-input px-2 py-1 text-xs hover:bg-state-hover focus-visible:ring-1 focus-visible:ring-ring">
          {tx("Message actions")}
        </summary>
        <div className="absolute inset-x-0 z-20 mt-1 flex flex-wrap gap-1 rounded-md border border-border bg-popover p-1">
          {moves.filter(({ action }) => action !== "archive").map(moveButton)}
          {inFolder ? (
            <Button variant="ghost" size="sm" disabled={props.actionPending} onClick={props.onMarkUnread}>
              <Icon name="Mail" aria-hidden />
              {tx("Mark unread")}
            </Button>
          ) : null}
          {handed !== null && !handedDraft && props.translation !== undefined ? (
            // A disabled button shows no tooltip of its own: the wrapper carries the reason.
            <span title={props.translation.disabledReason ?? undefined} className="inline-flex">
              <Button
                variant="ghost"
                size="sm"
                disabled={props.translation.disabledReason !== null}
                aria-description={props.translation.disabledReason ?? undefined}
                onClick={() => props.translation?.onToggle(handed)}
              >
                <Icon name="Languages" fallback="Mail" aria-hidden />
                {props.translation.shown?.messageId === handed.id ? tx("Show original") : tx("Translate")}
              </Button>
            </span>
          ) : null}
          {inFolder && props.onLabels !== undefined ? (
            <Button
              variant="ghost"
              size="sm"
              disabled={props.actionPending}
              aria-keyshortcuts="L"
              onClick={props.onLabels}
            >
              <Icon name="Tag" fallback="Folder" aria-hidden />
              {tx("Labels\u2026")}
            </Button>
          ) : null}
          {inbox !== undefined && blockable !== null ? (
            <Button variant="ghost" size="sm" disabled={props.actionPending} onClick={() => inbox.onBlock(blockable)}>
              <Icon name="Ban" fallback="AlertTriangle" aria-hidden />
              {tx("Block")}
            </Button>
          ) : null}
          {props.ai !== undefined && handed !== null && !handedDraft && props.ai.onRemind !== undefined ? (
            <Button variant="ghost" size="sm" onClick={() => props.ai?.onRemind?.(handed)}>
              <Icon name="Clock" fallback="Info" aria-hidden />
              {tx("Remind me\u2026")}
            </Button>
          ) : null}
        </div>
      </details>
      <div className="flex w-full flex-wrap items-center gap-1 border-t border-border pt-1">
        {props.bb !== undefined && handed !== null && !handedDraft ? (
          <>
            <span title={handed.inAiScope ? undefined : OUTSIDE_AI_ACCESS} className="inline-flex">
              <Button
                variant="ghost"
                size="sm"
                disabled={!handed.inAiScope}
                aria-keyshortcuts="Shift+N"
                onClick={() => props.bb?.onNewThread(handed)}
              >
                <Icon name="MessageSquarePlus" fallback="Bot" aria-hidden />
                {tx("New thread\u2026")}
              </Button>
            </span>
            <Button variant="ghost" size="sm" aria-keyshortcuts="Shift+K" onClick={() => props.bb?.onMakeTask(handed)}>
              <Icon name="ListPlus" fallback="ListChecks" aria-hidden />
              {tx("Make a task\u2026")}
            </Button>
          </>
        ) : null}
        {props.ai !== undefined ? (
          <AiButtons ai={props.ai} reason={conversationAiReason(messages, props.ai.disabledReason)} />
        ) : null}
        {handed !== null ? (
          <span title={handed.inAiScope ? undefined : OUTSIDE_AI_ACCESS} className="inline-flex">
            <Button variant="ghost" size="sm" disabled={!handed.inAiScope} onClick={() => props.onHandToAgent(handed)}>
              <Icon name="Bot" aria-hidden />
              {tx("Hand to agent")}
            </Button>
          </span>
        ) : null}
      </div>
    </div>
  );
}

/** Summarize and Find tasks; off with the reason as the tooltip. */
function AiButtons({ ai, reason }: { ai: ReadingAi; reason: string | null }) {
  return (
    // A disabled button shows no tooltip of its own: the wrapper carries the reason.
    <span title={reason ?? undefined} className="inline-flex">
      <Button
        variant="ghost"
        size="sm"
        disabled={reason !== null}
        aria-description={reason ?? undefined}
        onClick={ai.onSummarize}
      >
        <Icon name="Sparkles" fallback="Bot" aria-hidden />
        {tx("Summarize")}
      </Button>
      <Button
        variant="ghost"
        size="sm"
        disabled={reason !== null}
        aria-description={reason ?? undefined}
        onClick={ai.onFindTasks}
      >
        <Icon name="ListChecks" fallback="Check" aria-hidden />
        {tx("Find tasks")}
      </Button>
    </span>
  );
}
