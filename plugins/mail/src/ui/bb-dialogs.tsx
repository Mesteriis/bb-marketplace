// The page side of the BB integration (slice 3g): the ports app.tsx hands
// in, the reading pane's handlers, and the dialogs they open (New thread,
// Make a task, Save to project, Review the patch). Toasts and navigation go
// through the ports, so src/ui stays host-free.
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import type { ProjectListItem, RuleRunView } from "../core/contract.ts";
import type { MessageHeader, ThreadDetail } from "../core/model.ts";
import { BbThreadDialog, type BbThreadRequest } from "./bb-thread-dialog.tsx";
import { errorText, type BbCall, type CodeRenderers } from "./bb-ports.ts";
import { PatchDialog, type PatchRequest } from "./patch-dialog.tsx";
import type { ReadingBb } from "./reading-pane.tsx";
import { SaveToProjectDialog, type SaveRequest } from "./save-to-project-dialog.tsx";
import { TaskDialog, type TaskRequest } from "./task-dialog.tsx";

/** What app.tsx hands the page for the BB integration. */
export interface MailBbPorts {
  call: BbCall;
  renderers: CodeRenderers;
  /** attachmentFolder as BB has it. */
  attachmentFolder: string;
  /** BB's current project and thread (useBbContext), when Mail runs beside one. */
  context: { projectId: string | null; threadId: string | null };
  /** A toast; `action` adds its button. */
  notify: (text: string, action?: { label: string; run: () => void }) => void;
  notifyError: (text: string) => void;
  onOpenThread: (bbThreadId: string) => void;
  onOpenProject: (projectId: string) => void;
  onEditInComposer: (projectId: string, prompt: string) => void;
  /** Something the open conversation shows changed (links, project). */
  onChanged: () => void;
  /** The Dev view (g n). */
  onOpenDev?: () => void;
  /** devNotifications is on: the list offers Hide dev notifications. */
  devFilter?: boolean;
  /** Rule runs ready to start, capped or failed (the Ready to start strip); absent: no strip. */
  ruleRuns?: readonly RuleRunView[];
  onDismissRun?: (run: RuleRunView) => void;
  onPauseRules?: () => void;
}

export interface BbDialogs {
  reading: ReadingBb | undefined;
  /** Review on a rule run: New thread with the rule's project and template. */
  reviewRun: (run: RuleRunView) => void;
  openThread: (request: BbThreadRequest) => void;
  newThreadFor: (message: MessageHeader) => void;
  makeTaskFor: (message: MessageHeader) => void;
  dialogs: ReactNode;
}

/** The reading pane's BB handlers and the dialogs, for the open conversation. */
export function useBbDialogs(bb: MailBbPorts | undefined, detail: ThreadDetail | null): BbDialogs {
  const [projects, setProjects] = useState<ProjectListItem[] | null>(null);
  const [thread, setThread] = useState<BbThreadRequest | null>(null);
  const [task, setTask] = useState<TaskRequest | null>(null);
  const [save, setSave] = useState<SaveRequest | null>(null);
  const [patch, setPatch] = useState<PatchRequest | null>(null);
  const call = bb?.call;
  const conversationId = detail?.thread.id ?? null;

  // The project names, read once a conversation is open (and again for each one).
  useEffect(() => {
    if (call === undefined || conversationId === null) return;
    let live = true;
    call("projects_list", {}).then(
      ({ projects: found }) => {
        if (live) setProjects(found);
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [call, conversationId]);

  const projectId = detail?.project?.id ?? null;
  const newThreadFor = useCallback(
    (message: MessageHeader) => {
      if (bb === undefined || !message.inAiScope) return;
      setThread({
        messageId: message.id,
        projectId,
        inAiScope: message.inAiScope,
        hasAttachments: message.attachments.some((a) => !a.isInline),
      });
    },
    [bb, projectId],
  );
  const makeTaskFor = useCallback(
    (message: MessageHeader) => {
      if (bb === undefined) return;
      setTask({ messageId: message.id, subject: message.agentSubject, inAiScope: message.inAiScope });
    },
    [bb],
  );

  const reading = useMemo<ReadingBb | undefined>(() => {
    if (bb === undefined || detail === null) return undefined;
    const { accountId, id: threadId } = detail.thread;
    const setProject = async (next: string | null) => {
      await bb.call("conversation_project_set", { accountId, threadId, projectId: next });
    };
    return {
      call: bb.call,
      projects,
      renderers: bb.renderers,
      onNewThread: newThreadFor,
      onMakeTask: makeTaskFor,
      onSetProject: (next) => {
        setProject(next).then(bb.onChanged, (error: unknown) => bb.notifyError(errorText(error, "The project could not be set")));
      },
      onAlways: (choice, target) => {
        bb.call("binding_add", { kind: choice.kind, value: choice.value, projectId: target })
          .then(() => setProject(target))
          .then(() => {
            bb.notify(`Mail for ${choice.value} goes to this project from now on`);
            bb.onChanged();
          })
          .catch((error: unknown) => bb.notifyError(errorText(error, "The rule could not be added")));
      },
      onOpenProject: bb.onOpenProject,
      onOpenThread: bb.onOpenThread,
      onLinkThread: (message, link) => {
        if (!message.inAiScope) return;
        setThread({
          messageId: message.id,
          projectId: link.projectId ?? projectId,
          instruction: `Look at ${link.url}`,
          inAiScope: true,
          hasAttachments: false,
        });
      },
      onSaveAttachments: (message, attachments) =>
        setSave({
          messageId: message.id,
          parts: attachments.map((a) => ({ partId: a.partId, name: a.filename ?? "attachment" })),
          projectId,
        }),
      onReviewPatch: (message) => setPatch({ messageId: message.id, projectId, inAiScope: message.inAiScope }),
      onIncident: (bbThreadId, appended) => {
        bb.notify(appended ? "Added to the incident thread" : "Incident thread started", {
          label: "Open",
          run: () => bb.onOpenThread(bbThreadId),
        });
        bb.onChanged();
      },
    };
  }, [bb, detail, makeTaskFor, newThreadFor, projectId, projects]);

  const dialogs =
    bb === undefined ? null : (
      <>
        <BbThreadDialog
          request={thread}
          call={bb.call}
          onStarted={({ bbThreadId, saved }) => {
            const failed = saved.filter((r) => r.outcome !== "saved").length;
            bb.notify(failed > 0 ? `Thread started; ${failed} ${failed === 1 ? "attachment was" : "attachments were"} not saved` : "Thread started", {
              label: "Open",
              run: () => bb.onOpenThread(bbThreadId),
            });
            bb.onChanged();
            bb.onOpenThread(bbThreadId);
          }}
          onEditInComposer={bb.onEditInComposer}
          onClose={() => setThread(null)}
        />
        <TaskDialog
          request={task}
          call={bb.call}
          onMade={(made, boardName) => {
            bb.notify(made.kind === "taskboard" ? `Task created on ${boardName ?? "Taskboard"}` : "Task kept in Mail's Tasks");
            bb.onChanged();
          }}
          onClose={() => setTask(null)}
        />
        <SaveToProjectDialog
          request={save}
          call={bb.call}
          defaultFolder={bb.attachmentFolder}
          onSaved={(results, name) => {
            const saved = results.filter((r) => r.outcome === "saved");
            if (saved.length > 0) bb.notify(saved.length === 1 ? `Saved to ${name}: ${saved[0]!.path}` : `Saved ${saved.length} files to ${name}`);
            bb.onChanged();
          }}
          onClose={() => setSave(null)}
        />
        <PatchDialog
          request={patch}
          call={bb.call}
          renderers={bb.renderers}
          onSaved={(path, name) => {
            bb.notify(`Saved to ${name}: ${path}`);
            bb.onChanged();
          }}
          onHandedOff={(bbThreadId, environment) => {
            bb.notify(environment === "checkout" ? "An agent applies the patch in your checkout" : "An agent applies the patch in a new worktree", {
              label: "Open",
              run: () => bb.onOpenThread(bbThreadId),
            });
            bb.onChanged();
            bb.onOpenThread(bbThreadId);
          }}
          onClose={() => setPatch(null)}
        />
      </>
    );

  const reviewRun = useCallback(
    (run: RuleRunView) => {
      if (bb === undefined) return;
      bb.call("rules_list", {}).then(
        ({ rules }) => {
          const rule = rules.find((r) => r.id === run.ruleId);
          if (rule === undefined) {
            bb.notifyError("The rule of this run was deleted");
            return;
          }
          setThread({
            messageId: run.messageId,
            projectId: rule.projectId,
            instruction: rule.template,
            ruleRunId: run.id,
            inAiScope: true,
            hasAttachments: false,
          });
        },
        (error: unknown) => bb.notifyError(errorText(error, "The rules could not be read")),
      );
    },
    [bb],
  );

  return { reading, reviewRun, openThread: setThread, newThreadFor, makeTaskFor, dialogs };
}
